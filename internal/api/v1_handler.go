package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"nanocos/internal/auth"
	"nanocos/internal/store"
)

const maxJSONBodyBytes int64 = 1 << 20 // 控制面 JSON 请求体最大 1 MiB

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	defer func() {
		_, _ = io.Copy(io.Discard, r.Body)
	}()
	dec := json.NewDecoder(r.Body)
	return dec.Decode(dst)
}

// requireGlobalAdmin 校验调用方是否为控制台超级管理员或拥有全局 (*) 权限的 admin AccessKey
func (s *Server) requireGlobalAdmin(w http.ResponseWriter, r *http.Request) bool {
	p := auth.FromContext(r.Context())
	if p != nil && (p.IsAdmin || (p.AccessKey != nil && p.AccessKey.Permission == "admin" && strings.TrimSpace(p.AccessKey.AllowedBuckets) == "*")) {
		return true
	}
	writeJSONError(w, http.StatusForbidden, "仅全局管理员可执行此操作")
	return false
}

// requireBucketAdmin 校验调用方是否为超级管理员或对该 Bucket 具备 admin 权限
func (s *Server) requireBucketAdmin(w http.ResponseWriter, r *http.Request, bucket string) bool {
	p := auth.FromContext(r.Context())
	if p != nil && (p.IsAdmin || (p.AccessKey != nil && p.AccessKey.Permission == "admin" && p.CanAccess(bucket, true))) {
		return true
	}
	writeJSONError(w, http.StatusForbidden, "仅管理员可管理该存储桶")
	return false
}

// requireBucketAccess 校验调用方是否具备指定 Bucket 的读或写权限
func (s *Server) requireBucketAccess(w http.ResponseWriter, r *http.Request, bucket string, writeRequired bool) (*auth.Principal, bool) {
	p := auth.FromContext(r.Context())
	if p != nil && p.CanAccess(bucket, writeRequired) {
		return p, true
	}
	writeJSONError(w, http.StatusForbidden, "无权访问或操作该存储桶")
	return nil, false
}

// extractClientIP 提取客户端真实 IP。默认使用底层 TCP 连接的 RemoteAddr，仅当开启 TrustProxy 或对端为本机回环反向代理时才信任 X-Forwarded-For / X-Real-IP，彻底杜绝伪造 XFF 绕过登录限流。
func (s *Server) extractClientIP(r *http.Request) string {
	remoteHost := strings.TrimSpace(r.RemoteAddr)
	if h, _, err := net.SplitHostPort(remoteHost); err == nil && h != "" {
		remoteHost = h
	}
	trustHeaders := s.cfg != nil && s.cfg.TrustProxy
	if !trustHeaders {
		if ip := net.ParseIP(remoteHost); ip != nil && ip.IsLoopback() {
			trustHeaders = true
		}
	}
	if trustHeaders {
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return xri
		}
	}
	if remoteHost != "" {
		return remoteHost
	}
	return r.RemoteAddr
}

func isHTTPSRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// handleLogin POST /api/v1/auth/login
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	clientIP := s.extractClientIP(r)
	if !s.auth.CheckLoginAllowed(clientIP) {
		writeJSONError(w, http.StatusTooManyRequests, "登录失败次数过多，请 5 分钟后再试")
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求体 JSON 格式错误或超出大小限制")
		return
	}

	matchedUser, ok := s.auth.VerifyCredentials(req.Username, req.Password)
	if !ok {
		s.auth.RecordLoginFailure(clientIP)
		writeJSONError(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}

	s.auth.ResetLoginFailures(clientIP)
	token := s.auth.GenerateAdminToken(7 * 24 * time.Hour)
	http.SetCookie(w, &http.Cookie{
		Name:     "nanocos_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		MaxAge:   7 * 24 * 3600,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"token":    token,
		"username": matchedUser,
	})
}

