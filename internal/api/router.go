package api

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"nanocos/internal/auth"
	"nanocos/internal/config"
	"nanocos/internal/store"
	"nanocos/internal/web"
)

// Server 聚合 HTTP 路由、配置、存储引擎与鉴权服务
type Server struct {
	cfg                     *config.Config
	store                   *store.Store
	auth                    *auth.AuthService
	httpRequestsTotal       atomic.Uint64
	httpErrorsTotal         atomic.Uint64
	httpBytesWrittenTotal   atomic.Uint64
	httpDurationMicrosTotal atomic.Uint64
}

// NewServer 创建服务端实例
func NewServer(cfg *config.Config, st *store.Store, authSvc *auth.AuthService) *Server {
	return &Server{
		cfg:   cfg,
		store: st,
		auth:  authSvc,
	}
}

// Handler 构建完整的 HTTP 路由树与中间件管道
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// 0. 运维健康检查、就绪探针与 Prometheus 指标 (/healthz, /readyz, /metrics)
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("HEAD /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("HEAD /readyz", s.handleReadyz)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("HEAD /metrics", s.handleMetrics)

	// 1. 现代 REST API (/api/v1/*)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/v1/auth/me", s.handleMe)
	mux.HandleFunc("PUT /api/v1/auth/account", s.handleUpdateAdminAccount)
	mux.HandleFunc("GET /api/v1/stats", s.handleStats)

	// Buckets
	mux.HandleFunc("GET /api/v1/buckets", s.handleListBuckets)
	mux.HandleFunc("POST /api/v1/buckets", s.handleCreateBucket)
	mux.HandleFunc("PUT /api/v1/buckets/{bucket}", s.handleUpdateBucket)
	mux.HandleFunc("DELETE /api/v1/buckets/{bucket}", s.handleDeleteBucket)

	// Objects & Folders
	mux.HandleFunc("GET /api/v1/buckets/{bucket}/objects", s.handleBrowseObjects)
	mux.HandleFunc("POST /api/v1/buckets/{bucket}/folders", s.handleCreateFolder)
	mux.HandleFunc("POST /api/v1/buckets/{bucket}/fast-upload", s.handleFastUpload)
	mux.HandleFunc("PUT /api/v1/buckets/{bucket}/objects/{key...}", s.handlePutObjectStream)
	mux.HandleFunc("POST /api/v1/buckets/{bucket}/upload", s.handleFormUpload)
	mux.HandleFunc("POST /api/v1/buckets/{bucket}/copy", s.handleCopyObject)
	mux.HandleFunc("DELETE /api/v1/buckets/{bucket}/objects", s.handleDeleteObject)
	mux.HandleFunc("DELETE /api/v1/buckets/{bucket}/objects/{key...}", s.handleDeleteObject)
	mux.HandleFunc("POST /api/v1/buckets/{bucket}/presign", s.handlePresignURL)

	// Multipart Uploads
	mux.HandleFunc("POST /api/v1/buckets/{bucket}/multipart/init", s.handleMultipartInit)
	mux.HandleFunc("GET /api/v1/buckets/{bucket}/multipart/{uploadId}", s.handleMultipartStatus)
	mux.HandleFunc("PUT /api/v1/buckets/{bucket}/multipart/{uploadId}/{partNumber}", s.handleMultipartUploadPart)
	mux.HandleFunc("POST /api/v1/buckets/{bucket}/multipart/{uploadId}/complete", s.handleMultipartComplete)
	mux.HandleFunc("DELETE /api/v1/buckets/{bucket}/multipart/{uploadId}", s.handleMultipartAbort)

	// Access Keys & Maintenance
	mux.HandleFunc("GET /api/v1/access-keys", s.handleListAccessKeys)
	mux.HandleFunc("POST /api/v1/access-keys", s.handleCreateAccessKey)
	mux.HandleFunc("POST /api/v1/access-keys/{ak}/reveal", s.handleRevealAccessKey)
	mux.HandleFunc("DELETE /api/v1/access-keys/{ak}", s.handleDeleteAccessKey)
	mux.HandleFunc("POST /api/v1/admin/scrub", s.handleAdminScrub)
	mux.HandleFunc("POST /api/v1/admin/gc", s.handleAdminGC)
	mux.HandleFunc("POST /api/v1/admin/backup", s.handleAdminBackup)

	// 2. 高速直链与流媒体网关 (/raw/{bucket}/{key...})
	mux.HandleFunc("/raw/{bucket}/{key...}", s.handleRaw)

	// 3. AWS S3 兼容协议层 (/s3/*)
	mux.HandleFunc("/s3", s.handleS3Root)
	mux.HandleFunc("/s3/{$}", s.handleS3Root)
	mux.HandleFunc("/s3/{bucket}", s.handleS3Bucket)
	mux.HandleFunc("/s3/{bucket}/{key...}", s.handleS3Object)

	// 4. 内嵌 Web 管理控制台静态文件服务 (支持 Vite React SPA 路由回退、/assets/* immutable 缓存与透明 Gzip 压缩)
	distFS, err := fs.Sub(web.EmbeddedDist, "dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(distFS))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 拦截未命中的 /api/* 与 /raw/* 路径，防止落入 SPA 兜底返回 200 index.html (P1-13)
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			writeJSONError(w, http.StatusNotFound, "API 接口路由或请求方法不存在")
			return
		}
		if r.URL.Path == "/raw" || strings.HasPrefix(r.URL.Path, "/raw/") {
			writeJSONError(w, http.StatusNotFound, "直链路径不完整，格式应为 /raw/{bucket}/{key}")
			return
		}

		// 智能协议嗅探：支持 Virtual-Host 风格 (<bucket>.host) 或 Path-Style 根路径 S3 客户端请求
		if vhostBucket := s.extractVirtualHostBucket(r); vhostBucket != "" {
			s.dispatchVirtualHostS3(w, r, vhostBucket)
			return
		}
		if isRootS3Request(r) {
			s.dispatchRootS3(w, r)
			return
		}

		cleanPath := strings.TrimPrefix(r.URL.Path, "/")
		if cleanPath != "" {
			if _, statErr := fs.Stat(distFS, cleanPath); statErr != nil {
				// SPA 路由回退至 index.html
				r.URL.Path = "/"
				cleanPath = ""
			}
		}

		if strings.HasPrefix(cleanPath, "assets/") {
			serveEmbeddedAssetWithGzip(w, r, distFS, cleanPath)
			return
		}
		if cleanPath == "" {
			if _, statErr := fs.Stat(distFS, "index.html"); statErr != nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("<!DOCTYPE html><html><head><title>NanoCOS</title></head><body><div id=\"root\"></div><!-- NanoCOS Console (build web assets with pnpm run build) --></body></html>"))
				return
			}
		}
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})

	return s.recoverMiddleware(s.loggingMiddleware(s.auth.Middleware(mux)))
}

