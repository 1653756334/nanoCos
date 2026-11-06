package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"nanocos/internal/config"
	"nanocos/internal/store"
)

const s3MaxClockSkew = 15 * time.Minute

// S3StreamAuth 保存 AWS SigV4 流式分块上传 (STREAMING-AWS4-HMAC-SHA256-PAYLOAD) 的种子签名上下文，用于逐块校验 chunk-signature
type S3StreamAuth struct {
	SigningKey    []byte
	AmzDate       string
	Scope         string
	SeedSignature string
}

// ComputeS3ChunkSignature 计算 AWS SigV4 aws-chunked 单块签名
func ComputeS3ChunkSignature(signingKey []byte, amzDate, scope, prevSig, chunkSHA256Hex string) string {
	const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256-PAYLOAD",
		amzDate,
		scope,
		prevSig,
		emptySHA256,
		strings.ToLower(chunkSHA256Hex),
	}, "\n")
	return hex.EncodeToString(hmacSHA256Bytes(signingKey, stringToSign))
}

// Principal 表示通过认证后的调用方身份与权限
type Principal struct {
	IsAdmin      bool
	AccessKey    *store.AccessKey
	S3StreamAuth *S3StreamAuth
}

// CanAccess 判断当前身份是否有权对指定 Bucket 进行读或写操作
func (p *Principal) CanAccess(bucket string, writeRequired bool) bool {
	if p == nil {
		return false
	}
	if p.IsAdmin {
		return true
	}
	if p.AccessKey != nil {
		return p.AccessKey.CanAccessBucket(bucket, writeRequired)
	}
	return false
}

type loginAttempt struct {
	failures    int
	windowStart time.Time
	lockedUntil time.Time
}

// AuthService 提供令牌签发、黑名单注销、防爆破限流、预签名 URL 生成及多协议鉴权校验
type AuthService struct {
	cfg           *config.Config
	store         *store.Store
	mu            sync.Mutex
	revokedTokens map[string]int64 // token -> expUnix
	loginAttempts map[string]*loginAttempt
}

// NewAuthService 创建鉴权服务实例
func NewAuthService(cfg *config.Config, st *store.Store) *AuthService {
	return &AuthService{
		cfg:           cfg,
		store:         st,
		revokedTokens: make(map[string]int64),
		loginAttempts: make(map[string]*loginAttempt),
	}
}

// CheckLoginAllowed 检查客户端 IP 是否因连续登录失败处于速率限制窗口中
func (a *AuthService) CheckLoginAllowed(clientIP string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	att, ok := a.loginAttempts[clientIP]
	if !ok {
		return true
	}
	if now.Before(att.lockedUntil) {
		return false
	}
	if now.Sub(att.windowStart) > 5*time.Minute {
		delete(a.loginAttempts, clientIP)
	}
	return true
}

// RecordLoginFailure 记录一次登录失败，10 次失败后锁定 5 分钟（对 map 大小设置 4096 上限并定期清理过期项，防止内存耗尽）
func (a *AuthService) RecordLoginFailure(clientIP string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	att, ok := a.loginAttempts[clientIP]
	if !ok {
		if len(a.loginAttempts) >= 4096 {
			var oldestKey string
			var oldestTime time.Time
			for k, v := range a.loginAttempts {
				if now.After(v.lockedUntil) && now.Sub(v.windowStart) > 5*time.Minute {
					delete(a.loginAttempts, k)
					continue
				}
				if oldestKey == "" || v.windowStart.Before(oldestTime) {
					oldestKey = k
					oldestTime = v.windowStart
				}
			}
			if len(a.loginAttempts) >= 4096 && oldestKey != "" {
				delete(a.loginAttempts, oldestKey)
			}
		}
		att = &loginAttempt{failures: 0, windowStart: now}
		a.loginAttempts[clientIP] = att
	} else if now.Sub(att.windowStart) > 5*time.Minute {
		att.failures = 0
		att.windowStart = now
	}
	att.failures++
	if att.failures >= 10 {
		att.lockedUntil = now.Add(5 * time.Minute)
	}
}

