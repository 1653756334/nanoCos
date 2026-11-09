package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"nanocos/internal/auth"
	"nanocos/internal/store"
)

// handleBrowseObjects GET /api/v1/buckets/{bucket}/objects
func (s *Server) handleBrowseObjects(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, false); !ok {
		return
	}

	q := r.URL.Query()
	prefix := q.Get("prefix")
	search := q.Get("search")
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
	sortBy := q.Get("sortBy")
	sortOrder := q.Get("sortOrder")

	listing, err := s.store.BrowseDirectorySorted(bucketName, prefix, search, limit, offset, sortBy, sortOrder)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusOK, listing)
}

// handleCreateFolder POST /api/v1/buckets/{bucket}/folders
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, true); !ok {
		return
	}

	var req struct {
		Key string `json:"key"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}

	folder, err := s.store.CreateFolder(bucketName, req.Key)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"folder": folder})
}

// handleFastUpload POST /api/v1/buckets/{bucket}/fast-upload
func (s *Server) handleFastUpload(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	p, ok := s.requireBucketAccess(w, r, bucketName, true)
	if !ok {
		return
	}

	var req struct {
		Key         string            `json:"key"`
		SHA256      string            `json:"sha256"`
		ContentType string            `json:"contentType"`
		CustomMeta  map[string]string `json:"customMeta"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}

	canReadAll := p.IsAdmin || (p.AccessKey != nil && strings.TrimSpace(p.AccessKey.AllowedBuckets) == "*")
	var allowedBuckets []string
	if !canReadAll && p.AccessKey != nil {
		for _, item := range strings.Split(p.AccessKey.AllowedBuckets, ",") {
			if trimmed := strings.TrimSpace(item); trimmed != "" {
				allowedBuckets = append(allowedBuckets, trimmed)
			}
		}
	}

	obj, hit, err := s.store.TryFastUploadScoped(bucketName, req.Key, req.SHA256, req.ContentType, req.CustomMeta, canReadAll, allowedBuckets)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	if !hit {
		writeJSON(w, http.StatusOK, map[string]any{"fastUploaded": false})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"fastUploaded": true,
		"object":       obj,
		"url":          s.buildObjectRawURL(r, bucketName, obj.Key),
	})
}

// handlePutObjectStream PUT /api/v1/buckets/{bucket}/objects/{key...}
func (s *Server) handlePutObjectStream(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	rawKey := r.PathValue("key")
	p := auth.FromContext(r.Context())
	if !p.CanAccess(bucketName, true) {
		if presignedP, ok := s.auth.VerifyPresignedQuery(r, bucketName, rawKey); !ok || !presignedP.CanAccess(bucketName, true) {
			writeJSONError(w, http.StatusForbidden, "无权上传至该存储桶")
			return
		}
	}

	bodyReader, writeOpts, err := s.prepareUploadStream(r)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}

	obj, err := s.store.PutObjectFromStreamWithOptions(bucketName, rawKey, bodyReader, r.Header.Get("Content-Type"), extractCustomMetaHeaders(r.Header), writeOpts)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"object": obj,
		"url":    s.buildObjectRawURL(r, bucketName, obj.Key),
	})
}