// serveEmbeddedAssetWithGzip 为前端带哈希指纹的 /assets/* 静态资源添加 1 年 immutable 强缓存与透明 Gzip 压缩
func serveEmbeddedAssetWithGzip(w http.ResponseWriter, r *http.Request, distFS fs.FS, cleanPath string) {
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Add("Vary", "Accept-Encoding")

	if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || r.Header.Get("Range") != "" {
		http.FileServer(http.FS(distFS)).ServeHTTP(w, r)
		return
	}

	data, err := fs.ReadFile(distFS, cleanPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(cleanPath))
	switch ext {
	case ".js", ".mjs":
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	case ".css":
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	default:
		if ct := mime.TypeByExtension(ext); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	gz := gzip.NewWriter(w)
	_, _ = gz.Write(data)
	_ = gz.Close()
}

// handleHealthz GET /healthz 存活探针 (Liveness Probe)
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	ver := "v1.1.0"
	if s.cfg != nil && s.cfg.Version != "" {
		ver = s.cfg.Version
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"version":       ver,
		"uptimeSeconds": s.store.UptimeSeconds(),
	})
}

// handleReadyz GET /readyz 就绪探针 (Readiness Probe: 检查 SQLite 读写、CAS 存储目录状态与后台对账状态)
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if err := s.store.PingHealth(); err != nil {
		writeJSONCodeError(w, http.StatusServiceUnavailable, "ServiceUnavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "ready",
		"reconciling": s.store.IsReconciling(),
	})
}