// ResetLoginFailures 登录成功后重置该 IP 的失败计数
func (a *AuthService) ResetLoginFailures(clientIP string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.loginAttempts, clientIP)
}

// VerifyCredentials 校验管理员登录用户名与密码（优先校验数据库 admin_account 表中的加盐哈希）
func (a *AuthService) VerifyCredentials(username, password string) (string, bool) {
	if acc, ok := a.store.VerifyAdminCredentials(username, password); ok {
		return acc.Username, true
	}
	// 若数据库尚未初始化 admin_account 且 Config 中显式注入了测试密码，则回退校验
	if _, err := a.store.GetAdminAccount(); err != nil && a.cfg.AdminPass != "" {
		if username == a.cfg.AdminUser && hmac.Equal([]byte(password), []byte(a.cfg.AdminPass)) {
			return a.cfg.AdminUser, true
		}
	}
	return "", false
}

// CurrentAdminUsername 返回当前生效的管理员用户名
func (a *AuthService) CurrentAdminUsername() string {
	if acc, err := a.store.GetAdminAccount(); err == nil && acc.Username != "" {
		return acc.Username
	}
	if a.cfg.AdminUser != "" {
		return a.cfg.AdminUser
	}
	return "admin"
}

// GenerateAdminToken 签发带随机 jti 与 tokenVersion 的管理员控制台会话令牌
func (a *AuthService) GenerateAdminToken(ttl time.Duration) string {
	exp := time.Now().Add(ttl).Unix()
	nonce := make([]byte, 8)
	_, _ = rand.Read(nonce)
	jti := hex.EncodeToString(nonce)

	adminUser := a.CurrentAdminUsername()
	var tokenVer int64 = 1
	if acc, err := a.store.GetAdminAccount(); err == nil {
		tokenVer = acc.TokenVersion
	}

	payload := fmt.Sprintf("admin:%s:%d:%d:%s", adminUser, exp, tokenVer, jti)
	sig := hmacSHA256Hex(a.cfg.SecretKey, payload)
	raw := fmt.Sprintf("%s.%s", payload, sig)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// RevokeAdminToken 将管理员令牌加入内存与数据库持久化注销黑名单，重启后依然保持吊销状态
func (a *AuthService) RevokeAdminToken(token string) {
	token = strings.TrimSpace(token)
	if token == "" {
		return
	}
	now := time.Now().Unix()
	exp := now + 7*24*3600

	a.mu.Lock()
	for k, e := range a.revokedTokens {
		if e < now {
			delete(a.revokedTokens, k)
		}
	}
	a.revokedTokens[token] = exp
	a.mu.Unlock()

	if a.store != nil {
		a.store.RevokeTokenHash(sha256Hex([]byte(token)), exp)
	}
}

// VerifyAdminToken 校验管理员会话令牌（含内存+数据库黑名单检查与数据库 tokenVersion 版本比对，修改密码或登出后旧令牌立即且持久失效）
func (a *AuthService) VerifyAdminToken(token string) bool {
	token = strings.TrimSpace(token)
	if token == "" {
		return false
	}

	a.mu.Lock()
	_, revoked := a.revokedTokens[token]
	a.mu.Unlock()
	if revoked {
		return false
	}
	if a.store != nil && a.store.IsTokenHashRevoked(sha256Hex([]byte(token))) {
		return false
	}

	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return false
	}
	parts := strings.Split(string(decoded), ".")
	if len(parts) != 2 {
		return false
	}
	payload, sig := parts[0], parts[1]
	expectedSig := hmacSHA256Hex(a.cfg.SecretKey, payload)
	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return false
	}
	fields := strings.Split(payload, ":")
	if len(fields) < 4 || fields[0] != "admin" {
		return false
	}
	tokenUser := fields[1]
	exp, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	tokenVer, err := strconv.ParseInt(fields[3], 10, 64)
	if err != nil {
		return false
	}

	if acc, err := a.store.GetAdminAccount(); err == nil {
		if tokenUser != acc.Username || tokenVer != acc.TokenVersion {
			return false
		}
	} else if tokenUser != a.cfg.AdminUser {
		return false
	}
	return true
}

