package api

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"nanocos/internal/auth"
	"nanocos/internal/store"
)

var errUnsupportedStreamingPayload = errors.New("不支持的 S3 STREAMING 负载编码格式")

func resolveCORSOrigin(corsConfig, reqOrigin string) (string, bool) {
	corsConfig = strings.TrimSpace(corsConfig)
	if corsConfig == "" || corsConfig == "*" {
		return "*", false
	}
	parts := strings.Split(corsConfig, ",")
	var allowed []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			allowed = append(allowed, p)
		}
	}
	if len(allowed) == 0 {
		return "*", false
	}
	reqOrigin = strings.TrimSpace(reqOrigin)
	if reqOrigin != "" {
		for _, a := range allowed {
			if a == "*" || strings.EqualFold(a, reqOrigin) {
				return reqOrigin, true
			}
		}
	}
	return allowed[0], len(allowed) > 1
}

// handleRaw 处理 /raw/{bucket}/{key...} 直链下载、流媒体 Range 播放与预签名 PUT 直传
func (s *Server) handleRaw(w http.ResponseWriter, r *http.Request) {
	bucketName := strings.ToLower(strings.TrimSpace(r.PathValue("bucket")))
	rawKey := r.PathValue("key")
	if bucketName == "" || rawKey == "" {
		writeJSONError(w, http.StatusBadRequest, "缺少 bucket 或 key 路径参数")
		return
	}

	b, err := s.store.GetBucket(bucketName)
	if err != nil {
		if errors.Is(err, store.ErrBucketNotFound) {
			writeJSONError(w, http.StatusNotFound, "存储桶不存在")
			return
		}
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 设置桶级 CORS 响应头（支持逗号分隔的多域名匹配）
	allowOrigin, varyOrigin := resolveCORSOrigin(b.CORSOrigins, r.Header.Get("Origin"))
	w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
	if varyOrigin {
		w.Header().Add("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range, If-None-Match, If-Modified-Since, Content-Type, Content-MD5, X-Amz-Content-Sha256, Authorization, X-Cos-Access-Key, X-Cos-Secret-Key")
	w.Header().Set("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Cos-Sha256")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// 支持预签名 URL 或已授权客户端直接 PUT 上传到 /raw/{bucket}/{key...}
	if r.Method == http.MethodPut {
		principal := auth.FromContext(r.Context())
		if !principal.CanAccess(bucketName, true) {
			if p, ok := s.auth.VerifyPresignedQuery(r, bucketName, rawKey); ok && p.CanAccess(bucketName, true) {
				principal = p
			} else {
				writeJSONError(w, http.StatusForbidden, "无权上传至该存储桶或预签名链接已失效")
				return
			}
		}

		bodyReader, writeOpts, err := s.prepareUploadStream(r)
		if err != nil {
			if errors.Is(err, errUnsupportedStreamingPayload) {
				writeJSONError(w, http.StatusNotImplemented, err.Error())
				return
			}
			writeUploadStoreErrorJSON(w, err)
			return
		}

		obj, err := s.store.PutObjectFromStreamWithOptions(bucketName, rawKey, bodyReader, r.Header.Get("Content-Type"), extractCustomMetaHeaders(r.Header), writeOpts)
		if err != nil {
			writeUploadStoreErrorJSON(w, err)
			return
		}
		w.Header().Set("ETag", fmt.Sprintf(`"%s"`, obj.ETag))
		writeJSON(w, http.StatusOK, map[string]any{
			"object": obj,
			"url":    s.buildObjectRawURL(r, bucketName, obj.Key),
		})
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSONError(w, http.StatusMethodNotAllowed, "不支持的请求方法")
		return
	}

	// 权限校验：公开读桶直接放行；私有桶要求请求头认证通过或 Query 预签名校验通过
	if b.Visibility != "public-read" {
		principal := auth.FromContext(r.Context())
		if !principal.CanAccess(bucketName, false) {
			if p, ok := s.auth.VerifyPresignedQuery(r, bucketName, rawKey); !ok || !p.CanAccess(bucketName, false) {
				writeJSONError(w, http.StatusForbidden, "该存储桶为私有空间，需要有效签名或访问凭证")
				return
			}
		}
	}

	s.serveObjectContent(w, r, b, rawKey)
}

// serveObjectContent 查询对象并委托 serveResolvedObject 响应内容
func (s *Server) serveObjectContent(w http.ResponseWriter, r *http.Request, b *store.Bucket, rawKey string) {
	obj, err := s.store.GetObject(b.Name, rawKey)
	if err != nil || obj.IsFolder {
		writeJSONError(w, http.StatusNotFound, "文件对象不存在")
		return
	}
	s.serveResolvedObject(w, r, b, obj)
}

// serveResolvedObject 直接复用已查询出的 Object 提供底层 CAS 物理块零拷贝读取、自定义元数据头、XSS 防护头、ETag 304 与 HTTP Range 206 响应
func (s *Server) serveResolvedObject(w http.ResponseWriter, r *http.Request, b *store.Bucket, obj *store.Object) {
	etagHeader := fmt.Sprintf(`"%s"`, obj.ETag)
	w.Header().Set("ETag", etagHeader)
	w.Header().Set("Content-Type", obj.ContentType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("X-Cos-Sha256", obj.BlobSHA256)
	if len(obj.BlobSHA256) == 64 {
		if rawSum, err := hex.DecodeString(obj.BlobSHA256); err == nil && len(rawSum) == sha256.Size {
			w.Header().Set("x-amz-checksum-sha256", base64.StdEncoding.EncodeToString(rawSum))
		}
	}

	// 回写用户上传时持久化的 x-amz-meta-* 自定义元数据响应头
	for k, v := range obj.CustomMeta {
		cleanKey := strings.ToLower(strings.TrimSpace(k))
		if cleanKey != "" && !strings.ContainsAny(cleanKey, "\r\n: ") && !strings.ContainsAny(v, "\r\n") {
			w.Header().Set("x-amz-meta-"+cleanKey, v)
		}
	}

	// 安全加固 (P0-3)：防 MIME 嗅探 + 严格 CSP 沙箱隔离，彻底阻断同源存储型 XSS 执行脚本或访问后台 Cookie/API
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")

	if b.Visibility == "public-read" {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=3600")
	}

	safeFilename := sanitizeDispositionFilename(obj.Name)
	escapedName := url.PathEscape(obj.Name)
	forceAttachment := isDangerousInlineContentType(obj.ContentType) ||
		r.URL.Query().Get("download") == "1" ||
		r.URL.Query().Get("download") == "true"

	if forceAttachment {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, safeFilename, escapedName))
	} else if disp := sanitizeContentDispositionParam(r.URL.Query().Get("response-content-disposition")); disp != "" {
		w.Header().Set("Content-Disposition", disp)
	} else {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s"; filename*=UTF-8''%s`, safeFilename, escapedName))
	}

	// 若客户端带了 If-None-Match 且匹配，提前短路可免去一次磁盘 Open
	if match := strings.TrimSpace(r.Header.Get("If-None-Match")); match != "" && (match == etagHeader || match == obj.ETag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	blobFile, err := s.store.CAS().OpenBlob(obj.BlobSHA256)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "底层物理块读取失败")
		return
	}
	defer blobFile.Close()

	// Go 标准库 http.ServeContent 原生支持 HTTP Range (206 Partial Content)、多段 Range 及 sendfile 零拷贝
	http.ServeContent(w, r, obj.Name, obj.UpdatedAt, blobFile)
}