// handleMetrics GET /metrics 输出标准 Prometheus 文本格式监控指标
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.GetSystemStats()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	reconcilingVal := 0
	if s.store.IsReconciling() {
		reconcilingVal = 1
	}
	reqs := s.httpRequestsTotal.Load()
	errs := s.httpErrorsTotal.Load()
	bytesOut := s.httpBytesWrittenTotal.Load()
	durSec := float64(s.httpDurationMicrosTotal.Load()) / 1e6

	var b strings.Builder
	fmt.Fprintf(&b, "# HELP nanocos_up Whether the NanoCOS server is up (1 = healthy).\n# TYPE nanocos_up gauge\nnanocos_up 1\n")
	fmt.Fprintf(&b, "# HELP nanocos_uptime_seconds Server uptime in seconds.\n# TYPE nanocos_uptime_seconds counter\nnanocos_uptime_seconds %d\n", stats.UptimeSeconds)
	fmt.Fprintf(&b, "# HELP nanocos_reconciling Whether background CAS reconciliation/GC is currently running.\n# TYPE nanocos_reconciling gauge\nnanocos_reconciling %d\n", reconcilingVal)
	fmt.Fprintf(&b, "# HELP nanocos_buckets_total Total number of storage buckets.\n# TYPE nanocos_buckets_total gauge\nnanocos_buckets_total %d\n", stats.BucketCount)
	fmt.Fprintf(&b, "# HELP nanocos_objects_total Total number of logical file objects.\n# TYPE nanocos_objects_total gauge\nnanocos_objects_total %d\n", stats.ObjectCount)
	fmt.Fprintf(&b, "# HELP nanocos_folders_total Total number of folder markers.\n# TYPE nanocos_folders_total gauge\nnanocos_folders_total %d\n", stats.FolderCount)
	fmt.Fprintf(&b, "# HELP nanocos_blobs_total Total number of unique physical CAS blobs.\n# TYPE nanocos_blobs_total gauge\nnanocos_blobs_total %d\n", stats.BlobCount)
	fmt.Fprintf(&b, "# HELP nanocos_logical_bytes Total logical storage size in bytes.\n# TYPE nanocos_logical_bytes gauge\nnanocos_logical_bytes %d\n", stats.LogicalBytes)
	fmt.Fprintf(&b, "# HELP nanocos_physical_bytes Total physical disk usage of CAS blobs in bytes.\n# TYPE nanocos_physical_bytes gauge\nnanocos_physical_bytes %d\n", stats.PhysicalBytes)
	fmt.Fprintf(&b, "# HELP nanocos_saved_bytes Bytes saved via SHA-256 CAS deduplication.\n# TYPE nanocos_saved_bytes gauge\nnanocos_saved_bytes %d\n", stats.SavedBytes)
	fmt.Fprintf(&b, "# HELP nanocos_dedup_ratio_percent Deduplication savings ratio in percent.\n# TYPE nanocos_dedup_ratio_percent gauge\nnanocos_dedup_ratio_percent %.2f\n", stats.DedupRatioPercent)
	fmt.Fprintf(&b, "# HELP nanocos_multipart_active_total Active multipart upload sessions.\n# TYPE nanocos_multipart_active_total gauge\nnanocos_multipart_active_total %d\n", stats.MultipartActiveCount)
	fmt.Fprintf(&b, "# HELP nanocos_access_keys_total Total configured AccessKeys.\n# TYPE nanocos_access_keys_total gauge\nnanocos_access_keys_total %d\n", stats.AccessKeyCount)
	fmt.Fprintf(&b, "# HELP nanocos_http_requests_total Total HTTP requests processed.\n# TYPE nanocos_http_requests_total counter\nnanocos_http_requests_total %d\n", reqs)
	fmt.Fprintf(&b, "# HELP nanocos_http_errors_total Total HTTP 5xx responses.\n# TYPE nanocos_http_errors_total counter\nnanocos_http_errors_total %d\n", errs)
	fmt.Fprintf(&b, "# HELP nanocos_http_response_bytes_total Total HTTP response bytes written.\n# TYPE nanocos_http_response_bytes_total counter\nnanocos_http_response_bytes_total %d\n", bytesOut)
	fmt.Fprintf(&b, "# HELP nanocos_http_request_duration_seconds_sum Total time spent serving HTTP requests in seconds.\n# TYPE nanocos_http_request_duration_seconds_sum counter\nnanocos_http_request_duration_seconds_sum %.6f\n", durSec)
	fmt.Fprintf(&b, "# HELP nanocos_http_request_duration_seconds_count Total HTTP requests timed.\n# TYPE nanocos_http_request_duration_seconds_count counter\nnanocos_http_request_duration_seconds_count %d\n", reqs)

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(b.String()))
	}
}