// GeneratePresignedQuery 生成预签名 URL 查询参数串 (支持 GET 下载与 PUT 直传)
func (a *AuthService) GeneratePresignedQuery(method, bucket, key string, expiresInSec int64, akID string) (string, int64, error) {
	method = strings.ToUpper(strings.TrimSpace(method))
	if method == "" {
		method = "GET"
	}
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	key, err := store.NormalizeObjectKey(key, false)
	if err != nil {
		return "", 0, err
	}
	if expiresInSec <= 0 {
		expiresInSec = 3600
	}
	if expiresInSec > 7*24*3600 {
		expiresInSec = 7 * 24 * 3600
	}
	exp := time.Now().Unix() + expiresInSec

	secret := a.cfg.SecretKey
	if akID == "" {
		akID = "ADMIN"
	} else if akID != "ADMIN" {
		ak, err := a.store.GetAccessKey(akID)
		if err != nil {
			return "", 0, err
		}
		secret = ak.SecretKey
	}

	stringToSign := fmt.Sprintf("%s\n%s\n%s\n%d\n%s", method, bucket, key, exp, akID)
	sig := hmacSHA256Hex(secret, stringToSign)

	v := url.Values{}
	v.Set("ak", akID)
	v.Set("expires", strconv.FormatInt(exp, 10))
	v.Set("method", method)
	v.Set("sig", sig)
	return v.Encode(), exp, nil
}

// VerifyPresignedQuery 校验请求 URL 中的预签名参数（兼容自定义预签名与 S3 SigV4/V2 预签名）
func (a *AuthService) VerifyPresignedQuery(r *http.Request, bucket, key string) (*Principal, bool) {
	q := r.URL.Query()
	sig := q.Get("sig")
	expStr := q.Get("expires")
	akID := q.Get("ak")
	if sig == "" || expStr == "" || akID == "" {
		// 若不是自定义预签名，检查是否已在中间件通过 S3 预签名认证
		if p := FromContext(r.Context()); p != nil {
			return p, true
		}
		return nil, false
	}

	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return nil, false
	}

	signedMethod := strings.ToUpper(q.Get("method"))
	if signedMethod == "" {
		signedMethod = "GET"
	}
	reqMethod := strings.ToUpper(r.Method)
	if reqMethod != signedMethod && !(signedMethod == "GET" && reqMethod == "HEAD") {
		return nil, false
	}

	normKey, err := store.NormalizeObjectKey(key, false)
	if err != nil {
		return nil, false
	}
	bucket = strings.ToLower(strings.TrimSpace(bucket))

	var secret string
	var principal *Principal
	if akID == "ADMIN" {
		secret = a.cfg.SecretKey
		principal = &Principal{IsAdmin: true}
	} else {
		ak, err := a.store.GetAccessKey(akID)
		if err != nil {
			return nil, false
		}
		secret = ak.SecretKey
		principal = &Principal{AccessKey: ak}
	}

	stringToSign := fmt.Sprintf("%s\n%s\n%s\n%d\n%s", signedMethod, bucket, normKey, exp, akID)
	expectedSig := hmacSHA256Hex(secret, stringToSign)
	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return nil, false
	}
	return principal, true
}

