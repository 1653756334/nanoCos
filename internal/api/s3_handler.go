package api

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"nanocos/internal/auth"
	"nanocos/internal/store"
)

const s3XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/"

// handleS3Root 处理 /s3 与 /s3/ (ListBuckets)
func (s *Server) handleS3Root(w http.ResponseWriter, r *http.Request) {
	reqID := s.setS3CommonHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeS3Error(w, r, reqID, http.StatusMethodNotAllowed, "MethodNotAllowed", "The specified method is not allowed against this resource.")
		return
	}

	p := auth.FromContext(r.Context())
	if p == nil {
		writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
		return
	}

	buckets, err := s.store.ListBuckets()
	if err != nil {
		writeS3Error(w, r, reqID, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}

	type s3BucketItem struct {
		Name         string `xml:"Name"`
		CreationDate string `xml:"CreationDate"`
	}
	type listAllMyBucketsResult struct {
		XMLName xml.Name `xml:"ListAllMyBucketsResult"`
		XMLNS   string   `xml:"xmlns,attr"`
		Owner   struct {
			ID          string `xml:"ID"`
			DisplayName string `xml:"DisplayName"`
		} `xml:"Owner"`
		Buckets struct {
			Bucket []s3BucketItem `xml:"Bucket"`
		} `xml:"Buckets"`
	}

	res := listAllMyBucketsResult{XMLNS: s3XMLNS}
	res.Owner.ID = "nanocos"
	res.Owner.DisplayName = s.cfg.AdminUser

	for _, b := range buckets {
		if p.CanAccess(b.Name, false) {
			res.Buckets.Bucket = append(res.Buckets.Bucket, s3BucketItem{
				Name:         b.Name,
				CreationDate: b.CreatedAt.UTC().Format(time.RFC3339),
			})
		}
	}
	writeXML(w, http.StatusOK, res)
}