func isDangerousInlineContentType(ct string) bool {
	lower := strings.ToLower(strings.TrimSpace(ct))
	if idx := strings.Index(lower, ";"); idx >= 0 {
		lower = strings.TrimSpace(lower[:idx])
	}
	switch lower {
	case "text/html",
		"application/xhtml+xml",
		"image/svg+xml",
		"text/xml",
		"application/xml",
		"application/javascript",
		"text/javascript",
		"application/x-javascript",
		"text/ecmascript",
		"application/x-shockwave-flash":
		return true
	default:
		return false
	}
}

func sanitizeDispositionFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r == '"' || r == '\\' || r == '\r' || r == '\n' || r < 0x20 {
			b.WriteByte('_')
		} else {
			b.WriteRune(r)
		}
	}
	res := b.String()
	if res == "" {
		return "download"
	}
	return res
}

func sanitizeContentDispositionParam(disp string) string {
	disp = strings.TrimSpace(disp)
	if disp == "" || strings.ContainsAny(disp, "\r\n") {
		return ""
	}
	return disp
}

// prepareUploadStream 解析上传请求头中的大小限制、完整性声明（X-Amz-Content-Sha256、x-amz-checksum-sha256、Content-MD5）及 aws-chunked 流式分帧编码
func (s *Server) prepareUploadStream(r *http.Request) (io.Reader, store.WriteOptions, error) {
	maxBytes := s.cfg.MaxUploadBytes()
	opts := store.WriteOptions{
		MaxBytes:       maxBytes,
		ExpectedMD5:    strings.TrimSpace(r.Header.Get("Content-MD5")),
		ExpectedSHA256: strings.TrimSpace(r.Header.Get("X-Amz-Content-Sha256")),
	}
	if opts.ExpectedSHA256 == "" {
		opts.ExpectedSHA256 = strings.TrimSpace(r.Header.Get("X-Cos-Sha256"))
	}

	// 支持 S3 x-amz-checksum-sha256 请求头（Base64 编码的 32 字节 SHA-256 摘要）
	var headerChecksumHex string
	if chkB64 := strings.TrimSpace(r.Header.Get("X-Amz-Checksum-Sha256")); chkB64 != "" {
		rawChk, err := base64.StdEncoding.DecodeString(chkB64)
		if err != nil || len(rawChk) != sha256.Size {
			return nil, opts, store.ErrHashMismatch
		}
		headerChecksumHex = hex.EncodeToString(rawChk)
	}

	// 请求头 Content-Length 预检：若声明长度已超过全局单次上传上限，无需落盘直接 413 拒绝
	if r.ContentLength > maxBytes {
		return nil, opts, store.ErrPayloadTooLarge
	}

	upperSHA := strings.ToUpper(opts.ExpectedSHA256)
	bodyReader := io.Reader(r.Body)

	// 处理 AWS SDK / CLI 的 STREAMING-AWS4-HMAC-SHA256-PAYLOAD (aws-chunked 分帧流)
	if strings.HasPrefix(upperSHA, "STREAMING-") {
		switch upperSHA {
		case "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
			"STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER",
			"STREAMING-UNSIGNED-PAYLOAD-TRAILER":
			var expectedDecodedLen int64 = -1
			if decLenStr := strings.TrimSpace(r.Header.Get("X-Amz-Decoded-Content-Length")); decLenStr != "" {
				parsedLen, err := strconv.ParseInt(decLenStr, 10, 64)
				if err != nil || parsedLen < 0 {
					return nil, opts, errors.New("非法的 X-Amz-Decoded-Content-Length 请求头")
				}
				if parsedLen > maxBytes {
					return nil, opts, store.ErrPayloadTooLarge
				}
				expectedDecodedLen = parsedLen
			}
			var streamAuth *auth.S3StreamAuth
			if upperSHA != "STREAMING-UNSIGNED-PAYLOAD-TRAILER" {
				if p := auth.FromContext(r.Context()); p != nil {
					streamAuth = p.S3StreamAuth
				}
			}
			bodyReader = newAWSChunkedReader(r.Body, expectedDecodedLen, streamAuth)
			opts.ExpectedSHA256 = headerChecksumHex
		default:
			return nil, opts, errUnsupportedStreamingPayload
		}
	} else if opts.ExpectedSHA256 != "" && !strings.EqualFold(opts.ExpectedSHA256, "UNSIGNED-PAYLOAD") {
		if len(opts.ExpectedSHA256) != 64 {
			return nil, opts, store.ErrHashMismatch
		}
		if headerChecksumHex != "" && !strings.EqualFold(opts.ExpectedSHA256, headerChecksumHex) {
			return nil, opts, store.ErrHashMismatch
		}
	} else if headerChecksumHex != "" {
		opts.ExpectedSHA256 = headerChecksumHex
	}

	return bodyReader, opts, nil
}