// AuthenticateRequest 综合识别请求中的认证凭证：
// 1. Bearer Admin Token 或 Cookie (移除不安全的 ?admin_token= URL 传参)
// 2. X-Cos-Access-Key + X-Cos-Secret-Key 请求头
// 3. HTTP Basic Auth (AK:SK 或 admin:pass)
// 4. AWS S3 Signature V4 / V2 (Header 或 Query Presigned，含严格时间戳与过期校验)
func (a *AuthService) AuthenticateRequest(r *http.Request) *Principal {
	// 1. 检查 X-Cos-Access-Key / X-Cos-Secret-Key
	if akID := strings.TrimSpace(r.Header.Get("X-Cos-Access-Key")); akID != "" {
		sk := strings.TrimSpace(r.Header.Get("X-Cos-Secret-Key"))
		if ak, err := a.store.GetAccessKey(akID); err == nil && hmac.Equal([]byte(ak.SecretKey), []byte(sk)) {
			return &Principal{AccessKey: ak}
		}
	}

	// 2. 检查 Authorization 头 (Bearer)
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(authHeader, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
		if a.VerifyAdminToken(token) {
			return &Principal{IsAdmin: true}
		}
		// 也支持 Bearer <AK>:<SK>
		if idx := strings.Index(token, ":"); idx > 0 {
			akID, sk := token[:idx], token[idx+1:]
			if ak, err := a.store.GetAccessKey(akID); err == nil && hmac.Equal([]byte(ak.SecretKey), []byte(sk)) {
				return &Principal{AccessKey: ak}
			}
		}
	}

	// 3. 检查 Basic Auth (支持管理员账号密码 或 AK:SK)
	if user, pass, ok := r.BasicAuth(); ok {
		if _, validAdmin := a.VerifyCredentials(user, pass); validAdmin {
			return &Principal{IsAdmin: true}
		}
		if ak, err := a.store.GetAccessKey(user); err == nil && hmac.Equal([]byte(ak.SecretKey), []byte(pass)) {
			return &Principal{AccessKey: ak}
		}
	}

	// 4. 检查 HttpOnly Cookie 中的管理员 token
	if c, err := r.Cookie("nanocos_token"); err == nil && a.VerifyAdminToken(c.Value) {
		return &Principal{IsAdmin: true}
	}

	// 5. 检查 AWS S3 Signature V4 或 V2
	if p := a.verifyS3Signature(r); p != nil {
		return p
	}

	return nil
}