// handleFormUpload POST /api/v1/buckets/{bucket}/upload
func (s *Server) handleFormUpload(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, true); !ok {
		return
	}

	maxUploadBytes := s.cfg.MaxUploadBytes()
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	mr, err := r.MultipartReader()
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "必须为 multipart/form-data 请求")
		return
	}

	var prefix string
	var customKey string
	var uploaded []*store.Object

	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "读取表单分片流异常中断: "+err.Error())
			return
		}

		formName := part.FormName()
		if formName == "prefix" {
			data, readErr := io.ReadAll(io.LimitReader(part, 8192))
			_ = part.Close()
			if readErr != nil {
				writeJSONError(w, http.StatusBadRequest, "读取 prefix 字段失败")
				return
			}
			prefix = strings.TrimSpace(string(data))
			continue
		}
		if formName == "key" {
			data, readErr := io.ReadAll(io.LimitReader(part, 8192))
			_ = part.Close()
			if readErr != nil {
				writeJSONError(w, http.StatusBadRequest, "读取 key 字段失败")
				return
			}
			customKey = strings.TrimSpace(string(data))
			continue
		}
		if part.FileName() != "" {
			targetKey := customKey
			customKey = ""
			if targetKey == "" {
				if prefix != "" {
					targetKey = strings.TrimSuffix(prefix, "/") + "/" + part.FileName()
				} else {
					targetKey = part.FileName()
				}
			}
			obj, putErr := s.store.PutObjectFromStreamWithOptions(
				bucketName,
				targetKey,
				part,
				part.Header.Get("Content-Type"),
				nil,
				store.WriteOptions{MaxBytes: maxUploadBytes},
			)
			_ = part.Close()
			if putErr != nil {
				writeUploadStoreErrorJSON(w, putErr)
				return
			}
			uploaded = append(uploaded, obj)
		} else {
			_ = part.Close()
		}
	}

	if uploaded == nil {
		uploaded = []*store.Object{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"uploaded": uploaded,
	})
}

// handleCopyObject POST /api/v1/buckets/{bucket}/copy
func (s *Server) handleCopyObject(w http.ResponseWriter, r *http.Request) {
	srcBucket := r.PathValue("bucket")
	var req struct {
		SrcKey       string `json:"srcKey"`
		DstBucket    string `json:"dstBucket"`
		DstKey       string `json:"dstKey"`
		DeleteSource bool   `json:"deleteSource"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}
	if req.DstBucket == "" {
		req.DstBucket = srcBucket
	}

	p := auth.FromContext(r.Context())
	if !p.CanAccess(srcBucket, req.DeleteSource) || !p.CanAccess(req.DstBucket, true) {
		writeJSONError(w, http.StatusForbidden, "权限不足")
		return
	}

	obj, err := s.store.CopyObject(srcBucket, req.SrcKey, req.DstBucket, req.DstKey)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}

	normSrcKey, _ := store.NormalizeObjectKey(req.SrcKey, obj.IsFolder)
	if req.DeleteSource && (!strings.EqualFold(srcBucket, req.DstBucket) || normSrcKey != obj.Key) {
		if _, delErr := s.store.DeleteObject(srcBucket, normSrcKey); delErr != nil {
			writeUploadStoreErrorJSON(w, delErr)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"object": obj,
		"url":    s.buildObjectRawURL(r, req.DstBucket, obj.Key),
	})
}

// handleDeleteObject DELETE /api/v1/buckets/{bucket}/objects
func (s *Server) handleDeleteObject(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, true); !ok {
		return
	}

	rawKey := r.PathValue("key")
	if rawKey == "" {
		rawKey = r.URL.Query().Get("key")
	}
	if rawKey == "" {
		writeJSONError(w, http.StatusBadRequest, "请提供要删除的 key 参数")
		return
	}

	deleted, err := s.store.DeleteObject(bucketName, rawKey)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"deletedCount": deleted,
	})
}

// handlePresignURL POST /api/v1/buckets/{bucket}/presign
func (s *Server) handlePresignURL(w http.ResponseWriter, r *http.Request) {
	bucketName := strings.ToLower(strings.TrimSpace(r.PathValue("bucket")))
	var req struct {
		Key          string `json:"key"`
		Method       string `json:"method"`       // "GET" | "PUT" | "HEAD"
		ExpiresInSec int64  `json:"expiresInSec"` // 默认 3600
		Download     bool   `json:"download"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}
	if req.Method == "" {
		req.Method = "GET"
	}
	req.Method = strings.ToUpper(strings.TrimSpace(req.Method))
	if req.Method != "GET" && req.Method != "PUT" && req.Method != "HEAD" {
		writeJSONError(w, http.StatusBadRequest, "预签名仅支持 GET、HEAD 或 PUT 方法")
		return
	}

	b, err := s.store.GetBucket(bucketName)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "存储桶不存在")
		return
	}

	p, ok := s.requireBucketAccess(w, r, bucketName, req.Method == "PUT")
	if !ok {
		return
	}

	if b.Visibility == "public-read" && (req.Method == "GET" || req.Method == "HEAD") {
		writeJSONError(w, http.StatusBadRequest, "公开只读桶的文件天然支持永久直链访问，无需签发 GET 临时分享链接（公开桶仅支持签发 PUT 临时上传链接）")
		return
	}

	akID := "ADMIN"
	if !p.IsAdmin && p.AccessKey != nil {
		akID = p.AccessKey.AccessKey
	}

	normKey, err := store.NormalizeObjectKey(req.Key, false)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	isDownload := req.Download && req.Method != "PUT"
	queryStr, expUnix, err := s.auth.GeneratePresignedQuery(req.Method, bucketName, normKey, req.ExpiresInSec, akID, isDownload)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	rawURL := s.buildObjectRawURL(r, bucketName, normKey) + "?" + queryStr

	writeJSON(w, http.StatusOK, map[string]any{
		"url":       rawURL,
		"method":    req.Method,
		"expiresAt": time.Unix(expUnix, 0).UTC(),
	})
}