// handleS3Bucket 处理 /s3/{bucket} 桶级操作 (HeadBucket, CreateBucket, DeleteBucket, GetBucketLocation, ListMultipartUploads, ListObjects V1/V2, DeleteObjects)
func (s *Server) handleS3Bucket(w http.ResponseWriter, r *http.Request) {
	reqID := s.setS3CommonHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	bucketName := strings.ToLower(strings.TrimSpace(r.PathValue("bucket")))
	p := auth.FromContext(r.Context())
	q := r.URL.Query()

	switch r.Method {
	case http.MethodHead:
		b, err := s.store.GetBucket(bucketName)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if b.Visibility != "public-read" && !p.CanAccess(bucketName, false) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("x-amz-bucket-region", s.cfg.S3Region)
		w.WriteHeader(http.StatusOK)

	case http.MethodPut:
		_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
		if p == nil || (!p.IsAdmin && (p.AccessKey == nil || p.AccessKey.Permission != "admin" || !p.CanAccess(bucketName, true))) {
			writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
			return
		}
		acl := r.Header.Get("x-amz-acl")
		_, err := s.store.CreateBucket(bucketName, acl, 0, "*")
		if err != nil {
			if errors.Is(err, store.ErrBucketAlreadyExists) {
				writeS3Error(w, r, reqID, http.StatusConflict, "BucketAlreadyOwnedByYou", err.Error())
				return
			}
			writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidBucketName", err.Error())
			return
		}
		w.Header().Set("Location", "/"+bucketName)
		w.WriteHeader(http.StatusOK)

	case http.MethodDelete:
		_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
		if p == nil || (!p.IsAdmin && (p.AccessKey == nil || p.AccessKey.Permission != "admin" || !p.CanAccess(bucketName, true))) {
			writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
			return
		}
		if err := s.store.DeleteBucket(bucketName, false); err != nil {
			if errors.Is(err, store.ErrBucketNotFound) {
				writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchBucket", err.Error())
				return
			}
			if errors.Is(err, store.ErrBucketNotEmpty) {
				writeS3Error(w, r, reqID, http.StatusConflict, "BucketNotEmpty", err.Error())
				return
			}
			writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidRequest", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case http.MethodPost:
		// 批量删除 DeleteObjects (?delete)
		if _, hasDelete := q["delete"]; hasDelete {
			if !p.CanAccess(bucketName, true) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
			defer func() { _, _ = io.Copy(io.Discard, r.Body) }()

			var delReq struct {
				Objects []struct {
					Key string `xml:"Key"`
				} `xml:"Object"`
			}
			if err := xml.NewDecoder(r.Body).Decode(&delReq); err != nil {
				writeS3Error(w, r, reqID, http.StatusBadRequest, "MalformedXML", err.Error())
				return
			}
			type deletedEntry struct {
				Key string `xml:"Key"`
			}
			type errorEntry struct {
				Key     string `xml:"Key"`
				Code    string `xml:"Code"`
				Message string `xml:"Message"`
			}
			type deleteResult struct {
				XMLName xml.Name       `xml:"DeleteResult"`
				XMLNS   string         `xml:"xmlns,attr"`
				Deleted []deletedEntry `xml:"Deleted,omitempty"`
				Errors  []errorEntry   `xml:"Error,omitempty"`
			}
			recursive := strings.EqualFold(strings.TrimSpace(r.Header.Get("x-cos-recursive")), "true")
			res := deleteResult{XMLNS: s3XMLNS}
			for _, item := range delReq.Objects {
				_, delErr := s.store.DeleteObjectWithMode(bucketName, item.Key, recursive)
				if delErr != nil && !errors.Is(delErr, store.ErrObjectNotFound) {
					res.Errors = append(res.Errors, errorEntry{
						Key:     item.Key,
						Code:    "InternalError",
						Message: delErr.Error(),
					})
				} else {
					res.Deleted = append(res.Deleted, deletedEntry{Key: item.Key})
				}
			}
			writeXML(w, http.StatusOK, res)
			return
		}
		writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidRequest", "Unsupported POST action on bucket")

	case http.MethodGet:
		b, err := s.store.GetBucket(bucketName)
		if err != nil {
			writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchBucket", "The specified bucket does not exist")
			return
		}
		if b.Visibility != "public-read" && !p.CanAccess(bucketName, false) {
			writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
			return
		}

		// ?location 查询存储桶区域
		if _, hasLoc := q["location"]; hasLoc {
			type locationConstraint struct {
				XMLName  xml.Name `xml:"LocationConstraint"`
				XMLNS    string   `xml:"xmlns,attr"`
				Location string   `xml:",chardata"`
			}
			writeXML(w, http.StatusOK, locationConstraint{
				XMLNS:    s3XMLNS,
				Location: s.cfg.S3Region,
			})
			return
		}

		// ?uploads 列出进行中的分片上传会话 (ListMultipartUploads，兼容 rclone / aws-cli)
		if _, hasUploads := q["uploads"]; hasUploads {
			uploads, err := s.store.ListMultipartUploads(bucketName, q.Get("prefix"))
			if err != nil {
				writeS3Error(w, r, reqID, http.StatusInternalServerError, "InternalError", err.Error())
				return
			}
			type uploadEntry struct {
				Key       string `xml:"Key"`
				UploadId  string `xml:"UploadId"`
				Initiated string `xml:"Initiated"`
			}
			type listMultipartUploadsResult struct {
				XMLName            xml.Name      `xml:"ListMultipartUploadsResult"`
				XMLNS              string        `xml:"xmlns,attr"`
				Bucket             string        `xml:"Bucket"`
				Prefix             string        `xml:"Prefix"`
				MaxUploads         int           `xml:"MaxUploads"`
				IsTruncated        bool          `xml:"IsTruncated"`
				Uploads            []uploadEntry `xml:"Upload"`
			}
			res := listMultipartUploadsResult{
				XMLNS:      s3XMLNS,
				Bucket:     bucketName,
				Prefix:     q.Get("prefix"),
				MaxUploads: 1000,
			}
			for _, u := range uploads {
				res.Uploads = append(res.Uploads, uploadEntry{
					Key:       u.Key,
					UploadId:  u.UploadID,
					Initiated: u.CreatedAt.UTC().Format(time.RFC3339),
				})
			}
			writeXML(w, http.StatusOK, res)
			return
		}

		prefix := q.Get("prefix")
		delimiter := q.Get("delimiter")
		encodingType := strings.ToLower(strings.TrimSpace(q.Get("encoding-type")))
		urlEncode := encodingType == "url"

		maxKeys, _ := strconv.Atoi(q.Get("max-keys"))
		if maxKeys <= 0 {
			maxKeys = 1000
		}
		marker := q.Get("marker")
		startAfter := q.Get("start-after")
		if startAfter == "" {
			startAfter = q.Get("continuation-token")
		}
		if startAfter == "" {
			startAfter = marker
		}

		listRes, err := s.store.ListObjectsS3(bucketName, prefix, delimiter, maxKeys, startAfter)
		if err != nil {
			writeS3Error(w, r, reqID, http.StatusInternalServerError, "InternalError", err.Error())
			return
		}

		encodeField := func(val string) string {
			if urlEncode && val != "" {
				return url.QueryEscape(val)
			}
			return val
		}

		type s3Content struct {
			Key          string `xml:"Key"`
			LastModified string `xml:"LastModified"`
			ETag         string `xml:"ETag"`
			Size         int64  `xml:"Size"`
			StorageClass string `xml:"StorageClass"`
		}
		type s3Prefix struct {
			Prefix string `xml:"Prefix"`
		}
		type listBucketResult struct {
			XMLName               xml.Name    `xml:"ListBucketResult"`
			XMLNS                 string      `xml:"xmlns,attr"`
			Name                  string      `xml:"Name"`
			Prefix                string      `xml:"Prefix"`
			Marker                string      `xml:"Marker,omitempty"`
			NextMarker            string      `xml:"NextMarker,omitempty"`
			Delimiter             string      `xml:"Delimiter,omitempty"`
			MaxKeys               int         `xml:"MaxKeys"`
			KeyCount              int         `xml:"KeyCount"`
			EncodingType          string      `xml:"EncodingType,omitempty"`
			IsTruncated           bool        `xml:"IsTruncated"`
			NextContinuationToken string      `xml:"NextContinuationToken,omitempty"`
			Contents              []s3Content `xml:"Contents"`
			CommonPrefixes        []s3Prefix  `xml:"CommonPrefixes"`
		}

		nextMarker := ""
		if listRes.IsTruncated {
			nextMarker = encodeField(listRes.NextToken)
		}

		out := listBucketResult{
			XMLNS:                 s3XMLNS,
			Name:                  bucketName,
			Prefix:                encodeField(prefix),
			Marker:                encodeField(marker),
			NextMarker:            nextMarker,
			Delimiter:             encodeField(delimiter),
			MaxKeys:               maxKeys,
			IsTruncated:           listRes.IsTruncated,
			NextContinuationToken: nextMarker,
		}
		if urlEncode {
			out.EncodingType = "url"
		}
		for _, obj := range listRes.Objects {
			out.Contents = append(out.Contents, s3Content{
				Key:          encodeField(obj.Key),
				LastModified: obj.UpdatedAt.UTC().Format(time.RFC3339),
				ETag:         fmt.Sprintf(`"%s"`, obj.ETag),
				Size:         obj.SizeBytes,
				StorageClass: "STANDARD",
			})
		}
		for _, cp := range listRes.CommonPrefixes {
			out.CommonPrefixes = append(out.CommonPrefixes, s3Prefix{Prefix: encodeField(cp)})
		}
		out.KeyCount = len(out.Contents) + len(out.CommonPrefixes)
		writeXML(w, http.StatusOK, out)

	default:
		writeS3Error(w, r, reqID, http.StatusMethodNotAllowed, "MethodNotAllowed", "Method Not Allowed")
	}
}

// handleS3Object 处理 /s3/{bucket}/{key...} 对象级与分片级操作
func (s *Server) handleS3Object(w http.ResponseWriter, r *http.Request) {
	reqID := s.setS3CommonHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	bucketName := strings.ToLower(strings.TrimSpace(r.PathValue("bucket")))
	rawKey := r.PathValue("key")
	if rawKey == "" {
		s.handleS3Bucket(w, r)
		return
	}

	b, err := s.store.GetBucket(bucketName)
	if err != nil {
		writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchBucket", "The specified bucket does not exist")
		return
	}

	p := auth.FromContext(r.Context())
	q := r.URL.Query()

	// 1. S3 Multipart Upload 相关操作 (?uploads 或 ?uploadId=...)
	if _, isInitUploads := q["uploads"]; isInitUploads && r.Method == http.MethodPost {
		_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
		if !p.CanAccess(bucketName, true) {
			writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
			return
		}
		u, err := s.store.InitiateMultipartUpload(bucketName, rawKey, r.Header.Get("Content-Type"), extractCustomMetaHeaders(r.Header))
		if err != nil {
			writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidRequest", err.Error())
			return
		}
		type initMultipartResult struct {
			XMLName  xml.Name `xml:"InitiateMultipartUploadResult"`
			XMLNS    string   `xml:"xmlns,attr"`
			Bucket   string   `xml:"Bucket"`
			Key      string   `xml:"Key"`
			UploadId string   `xml:"UploadId"`
		}
		writeXML(w, http.StatusOK, initMultipartResult{
			XMLNS:    s3XMLNS,
			Bucket:   bucketName,
			Key:      u.Key,
			UploadId: u.UploadID,
		})
		return
	}

	if uploadID := q.Get("uploadId"); uploadID != "" {
		switch r.Method {
		case http.MethodPut:
			if !p.CanAccess(bucketName, true) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
				return
			}
			partNum, err := strconv.Atoi(q.Get("partNumber"))
			if err != nil {
				writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidPart", "Invalid partNumber")
				return
			}
			bodyReader, writeOpts, err := s.prepareUploadStream(r)
			if err != nil {
				writeS3UploadError(w, r, reqID, err)
				return
			}
			part, err := s.store.UploadPartScoped(bucketName, rawKey, uploadID, partNum, bodyReader, writeOpts)
			if err != nil {
				if errors.Is(err, store.ErrMultipartNotFound) {
					writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchUpload", err.Error())
					return
				}
				writeS3UploadError(w, r, reqID, err)
				return
			}
			w.Header().Set("ETag", fmt.Sprintf(`"%s"`, part.ETag))
			w.WriteHeader(http.StatusOK)

		case http.MethodPost:
			if !p.CanAccess(bucketName, true) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
				return
			}
			// 解析并校验 S3 CompleteMultipartUpload XML 中的 Part 列表与 ETag
			r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
			defer func() { _, _ = io.Copy(io.Discard, r.Body) }()

			var completeReq struct {
				Parts []struct {
					PartNumber int    `xml:"PartNumber"`
					ETag       string `xml:"ETag"`
				} `xml:"Part"`
			}
			if r.ContentLength != 0 {
				if decErr := xml.NewDecoder(r.Body).Decode(&completeReq); decErr != nil && !errors.Is(decErr, io.EOF) {
					writeS3Error(w, r, reqID, http.StatusBadRequest, "MalformedXML", decErr.Error())
					return
				}
			}
			var partSpecs []store.CompletePartSpec
			for _, pt := range completeReq.Parts {
				partSpecs = append(partSpecs, store.CompletePartSpec{
					PartNumber: pt.PartNumber,
					ETag:       pt.ETag,
				})
			}

			obj, err := s.store.CompleteMultipartUploadScoped(bucketName, rawKey, uploadID, partSpecs)
			if err != nil {
				switch {
				case errors.Is(err, store.ErrMultipartNotFound):
					writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchUpload", err.Error())
				case errors.Is(err, store.ErrInvalidPartOrder):
					writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidPartOrder", err.Error())
				case errors.Is(err, store.ErrInvalidPartETag):
					writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidPart", err.Error())
				default:
					writeS3UploadError(w, r, reqID, err)
				}
				return
			}
			type completeMultipartResult struct {
				XMLName  xml.Name `xml:"CompleteMultipartUploadResult"`
				XMLNS    string   `xml:"xmlns,attr"`
				Location string   `xml:"Location"`
				Bucket   string   `xml:"Bucket"`
				Key      string   `xml:"Key"`
				ETag     string   `xml:"ETag"`
			}
			writeXML(w, http.StatusOK, completeMultipartResult{
				XMLNS:    s3XMLNS,
				Location: s.buildObjectRawURL(r, bucketName, obj.Key),
				Bucket:   bucketName,
				Key:      obj.Key,
				ETag:     fmt.Sprintf(`"%s"`, obj.ETag),
			})

		case http.MethodDelete:
			_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
			if !p.CanAccess(bucketName, true) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
				return
			}
			if err := s.store.AbortMultipartUploadScoped(bucketName, rawKey, uploadID); err != nil {
				if errors.Is(err, store.ErrMultipartNotFound) {
					writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchUpload", err.Error())
					return
				}
				writeS3Error(w, r, reqID, http.StatusInternalServerError, "InternalError", err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)

		case http.MethodGet:
			if !p.CanAccess(bucketName, false) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
				return
			}
			u, err := s.store.GetMultipartUploadScoped(bucketName, rawKey, uploadID)
			if err != nil {
				writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchUpload", err.Error())
				return
			}
			type s3PartItem struct {
				PartNumber   int    `xml:"PartNumber"`
				LastModified string `xml:"LastModified"`
				ETag         string `xml:"ETag"`
				Size         int64  `xml:"Size"`
			}
			type listPartsResult struct {
				XMLName  xml.Name     `xml:"ListPartsResult"`
				XMLNS    string       `xml:"xmlns,attr"`
				Bucket   string       `xml:"Bucket"`
				Key      string       `xml:"Key"`
				UploadId string       `xml:"UploadId"`
				Parts    []s3PartItem `xml:"Part"`
			}
			res := listPartsResult{
				XMLNS:    s3XMLNS,
				Bucket:   bucketName,
				Key:      u.Key,
				UploadId: u.UploadID,
			}
			for _, pt := range u.Parts {
				res.Parts = append(res.Parts, s3PartItem{
					PartNumber:   pt.PartNumber,
					LastModified: pt.UploadedAt.UTC().Format(time.RFC3339),
					ETag:         fmt.Sprintf(`"%s"`, pt.ETag),
					Size:         pt.SizeBytes,
				})
			}
			writeXML(w, http.StatusOK, res)
		}
		return
	}

	// 2. 标准 S3 对象操作 (GET / HEAD / PUT / DELETE)
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		if b.Visibility != "public-read" && !p.CanAccess(bucketName, false) {
			if presignedP, ok := s.auth.VerifyPresignedQuery(r, bucketName, rawKey); !ok || !presignedP.CanAccess(bucketName, false) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
				return
			}
		}
		obj, err := s.store.GetObject(bucketName, rawKey)
		if err != nil || obj.IsFolder {
			writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchKey", "The specified key does not exist.")
			return
		}
		// 直接复用已查到的 obj，消除重复 GetObject 查询
		s.serveResolvedObject(w, r, b, obj)

	case http.MethodPut:
		if !p.CanAccess(bucketName, true) {
			if presignedP, ok := s.auth.VerifyPresignedQuery(r, bucketName, rawKey); !ok || !presignedP.CanAccess(bucketName, true) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
				return
			}
		}

		// 检查是否为 CopyObject (x-amz-copy-source)
		if copySrc := strings.TrimSpace(r.Header.Get("x-amz-copy-source")); copySrc != "" {
			_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
			if unescaped, err := url.PathUnescape(copySrc); err == nil {
				copySrc = unescaped
			}
			copySrc = strings.TrimLeft(copySrc, "/")
			idx := strings.Index(copySrc, "/")
			if idx <= 0 {
				writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidArgument", "Invalid x-amz-copy-source")
				return
			}
			srcBucket, srcKey := copySrc[:idx], copySrc[idx+1:]
			if !p.CanAccess(srcBucket, false) {
				writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied on source bucket")
				return
			}
			obj, err := s.store.CopyObject(srcBucket, srcKey, bucketName, rawKey)
			if err != nil {
				if errors.Is(err, store.ErrObjectNotFound) {
					writeS3Error(w, r, reqID, http.StatusNotFound, "NoSuchKey", err.Error())
					return
				}
				writeS3UploadError(w, r, reqID, err)
				return
			}
			// 支持 x-amz-metadata-directive: REPLACE 替换目标对象的 Content-Type 与自定义元数据
			if strings.EqualFold(strings.TrimSpace(r.Header.Get("x-amz-metadata-directive")), "REPLACE") && !obj.IsFolder {
				newCT := store.ResolveContentType(obj.Key, r.Header.Get("Content-Type"), obj.ContentType)
				newMeta := extractCustomMetaHeaders(r.Header)
				if updatedObj, uErr := s.store.SaveBlobObject(bucketName, obj.Key, obj.BlobSHA256, obj.ETag, obj.SizeBytes, newCT, newMeta); uErr == nil {
					obj = updatedObj
				}
			}

			type copyObjectResult struct {
				XMLName      xml.Name `xml:"CopyObjectResult"`
				XMLNS        string   `xml:"xmlns,attr"`
				LastModified string   `xml:"LastModified"`
				ETag         string   `xml:"ETag"`
			}
			writeXML(w, http.StatusOK, copyObjectResult{
				XMLNS:        s3XMLNS,
				LastModified: obj.UpdatedAt.UTC().Format(time.RFC3339),
				ETag:         fmt.Sprintf(`"%s"`, obj.ETag),
			})
			return
		}

		// 检查是否为空文件夹创建请求 (兼容 Content-Length=0)
		if strings.HasSuffix(rawKey, "/") && r.ContentLength == 0 {
			_, _ = io.Copy(io.Discard, r.Body)
			if _, err := s.store.CreateFolder(bucketName, rawKey); err != nil {
				writeS3Error(w, r, reqID, http.StatusBadRequest, "InvalidRequest", err.Error())
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}

		bodyReader, writeOpts, err := s.prepareUploadStream(r)
		if err != nil {
			writeS3UploadError(w, r, reqID, err)
			return
		}

		obj, err := s.store.PutObjectFromStreamWithOptions(bucketName, rawKey, bodyReader, r.Header.Get("Content-Type"), extractCustomMetaHeaders(r.Header), writeOpts)
		if err != nil {
			writeS3UploadError(w, r, reqID, err)
			return
		}
		if obj.ETag != "" {
			w.Header().Set("ETag", fmt.Sprintf(`"%s"`, obj.ETag))
		}
		if len(obj.BlobSHA256) == 64 {
			if rawSum, decErr := hex.DecodeString(obj.BlobSHA256); decErr == nil {
				w.Header().Set("x-amz-checksum-sha256", base64.StdEncoding.EncodeToString(rawSum))
			}
		}
		w.WriteHeader(http.StatusOK)

	case http.MethodDelete:
		_, _ = io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, maxJSONBodyBytes))
		if !p.CanAccess(bucketName, true) {
			writeS3Error(w, r, reqID, http.StatusForbidden, "AccessDenied", "Access Denied")
			return
		}
		recursive := strings.EqualFold(strings.TrimSpace(r.Header.Get("x-cos-recursive")), "true")
		if _, err := s.store.DeleteObjectWithMode(bucketName, rawKey, recursive); err != nil && !errors.Is(err, store.ErrObjectNotFound) {
			writeS3Error(w, r, reqID, http.StatusInternalServerError, "InternalError", err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		writeS3Error(w, r, reqID, http.StatusMethodNotAllowed, "MethodNotAllowed", "Method Not Allowed")
	}
}