// handleUpdateAdminAccount PUT /api/v1/auth/account 在线修改管理员用户名与密码
func (s *Server) handleUpdateAdminAccount(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil || !p.IsAdmin {
		writeJSONError(w, http.StatusForbidden, "仅管理员可修改账户凭证")
		return
	}

	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewUsername     string `json:"newUsername"`
		NewPassword     string `json:"newPassword"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求体 JSON 格式错误")
		return
	}

	updated, err := s.store.UpdateAdminCredentialsWithVerify(req.CurrentPassword, req.NewUsername, req.NewPassword)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, store.ErrInvalidCredentials) {
			status = http.StatusUnauthorized
		}
		writeJSONError(w, status, err.Error())
		return
	}

	newToken := s.auth.GenerateAdminToken(7 * 24 * time.Hour)
	http.SetCookie(w, &http.Cookie{
		Name:     "nanocos_token",
		Value:    newToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		MaxAge:   7 * 24 * 3600,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"username": updated.Username,
		"token":    newToken,
	})
}

// handleLogout POST /api/v1/auth/logout
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("nanocos_token"); err == nil && c.Value != "" {
		s.auth.RevokeAdminToken(c.Value)
	}
	if authHeader := strings.TrimSpace(r.Header.Get("Authorization")); strings.HasPrefix(authHeader, "Bearer ") {
		s.auth.RevokeAdminToken(strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer ")))
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "nanocos_token",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPSRequest(r),
		MaxAge:   -1,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleMe GET /api/v1/auth/me
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil {
		writeJSONError(w, http.StatusUnauthorized, "未登录或凭证已过期")
		return
	}
	baseURL := s.resolveBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"isAdmin":       p.IsAdmin,
		"username":      s.auth.CurrentAdminUsername(),
		"baseUrl":       baseURL,
		"s3Endpoint":    baseURL + "/s3",
		"s3Region":      s.cfg.S3Region,
	})
}

// handleStats GET /api/v1/stats
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil {
		writeJSONError(w, http.StatusUnauthorized, "请先登录")
		return
	}
	stats, err := s.store.GetSystemStats()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !p.IsAdmin && p.AccessKey != nil && strings.TrimSpace(p.AccessKey.AllowedBuckets) != "*" {
		var filteredRecent []store.Object
		for _, obj := range stats.RecentObjects {
			if p.CanAccess(obj.Bucket, false) {
				filteredRecent = append(filteredRecent, obj)
			}
		}
		if filteredRecent == nil {
			filteredRecent = []store.Object{}
		}
		stats.RecentObjects = filteredRecent

		var filteredTop []store.Object
		for _, obj := range stats.TopObjects {
			if p.CanAccess(obj.Bucket, false) {
				filteredTop = append(filteredTop, obj)
			}
		}
		if filteredTop == nil {
			filteredTop = []store.Object{}
		}
		stats.TopObjects = filteredTop
	}

	baseURL := s.resolveBaseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"stats":      stats,
		"baseUrl":    baseURL,
		"s3Endpoint": baseURL + "/s3",
		"s3Region":   s.cfg.S3Region,
	})
}

// handleListBuckets GET /api/v1/buckets
func (s *Server) handleListBuckets(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil {
		writeJSONError(w, http.StatusUnauthorized, "未授权访问")
		return
	}
	buckets, err := s.store.ListBuckets()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var filtered []store.Bucket
	for _, b := range buckets {
		if p.CanAccess(b.Name, false) {
			filtered = append(filtered, b)
		}
	}
	if filtered == nil {
		filtered = []store.Bucket{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"buckets": filtered})
}

// handleCreateBucket POST /api/v1/buckets
func (s *Server) handleCreateBucket(w http.ResponseWriter, r *http.Request) {
	if !s.requireGlobalAdmin(w, r) {
		return
	}

	var req struct {
		Name        string `json:"name"`
		Visibility  string `json:"visibility"`
		QuotaBytes  int64  `json:"quotaBytes"`
		CORSOrigins string `json:"corsOrigins"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}

	b, err := s.store.CreateBucket(req.Name, req.Visibility, req.QuotaBytes, req.CORSOrigins)
	if err != nil {
		if errors.Is(err, store.ErrBucketAlreadyExists) {
			writeJSONCodeError(w, http.StatusConflict, "BucketAlreadyOwnedByYou", err.Error())
			return
		}
		writeJSONCodeError(w, http.StatusBadRequest, "InvalidBucketName", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"bucket": b})
}