// --- 分片上传控制器 (Multipart Upload，强制绑定并校验 bucketName) ---

// handleMultipartInit POST /api/v1/buckets/{bucket}/multipart/init
func (s *Server) handleMultipartInit(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, true); !ok {
		return
	}

	var req struct {
		Key         string            `json:"key"`
		ContentType string            `json:"contentType"`
		CustomMeta  map[string]string `json:"customMeta"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}

	u, err := s.store.InitiateMultipartUpload(bucketName, req.Key, req.ContentType, req.CustomMeta)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

// handleMultipartStatus GET /api/v1/buckets/{bucket}/multipart/{uploadId}
func (s *Server) handleMultipartStatus(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, false); !ok {
		return
	}

	uploadID := r.PathValue("uploadId")
	u, err := s.store.GetMultipartUploadScoped(bucketName, "", uploadID)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// handleMultipartUploadPart PUT /api/v1/buckets/{bucket}/multipart/{uploadId}/{partNumber}
func (s *Server) handleMultipartUploadPart(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, true); !ok {
		return
	}

	uploadID := r.PathValue("uploadId")
	partNum, err := strconv.Atoi(r.PathValue("partNumber"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 partNumber")
		return
	}

	bodyReader, writeOpts, err := s.prepareUploadStream(r)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}

	part, err := s.store.UploadPartScoped(bucketName, "", uploadID, partNum, bodyReader, writeOpts)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	w.Header().Set("ETag", fmt.Sprintf(`"%s"`, part.ETag))
	writeJSON(w, http.StatusOK, part)
}

// handleMultipartComplete POST /api/v1/buckets/{bucket}/multipart/{uploadId}/complete
func (s *Server) handleMultipartComplete(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, true); !ok {
		return
	}

	var req struct {
		Parts []store.CompletePartSpec `json:"parts"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSONBody(w, r, &req); err != nil && !errors.Is(err, io.EOF) {
			writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体: "+err.Error())
			return
		}
	} else {
		_, _ = io.Copy(io.Discard, r.Body)
	}

	uploadID := r.PathValue("uploadId")
	obj, err := s.store.CompleteMultipartUploadScoped(bucketName, "", uploadID, req.Parts)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"object": obj,
		"url":    s.buildObjectRawURL(r, bucketName, obj.Key),
	})
}

// handleMultipartAbort DELETE /api/v1/buckets/{bucket}/multipart/{uploadId}
func (s *Server) handleMultipartAbort(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if _, ok := s.requireBucketAccess(w, r, bucketName, true); !ok {
		return
	}

	uploadID := r.PathValue("uploadId")
	if err := s.store.AbortMultipartUploadScoped(bucketName, "", uploadID); err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