// verifyS3Signature 严格校验 AWS Signature V4 与 V2（含时钟偏移窗口与预签名过期校验）
func (a *AuthService) verifyS3Signature(r *http.Request) *Principal {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))

	// A. AWS Signature V4 Header: AWS4-HMAC-SHA256 Credential=AKID/20261105/us-east-1/s3/aws4_request, SignedHeaders=..., Signature=...
	if strings.HasPrefix(authHeader, "AWS4-HMAC-SHA256") {
		credPart := extractSubField(authHeader, "Credential=")
		signedHeadersPart := extractSubField(authHeader, "SignedHeaders=")
		sigPart := strings.ToLower(extractSubField(authHeader, "Signature="))
		if credPart == "" || signedHeadersPart == "" || sigPart == "" {
			return nil
		}
		credFields := strings.Split(credPart, "/")
		if len(credFields) < 5 || credFields[4] != "aws4_request" {
			return nil
		}
		akID, dateStamp, region, service := credFields[0], credFields[1], credFields[2], credFields[3]

		amzDate := strings.TrimSpace(r.Header.Get("X-Amz-Date"))
		if amzDate == "" {
			amzDate = strings.TrimSpace(r.Header.Get("Date"))
		}
		reqTime, ok := parseS3Date(amzDate)
		if !ok {
			return nil
		}
		// 严格校验 ±15 分钟防重放时钟窗口与 Credential 中的 dateStamp
		if absDuration(time.Since(reqTime)) > s3MaxClockSkew {
			return nil
		}
		if dateStamp != reqTime.UTC().Format("20060102") {
			return nil
		}

		ak, err := a.store.GetAccessKey(akID)
		if err != nil {
			return nil
		}

		computed := computeS3SigV4(r, ak.SecretKey, dateStamp, region, service, signedHeadersPart, amzDate, false)
		if hmac.Equal([]byte(computed), []byte(sigPart)) {
			kSigning := deriveS3SigningKey(ak.SecretKey, dateStamp, region, service)
			return &Principal{
				AccessKey: ak,
				S3StreamAuth: &S3StreamAuth{
					SigningKey:    kSigning,
					AmzDate:       amzDate,
					Scope:         fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service),
					SeedSignature: sigPart,
				},
			}
		}
		return nil
	}

	// B. AWS Signature V4 Query Presigned: ?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Date=...&X-Amz-Expires=...
	q := r.URL.Query()
	if q.Get("X-Amz-Algorithm") == "AWS4-HMAC-SHA256" {
		credPart := q.Get("X-Amz-Credential")
		signedHeadersPart := q.Get("X-Amz-SignedHeaders")
		sigPart := strings.ToLower(strings.TrimSpace(q.Get("X-Amz-Signature")))
		amzDate := strings.TrimSpace(q.Get("X-Amz-Date"))
		expiresStr := strings.TrimSpace(q.Get("X-Amz-Expires"))
		credFields := strings.Split(credPart, "/")
		if len(credFields) < 5 || credFields[4] != "aws4_request" || sigPart == "" || amzDate == "" || expiresStr == "" {
			return nil
		}

		reqTime, ok := parseS3Date(amzDate)
		if !ok {
			return nil
		}
		akID, dateStamp, region, service := credFields[0], credFields[1], credFields[2], credFields[3]
		if dateStamp != reqTime.UTC().Format("20060102") {
			return nil
		}

		// 校验 X-Amz-Expires (1 秒 ~ 7 天 604800 秒)
		expSec, err := strconv.ParseInt(expiresStr, 10, 64)
		if err != nil || expSec <= 0 || expSec > 604800 {
			return nil
		}
		now := time.Now().UTC()
		if now.Before(reqTime.Add(-s3MaxClockSkew)) || now.After(reqTime.Add(time.Duration(expSec)*time.Second)) {
			return nil
		}

		ak, err := a.store.GetAccessKey(akID)
		if err != nil {
			return nil
		}
		computed := computeS3SigV4(r, ak.SecretKey, dateStamp, region, service, signedHeadersPart, amzDate, true)
		if hmac.Equal([]byte(computed), []byte(sigPart)) {
			return &Principal{AccessKey: ak}
		}
		return nil
	}

	// C. AWS Signature V2 Header: Authorization: AWS AKID:Signature (完整校验 HMAC-SHA1 + 时钟偏移)
	if strings.HasPrefix(authHeader, "AWS ") {
		rest := strings.TrimSpace(strings.TrimPrefix(authHeader, "AWS "))
		if idx := strings.Index(rest, ":"); idx > 0 {
			akID := strings.TrimSpace(rest[:idx])
			sigPart := strings.TrimSpace(rest[idx+1:])
			if akID == "" || sigPart == "" {
				return nil
			}
			ak, err := a.store.GetAccessKey(akID)
			if err != nil {
				return nil
			}
			if verifyS3SigV2Header(r, ak.SecretKey, sigPart) {
				return &Principal{AccessKey: ak}
			}
		}
		return nil
	}

	// D. AWS Signature V2 Query Presigned: ?AWSAccessKeyId=...&Expires=...&Signature=...
	if akID := strings.TrimSpace(q.Get("AWSAccessKeyId")); akID != "" {
		expStr := strings.TrimSpace(q.Get("Expires"))
		sigPart := strings.TrimSpace(q.Get("Signature"))
		if expStr == "" || sigPart == "" {
			return nil
		}
		expUnix, err := strconv.ParseInt(expStr, 10, 64)
		if err != nil || time.Now().Unix() > expUnix {
			return nil
		}
		ak, err := a.store.GetAccessKey(akID)
		if err != nil {
			return nil
		}
		if verifyS3SigV2Query(r, ak.SecretKey, expStr, sigPart) {
			return &Principal{AccessKey: ak}
		}
		return nil
	}

	return nil
}

func deriveS3SigningKey(secretKey, dateStamp, region, service string) []byte {
	kDate := hmacSHA256Bytes([]byte("AWS4"+secretKey), dateStamp)
	kRegion := hmacSHA256Bytes(kDate, region)
	kService := hmacSHA256Bytes(kRegion, service)
	return hmacSHA256Bytes(kService, "aws4_request")
}