// awsChunkedReader 解码 AWS S3 aws-chunked 流式分帧格式，支持逐块校验 SigV4 chunk-signature、X-Amz-Decoded-Content-Length 与尾部 x-amz-checksum-sha256
type awsChunkedReader struct {
	br           *bufio.Reader
	chunkRem     int64
	decodedBytes int64
	expectedLen  int64
	hasher       hash.Hash
	streamAuth   *auth.S3StreamAuth
	prevSig      string
	curChunkSig  string
	chunkHasher  hash.Hash
	needCRLF     bool
	eof          bool
}

func newAWSChunkedReader(r io.Reader, expectedDecodedLen int64, streamAuth *auth.S3StreamAuth) io.Reader {
	prevSig := ""
	if streamAuth != nil {
		prevSig = streamAuth.SeedSignature
	}
	return &awsChunkedReader{
		br:          bufio.NewReaderSize(r, 64*1024),
		expectedLen: expectedDecodedLen,
		hasher:      sha256.New(),
		streamAuth:  streamAuth,
		prevSig:     prevSig,
	}
}

func (a *awsChunkedReader) verifyCurrentChunkSignature() error {
	if a.streamAuth == nil || a.chunkHasher == nil {
		return nil
	}
	if len(a.curChunkSig) != 64 {
		return fmt.Errorf("%w: aws-chunked 缺少有效的 64 位 chunk-signature", store.ErrHashMismatch)
	}
	chunkSumHex := hex.EncodeToString(a.chunkHasher.Sum(nil))
	expectedSig := auth.ComputeS3ChunkSignature(
		a.streamAuth.SigningKey,
		a.streamAuth.AmzDate,
		a.streamAuth.Scope,
		a.prevSig,
		chunkSumHex,
	)
	if !strings.EqualFold(expectedSig, a.curChunkSig) {
		return fmt.Errorf("%w: aws-chunked 分块签名校验失败", store.ErrHashMismatch)
	}
	a.prevSig = strings.ToLower(a.curChunkSig)
	return nil
}