func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("HTTP handler panic recovered", "panic", rec, "path", r.URL.Path)
				writeJSONError(w, http.StatusInternalServerError, "服务器内部错误")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// handleAdminScrub POST /api/v1/admin/scrub 触发底层 CAS 物理块 SHA-256 完整性校验
func (s *Server) handleAdminScrub(w http.ResponseWriter, r *http.Request) {
	if !s.requireGlobalAdmin(w, r) {
		return
	}
	checked, corrupted, err := s.store.ScrubBlobs()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if corrupted == nil {
		corrupted = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"checked":   checked,
		"corrupted": corrupted,
		"healthy":   len(corrupted) == 0,
	})
}

// handleAdminGC POST /api/v1/admin/gc 触发元数据对账与孤儿物理块回收
func (s *Server) handleAdminGC(w http.ResponseWriter, r *http.Request) {
	if !s.requireGlobalAdmin(w, r) {
		return
	}
	if err := s.store.ReconcileAndGC(24 * time.Hour); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAdminBackup POST /api/v1/admin/backup 触发基于 SQLite VACUUM INTO 的一致性在线热备份
func (s *Server) handleAdminBackup(w http.ResponseWriter, r *http.Request) {
	if !s.requireGlobalAdmin(w, r) {
		return
	}
	var req struct {
		TargetDir string `json:"targetDir"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSONBody(w, r, &req); err != nil && !errors.Is(err, io.EOF) {
			writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
			return
		}
	}
	targetDir := strings.TrimSpace(req.TargetDir)
	if targetDir == "" {
		targetDir = filepath.Join(s.cfg.DataDir, "backups", time.Now().UTC().Format("20060102-150405"))
	}
	dbSnap, copiedBlobs, err := s.store.BackupToDir(targetDir)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"backupDir":   targetDir,
		"dbSnapshot":  dbSnap,
		"copiedBlobs": copiedBlobs,
	})
}

// isRootS3Request 判断根路径请求是否来自 S3 客户端（包含 AWS 签名头或查询参数）
func isRootS3Request(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/raw/") || strings.HasPrefix(r.URL.Path, "/s3") {
		return false
	}
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "AWS4-HMAC-SHA256") || strings.HasPrefix(authHeader, "AWS ") {
		return true
	}
	q := r.URL.Query()
	if r.Header.Get("X-Amz-Date") != "" || q.Get("X-Amz-Algorithm") != "" || q.Get("AWSAccessKeyId") != "" {
		return true
	}
	return false
}

// extractVirtualHostBucket 识别 Virtual-Host 风格 S3 请求 (如 mybucket.localhost:9000)
func (s *Server) extractVirtualHostBucket(r *http.Request) string {
	if !isRootS3Request(r) {
		return ""
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" || host == "localhost" || net.ParseIP(host) != nil {
		return ""
	}
	idx := strings.IndexByte(host, '.')
	if idx <= 0 {
		return ""
	}
	sub := host[:idx]
	if store.ValidateBucketName(sub) != nil {
		return ""
	}
	if _, err := s.store.GetBucket(sub); err == nil {
		return sub
	}
	// 当桶尚未存在时（如 Virtual-Host 风格下的 CreateBucket / HeadBucket / PutObject）：
	// 1. 根路径 "/" 上的非 GET 请求（Path-Style 根路径仅支持 GET ListBuckets，因此 PUT/HEAD/DELETE/POST "/" 必然是 Virtual-Host 桶操作）
	if (r.URL.Path == "" || r.URL.Path == "/") && r.Method != http.MethodGet {
		return sub
	}
	// 2. Host 明确属于 *.localhost、*.s3.* 或配置了 PublicURL 的子域名 (<bucket>.<publicHost>)
	restHost := host[idx+1:]
	if restHost == "localhost" || strings.HasPrefix(restHost, "s3.") || strings.Contains(restHost, ".s3.") {
		return sub
	}
	if s.cfg != nil && s.cfg.PublicURL != "" {
		if u, err := url.Parse(s.cfg.PublicURL); err == nil && u.Hostname() != "" {
			if strings.EqualFold(restHost, u.Hostname()) {
				return sub
			}
		}
	}
	return ""
}

func (s *Server) dispatchVirtualHostS3(w http.ResponseWriter, r *http.Request, bucket string) {
	r.SetPathValue("bucket", bucket)
	key := strings.TrimPrefix(r.URL.Path, "/")
	if key == "" {
		s.handleS3Bucket(w, r)
		return
	}
	r.SetPathValue("key", key)
	s.handleS3Object(w, r)
}

// dispatchRootS3 将根路径的 S3 请求提取出 bucket 和 key 后委托给 S3 控制器
func (s *Server) dispatchRootS3(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/")
	if trimmed == "" {
		s.handleS3Root(w, r)
		return
	}
	idx := strings.Index(trimmed, "/")
	if idx == -1 {
		r.SetPathValue("bucket", trimmed)
		s.handleS3Bucket(w, r)
		return
	}
	bucket := trimmed[:idx]
	key := trimmed[idx+1:]
	r.SetPathValue("bucket", bucket)
	if key == "" {
		s.handleS3Bucket(w, r)
		return
	}
	r.SetPathValue("key", key)
	s.handleS3Object(w, r)
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = strconv.FormatInt(start.UnixNano(), 36)
		}
		w.Header().Set("X-Request-Id", reqID)

		rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)

		elapsed := time.Since(start)
		s.httpRequestsTotal.Add(1)
		if rw.status >= 500 {
			s.httpErrorsTotal.Add(1)
		}
		if rw.bytesWritten > 0 {
			s.httpBytesWrittenTotal.Add(uint64(rw.bytesWritten))
		}
		s.httpDurationMicrosTotal.Add(uint64(elapsed.Microseconds()))

		if !strings.HasPrefix(r.URL.Path, "/assets/") {
			slog.Info("HTTP",
				"req_id", reqID,
				"client_ip", s.extractClientIP(r),
				"method", r.Method,
				"path", r.URL.Path,
				"status", rw.status,
				"bytes", rw.bytesWritten,
				"duration", elapsed.Round(time.Microsecond).String(),
			)
		}
	})
}

// statusRecorder 包装 ResponseWriter，同时实现 io.ReaderFrom、http.Flusher 与 Unwrap 以保持 sendfile 零拷贝快路径
type statusRecorder struct {
	http.ResponseWriter
	status       int
	wroteHeader  bool
	bytesWritten int64
}

func (r *statusRecorder) WriteHeader(code int) {
	if r.wroteHeader {
		return
	}
	r.status = code
	r.wroteHeader = true
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytesWritten += int64(n)
	return n, err
}

func (r *statusRecorder) ReadFrom(src io.Reader) (int64, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	if rf, ok := r.ResponseWriter.(io.ReaderFrom); ok {
		n, err := rf.ReadFrom(src)
		r.bytesWritten += n
		return n, err
	}
	n, err := io.Copy(r.ResponseWriter, src)
	r.bytesWritten += n
	return n, err
}

func (r *statusRecorder) Flush() {
	if fl, ok := r.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func defaultErrorCode(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "InvalidRequest"
	case http.StatusUnauthorized:
		return "Unauthorized"
	case http.StatusForbidden:
		return "AccessDenied"
	case http.StatusNotFound:
		return "NotFound"
	case http.StatusMethodNotAllowed:
		return "MethodNotAllowed"
	case http.StatusConflict:
		return "Conflict"
	case http.StatusRequestEntityTooLarge:
		return "EntityTooLarge"
	case http.StatusTooManyRequests:
		return "SlowDown"
	case http.StatusNotImplemented:
		return "NotImplemented"
	case http.StatusServiceUnavailable:
		return "ServiceUnavailable"
	case http.StatusInsufficientStorage:
		return "QuotaExceeded"
	default:
		return "InternalError"
	}
}

func writeJSONCodeError(w http.ResponseWriter, status int, code, message string) {
	if code == "" {
		code = defaultErrorCode(status)
	}
	writeJSON(w, status, map[string]any{
		"code":  code,
		"error": message,
	})
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSONCodeError(w, status, defaultErrorCode(status), message)
}

// mapStoreError 将底层 store 错误统一映射为 (HTTP状态码, S3/REST错误码, 错误描述)，消除多处重复判定
func mapStoreError(err error) (status int, code string, message string) {
	if err == nil {
		return http.StatusOK, "", ""
	}
	msg := err.Error()
	switch {
	case errors.Is(err, store.ErrQuotaExceeded):
		return http.StatusInsufficientStorage, "QuotaExceeded", msg
	case errors.Is(err, store.ErrPayloadTooLarge):
		return http.StatusRequestEntityTooLarge, "EntityTooLarge", msg
	case errors.Is(err, store.ErrBucketNotFound):
		return http.StatusNotFound, "NoSuchBucket", msg
	case errors.Is(err, store.ErrObjectNotFound):
		return http.StatusNotFound, "NoSuchKey", msg
	case errors.Is(err, store.ErrMultipartNotFound):
		return http.StatusNotFound, "NoSuchUpload", msg
	case errors.Is(err, store.ErrBucketAlreadyExists):
		return http.StatusConflict, "BucketAlreadyOwnedByYou", msg
	case errors.Is(err, store.ErrBucketNotEmpty):
		return http.StatusConflict, "BucketNotEmpty", msg
	case errors.Is(err, store.ErrHashMismatch):
		return http.StatusBadRequest, "XAmzContentSHA256Mismatch", msg
	case errors.Is(err, store.ErrMD5Mismatch):
		return http.StatusBadRequest, "BadDigest", msg
	case errors.Is(err, store.ErrInvalidKey):
		return http.StatusBadRequest, "InvalidKey", msg
	case errors.Is(err, store.ErrInvalidPartOrder):
		return http.StatusBadRequest, "InvalidPartOrder", msg
	case errors.Is(err, store.ErrInvalidPartETag), errors.Is(err, store.ErrInvalidPartNumber):
		return http.StatusBadRequest, "InvalidPart", msg
	case errors.Is(err, errUnsupportedStreamingPayload):
		return http.StatusNotImplemented, "NotImplemented", msg
	default:
		return http.StatusInternalServerError, "InternalError", msg
	}
}