func (s *Server) setS3CommonHeaders(w http.ResponseWriter) string {
	reqID := strconv.FormatInt(time.Now().UnixNano(), 16)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Expose-Headers", "ETag, x-amz-request-id, Content-Length, Content-Range")
	w.Header().Set("x-amz-request-id", reqID)
	w.Header().Set("Server", "NanoCOS")
	return reqID
}

func writeS3UploadError(w http.ResponseWriter, r *http.Request, reqID string, err error) {
	status, code, msg := mapStoreError(err)
	writeS3Error(w, r, reqID, status, code, msg)
}

func writeXML(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(xml.Header))
	enc := xml.NewEncoder(w)
	_ = enc.Encode(v)
}

func writeS3Error(w http.ResponseWriter, r *http.Request, reqID string, status int, code, message string) {
	type s3ErrorXML struct {
		XMLName   xml.Name `xml:"Error"`
		Code      string   `xml:"Code"`
		Message   string   `xml:"Message"`
		Resource  string   `xml:"Resource"`
		RequestId string   `xml:"RequestId"`
	}
	resPath := "/"
	if r != nil && r.URL != nil {
		resPath = r.URL.Path
	}
	writeXML(w, status, s3ErrorXML{
		Code:      code,
		Message:   message,
		Resource:  resPath,
		RequestId: reqID,
	})
}