func (a *awsChunkedReader) Read(p []byte) (int, error) {
	if a.eof {
		return 0, io.EOF
	}

	for a.chunkRem == 0 {
		if a.needCRLF {
			if err := a.verifyCurrentChunkSignature(); err != nil {
				return 0, err
			}
			if err := a.consumeCRLF(); err != nil {
				return 0, err
			}
			a.needCRLF = false
		}
		line, err := a.br.ReadString('\n')
		if err != nil {
			return 0, fmt.Errorf("解析 aws-chunked 帧头失败: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		sizePart := line
		a.curChunkSig = ""
		if semi := strings.IndexByte(line, ';'); semi >= 0 {
			sizePart = line[:semi]
			ext := line[semi+1:]
			for _, field := range strings.Split(ext, ";") {
				field = strings.TrimSpace(field)
				if strings.HasPrefix(strings.ToLower(field), "chunk-signature=") {
					a.curChunkSig = strings.TrimSpace(field[len("chunk-signature="):])
				}
			}
		}
		size, err := strconv.ParseInt(strings.TrimSpace(sizePart), 16, 64)
		if err != nil || size < 0 {
			return 0, fmt.Errorf("非法的 aws-chunked 块大小: %q", line)
		}
		a.chunkHasher = sha256.New()
		if size == 0 {
			if err := a.verifyCurrentChunkSignature(); err != nil {
				return 0, err
			}
			a.eof = true
			// 消费尾部空行或 trailer headers，并校验可选的 x-amz-checksum-sha256
			for {
				tLine, tErr := a.br.ReadString('\n')
				trimmed := strings.TrimRight(tLine, "\r\n")
				if trimmed != "" {
					if colon := strings.IndexByte(trimmed, ':'); colon > 0 {
						tKey := strings.ToLower(strings.TrimSpace(trimmed[:colon]))
						tVal := strings.TrimSpace(trimmed[colon+1:])
						if tKey == "x-amz-checksum-sha256" && tVal != "" {
							actualB64 := base64.StdEncoding.EncodeToString(a.hasher.Sum(nil))
							if actualB64 != tVal {
								return 0, store.ErrHashMismatch
							}
						}
					}
				}
				if tErr != nil || trimmed == "" {
					break
				}
			}
			if a.expectedLen >= 0 && a.decodedBytes != a.expectedLen {
				return 0, fmt.Errorf("%w: aws-chunked 实际解码长度 (%d) 与 X-Amz-Decoded-Content-Length (%d) 不一致", store.ErrHashMismatch, a.decodedBytes, a.expectedLen)
			}
			return 0, io.EOF
		}
		a.chunkRem = size
		a.needCRLF = true
	}

	toRead := int64(len(p))
	if toRead > a.chunkRem {
		toRead = a.chunkRem
	}
	n, err := a.br.Read(p[:toRead])
	if n > 0 {
		a.chunkRem -= int64(n)
		a.decodedBytes += int64(n)
		_, _ = a.hasher.Write(p[:n])
		if a.chunkHasher != nil {
			_, _ = a.chunkHasher.Write(p[:n])
		}
	}
	if err == io.EOF && a.chunkRem > 0 {
		return n, io.ErrUnexpectedEOF
	}
	return n, err
}

func (a *awsChunkedReader) consumeCRLF() error {
	b1, err := a.br.ReadByte()
	if err != nil {
		return err
	}
	if b1 == '\r' {
		b2, err := a.br.ReadByte()
		if err != nil {
			return err
		}
		if b2 != '\n' {
			return errors.New("aws-chunked 缺少块尾 LF")
		}
		return nil
	}
	if b1 == '\n' {
		return nil
	}
	return errors.New("aws-chunked 缺少块尾 CRLF")
}

func writeUploadStoreErrorJSON(w http.ResponseWriter, err error) {
	status, code, msg := mapStoreError(err)
	writeJSONCodeError(w, status, code, msg)
}