// handleUpdateBucket PUT /api/v1/buckets/{bucket}
func (s *Server) handleUpdateBucket(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if !s.requireBucketAdmin(w, r, bucketName) {
		return
	}

	var req struct {
		Visibility  string `json:"visibility"`
		QuotaBytes  int64  `json:"quotaBytes"`
		CORSOrigins string `json:"corsOrigins"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}

	b, err := s.store.UpdateBucket(bucketName, req.Visibility, req.QuotaBytes, req.CORSOrigins)
	if err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bucket": b})
}

// handleDeleteBucket DELETE /api/v1/buckets/{bucket}
func (s *Server) handleDeleteBucket(w http.ResponseWriter, r *http.Request) {
	bucketName := r.PathValue("bucket")
	if !s.requireBucketAdmin(w, r, bucketName) {
		return
	}
	force := r.URL.Query().Get("force") == "true" || r.URL.Query().Get("force") == "1"

	if err := s.store.DeleteBucket(bucketName, force); err != nil {
		writeUploadStoreErrorJSON(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- AccessKey 密钥管理控制器 ---

// handleListAccessKeys GET /api/v1/access-keys
func (s *Server) handleListAccessKeys(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil || !p.IsAdmin {
		writeJSONError(w, http.StatusForbidden, "仅管理员可管理 AccessKey")
		return
	}
	keys, err := s.store.ListAccessKeys()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accessKeys": keys})
}

// handleCreateAccessKey POST /api/v1/access-keys
func (s *Server) handleCreateAccessKey(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil || !p.IsAdmin {
		writeJSONError(w, http.StatusForbidden, "仅管理员可创建 AccessKey")
		return
	}
	var req struct {
		Name           string `json:"name"`
		AllowedBuckets string `json:"allowedBuckets"`
		Permission     string `json:"permission"`
	}
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "无效的 JSON 请求体")
		return
	}

	ak, err := s.store.CreateAccessKey(req.Name, req.AllowedBuckets, req.Permission)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"accessKey": ak})
}

// handleDeleteAccessKey DELETE /api/v1/access-keys/{ak}
func (s *Server) handleDeleteAccessKey(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil || !p.IsAdmin {
		writeJSONError(w, http.StatusForbidden, "仅管理员可删除 AccessKey")
		return
	}
	ak := r.PathValue("ak")
	if err := s.store.DeleteAccessKey(ak); err != nil {
		writeJSONError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- 辅助方法 ---

func (s *Server) resolveBaseURL(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return s.cfg.PublicURL
	}
	scheme := "http"
	if isHTTPSRequest(r) {
		scheme = "https"
	}
	host := r.Host
	if fwdHost := r.Header.Get("X-Forwarded-Host"); fwdHost != "" {
		host = fwdHost
	}
	return fmt.Sprintf("%s://%s", scheme, host)
}

func (s *Server) buildObjectRawURL(r *http.Request, bucket, key string) string {
	base := s.resolveBaseURL(r)
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return fmt.Sprintf("%s/raw/%s/%s", base, url.PathEscape(strings.ToLower(bucket)), path.Join(parts...))
}

func extractCustomMetaHeaders(h http.Header) map[string]string {
	meta := make(map[string]string)
	for k, vals := range h {
		lower := strings.ToLower(k)
		if strings.HasPrefix(lower, "x-amz-meta-") {
			meta[strings.TrimPrefix(lower, "x-amz-meta-")] = strings.Join(vals, ",")
		} else if strings.HasPrefix(lower, "x-cos-meta-") {
			meta[strings.TrimPrefix(lower, "x-cos-meta-")] = strings.Join(vals, ",")
		}
	}
	return meta
}