func computeS3SigV4(r *http.Request, secretKey, dateStamp, region, service, signedHeadersStr, amzDate string, isQuery bool) string {
	canonicalURI := s3CanonicalURI(r.URL)

	// Canonical Query String
	query := r.URL.Query()
	if isQuery {
		query.Del("X-Amz-Signature")
	}
	var qKeys []string
	for k := range query {
		qKeys = append(qKeys, k)
	}
	sort.Strings(qKeys)
	var qPairs []string
	for _, k := range qKeys {
		vals := query[k]
		sort.Strings(vals)
		for _, v := range vals {
			qPairs = append(qPairs, s3PercentEncode(k)+"="+s3PercentEncode(v))
		}
	}
	canonicalQuery := strings.Join(qPairs, "&")

	// Canonical Headers (归一化小写，并按 AWS SigV4 规范折叠连续空格)
	normSignedHeadersStr := strings.ToLower(strings.TrimSpace(signedHeadersStr))
	signedHeaders := strings.Split(normSignedHeadersStr, ";")
	var validSignedHeaders []string
	var canonicalHeaders strings.Builder
	for _, h := range signedHeaders {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		validSignedHeaders = append(validSignedHeaders, h)
		var val string
		if h == "host" {
			val = r.Host
		} else {
			rawVals := r.Header.Values(h)
			collapsed := make([]string, 0, len(rawVals))
			for _, rv := range rawVals {
				collapsed = append(collapsed, collapseSpaces(strings.TrimSpace(rv)))
			}
			val = strings.Join(collapsed, ",")
		}
		canonicalHeaders.WriteString(h)
		canonicalHeaders.WriteString(":")
		canonicalHeaders.WriteString(collapseSpaces(strings.TrimSpace(val)))
		canonicalHeaders.WriteString("\n")
	}
	normalizedSignedHeaders := strings.Join(validSignedHeaders, ";")

	payloadHash := strings.TrimSpace(r.Header.Get("X-Amz-Content-Sha256"))
	if qVal := strings.TrimSpace(r.URL.Query().Get("X-Amz-Content-Sha256")); isQuery && qVal != "" {
		payloadHash = qVal
	}
	if payloadHash == "" {
		if isQuery {
			payloadHash = "UNSIGNED-PAYLOAD"
		} else {
			payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		}
	}

	canonicalReq := strings.Join([]string{
		r.Method,
		canonicalURI,
		canonicalQuery,
		canonicalHeaders.String(),
		normalizedSignedHeaders,
		payloadHash,
	}, "\n")

	credScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, region, service)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credScope,
		sha256Hex([]byte(canonicalReq)),
	}, "\n")

	kSigning := deriveS3SigningKey(secretKey, dateStamp, region, service)
	return hex.EncodeToString(hmacSHA256Bytes(kSigning, stringToSign))
}

// verifyS3SigV2Header 严格校验 AWS S3 Signature V2 Header (HMAC-SHA1)
func verifyS3SigV2Header(r *http.Request, secretKey, providedSig string) bool {
	dateStr := strings.TrimSpace(r.Header.Get("Date"))
	amzDate := strings.TrimSpace(r.Header.Get("X-Amz-Date"))
	checkTimeStr := dateStr
	if amzDate != "" {
		checkTimeStr = amzDate
		// 根据 S3 V2 规范，若存在 x-amz-date 头，StringToSign 中的 Date 行置空（因为 x-amz-date 会出现在 CanonicalizedAmzHeaders 中）
		dateStr = ""
	}
	reqTime, ok := parseS3Date(checkTimeStr)
	if !ok || absDuration(time.Since(reqTime)) > s3MaxClockSkew {
		return false
	}

	stringToSign := buildS3V2StringToSign(r, dateStr)
	expectedSig := hmacSHA1Base64(secretKey, stringToSign)
	return hmac.Equal([]byte(providedSig), []byte(expectedSig))
}

// verifyS3SigV2Query 严格校验 AWS S3 Signature V2 Query Presigned URL (HMAC-SHA1)
func verifyS3SigV2Query(r *http.Request, secretKey, expiresStr, providedSig string) bool {
	stringToSign := buildS3V2StringToSign(r, expiresStr)
	expectedSig := hmacSHA1Base64(secretKey, stringToSign)
	return hmac.Equal([]byte(providedSig), []byte(expectedSig))
}

func buildS3V2StringToSign(r *http.Request, dateOrExpires string) string {
	contentMD5 := strings.TrimSpace(r.Header.Get("Content-MD5"))
	contentType := strings.TrimSpace(r.Header.Get("Content-Type"))

	// CanonicalizedAmzHeaders
	var amzKeys []string
	amzMap := make(map[string]string)
	for k, vals := range r.Header {
		lk := strings.ToLower(strings.TrimSpace(k))
		if strings.HasPrefix(lk, "x-amz-") {
			amzKeys = append(amzKeys, lk)
			cleaned := make([]string, 0, len(vals))
			for _, v := range vals {
				cleaned = append(cleaned, strings.TrimSpace(v))
			}
			amzMap[lk] = strings.Join(cleaned, ",")
		}
	}
	sort.Strings(amzKeys)
	var amzSection strings.Builder
	for _, lk := range amzKeys {
		amzSection.WriteString(lk)
		amzSection.WriteString(":")
		amzSection.WriteString(amzMap[lk])
		amzSection.WriteString("\n")
	}

	// CanonicalizedResource (若路径带 /s3 前缀，同时支持标准路径)
	resource := r.URL.Path
	if resource == "" {
		resource = "/"
	}
	return fmt.Sprintf("%s\n%s\n%s\n%s\n%s%s", r.Method, contentMD5, contentType, dateOrExpires, amzSection.String(), resource)
}

func parseS3Date(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	layouts := []string{
		"20060102T150405Z",
		time.RFC1123,
		time.RFC1123Z,
		time.RFC850,
		time.ANSIC,
		time.RFC3339,
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func collapseSpaces(s string) string {
	if !strings.Contains(s, "  ") {
		return s
	}
	return strings.Join(strings.Fields(s), " ")
}

func s3CanonicalURI(u *url.URL) string {
	if u == nil {
		return "/"
	}
	// 优先取 EscapedPath() 以保留客户端对象 Key 中显式编码的 %2F，避免被 URL.Path 提前解码为路径分隔符 '/'
	escaped := u.EscapedPath()
	if escaped == "" {
		return "/"
	}
	parts := strings.Split(escaped, "/")
	for i, part := range parts {
		if unescaped, err := url.PathUnescape(part); err == nil {
			parts[i] = s3PercentEncode(unescaped)
		} else {
			parts[i] = s3PercentEncode(part)
		}
	}
	return strings.Join(parts, "/")
}

func s3URIPath(p string) string {
	if p == "" {
		return "/"
	}
	parts := strings.Split(p, "/")
	for i, part := range parts {
		parts[i] = s3PercentEncode(part)
	}
	return strings.Join(parts, "/")
}

func s3PercentEncode(s string) string {
	var buf strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			buf.WriteByte(c)
		} else {
			fmt.Fprintf(&buf, "%%%02X", c)
		}
	}
	return buf.String()
}

func extractSubField(header, prefix string) string {
	idx := strings.Index(header, prefix)
	if idx < 0 {
		return ""
	}
	rest := header[idx+len(prefix):]
	if comma := strings.Index(rest, ","); comma >= 0 {
		rest = rest[:comma]
	}
	return strings.TrimSpace(rest)
}

func hmacSHA256Bytes(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(data))
	return mac.Sum(nil)
}

func hmacSHA256Hex(key, data string) string {
	return hex.EncodeToString(hmacSHA256Bytes([]byte(key), data))
}

func hmacSHA1Base64(key, data string) string {
	mac := hmac.New(sha1.New, []byte(key))
	_, _ = mac.Write([]byte(data))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
