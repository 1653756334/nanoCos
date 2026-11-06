package api_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"nanocos/internal/api"
	"nanocos/internal/auth"
	"nanocos/internal/config"
	"nanocos/internal/store"
)

func setupTestHandler(t *testing.T) (http.Handler, *store.Store, *store.AccessKey) {
	t.Helper()
	tmpDir := t.TempDir()
	cfg := &config.Config{
		Addr:      ":9000",
		DataDir:   tmpDir,
		AdminUser: "admin",
		AdminPass: "secretpass",
		SecretKey: "test-master-secret-key-for-nanocos",
		PublicURL: "http://localhost:9000",
		S3Region:  "us-east-1",
	}
	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("EnsureDirectories failed: %v", err)
	}
	st, err := store.NewStore(cfg.DBPath(), cfg.BlobsDir(), cfg.MultipartDir(), cfg.TmpDir())
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	ak, _, err := st.EnsureDefaultAccessKey()
	if err != nil {
		t.Fatalf("EnsureDefaultAccessKey failed: %v", err)
	}

	authSvc := auth.NewAuthService(cfg, st)
	srv := api.NewServer(cfg, st, authSvc)
	return srv.Handler(), st, ak
}

func TestEndToEndCASAndDualProtocol(t *testing.T) {
	handler, st, ak := setupTestHandler(t)

	doReq := func(method, pathStr string, body io.Reader, headers map[string]string, withAK bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, pathStr, body)
		if withAK {
			req.Header.Set("X-Cos-Access-Key", ak.AccessKey)
			req.Header.Set("X-Cos-Secret-Key", ak.SecretKey)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// 1. 创建公开桶 assets 与私有桶 vault
	for _, b := range []struct{ name, vis string }{
		{"assets", "public-read"},
		{"vault", "private"},
	} {
		body := `{"name":"` + b.name + `","visibility":"` + b.vis + `"}`
		rec := doReq(http.MethodPost, "/api/v1/buckets", strings.NewReader(body), nil, true)
		if rec.Code != http.StatusCreated {
			t.Fatalf("创建存储桶 %s 失败: status=%d body=%s", b.name, rec.Code, rec.Body.String())
		}
	}

	// 2. 上传文件并测试 CAS 全局去重与秒传
	payload := []byte("NanoCOS Content-Addressable Storage Test Payload - 2026! Repeated block for Range test.")
	sum := sha256.Sum256(payload)
	expectedSHA := hex.EncodeToString(sum[:])

	putRec := doReq(http.MethodPut, "/api/v1/buckets/assets/objects/docs/readme.txt", bytes.NewReader(payload), map[string]string{
		"Content-Type": "text/plain",
	}, true)
	if putRec.Code != http.StatusOK {
		t.Fatalf("上传文件失败: status=%d body=%s", putRec.Code, putRec.Body.String())
	}

	// 使用 SHA-256 秒传接口在另一个私有桶 vault 中秒传同一份内容（零字节上传）
	fastBody := `{"key":"backup/readme-copy.txt","sha256":"` + expectedSHA + `","contentType":"text/plain"}`
	fastRec := doReq(http.MethodPost, "/api/v1/buckets/vault/fast-upload", strings.NewReader(fastBody), nil, true)
	if fastRec.Code != http.StatusOK {
		t.Fatalf("秒传请求失败: status=%d body=%s", fastRec.Code, fastRec.Body.String())
	}
	var fastResult struct {
		FastUploaded bool `json:"fastUploaded"`
	}
	_ = json.NewDecoder(fastRec.Body).Decode(&fastResult)
	if !fastResult.FastUploaded {
		t.Fatalf("预期命中 CAS 秒传，但返回 fastUploaded=false")
	}

	// 验证系统去重统计：2 个逻辑对象，但只有 1 个物理块，去重节省率 50%
	stats, err := st.GetSystemStats()
	if err != nil {
		t.Fatalf("GetSystemStats failed: %v", err)
	}
	if stats.ObjectCount != 2 || stats.BlobCount != 1 {
		t.Fatalf("预期 ObjectCount=2, BlobCount=1，实际 ObjectCount=%d, BlobCount=%d", stats.ObjectCount, stats.BlobCount)
	}
	if stats.PhysicalBytes != int64(len(payload)) || stats.LogicalBytes != int64(len(payload)*2) {
		t.Fatalf("CAS 去重容量计算不匹配: physical=%d logical=%d", stats.PhysicalBytes, stats.LogicalBytes)
	}

	// 3. 测试公开直链访问、HTTP Range (206 Partial Content) 与 ETag (304 Not Modified)
	rangeRec := doReq(http.MethodGet, "/raw/assets/docs/readme.txt", nil, map[string]string{
		"Range": "bytes=0-6",
	}, false)
	if rangeRec.Code != http.StatusPartialContent || rangeRec.Body.String() != "NanoCOS" {
		t.Fatalf("HTTP Range 206 验证失败: status=%d body=%q", rangeRec.Code, rangeRec.Body.String())
	}

	etag := rangeRec.Header().Get("ETag")
	cacheRec := doReq(http.MethodGet, "/raw/assets/docs/readme.txt", nil, map[string]string{
		"If-None-Match": etag,
	}, false)
	if cacheRec.Code != http.StatusNotModified {
		t.Fatalf("ETag 304 缓存验证失败: status=%d", cacheRec.Code)
	}

	// 4. 测试私有桶访问拦截与 Presigned URL 预签名访问
	privRec := doReq(http.MethodGet, "/raw/vault/backup/readme-copy.txt", nil, nil, false)
	if privRec.Code != http.StatusForbidden {
		t.Fatalf("私有桶未授权访问应当返回 403，实际返回: %d", privRec.Code)
	}

	presignRec := doReq(http.MethodPost, "/api/v1/buckets/vault/presign", strings.NewReader(`{"key":"backup/readme-copy.txt","method":"GET","expiresInSec":600}`), nil, true)
	if presignRec.Code != http.StatusOK {
		t.Fatalf("生成预签名 URL 失败: %d %s", presignRec.Code, presignRec.Body.String())
	}
	var presignData struct {
		URL string `json:"url"`
	}
	_ = json.NewDecoder(presignRec.Body).Decode(&presignData)
	parsedURL, err := url.Parse(presignData.URL)
	if err != nil {
		t.Fatalf("解析预签名 URL 失败: %v", err)
	}

	signedGetRec := doReq(http.MethodGet, parsedURL.RequestURI(), nil, nil, false)
	if signedGetRec.Code != http.StatusOK || !bytes.Equal(signedGetRec.Body.Bytes(), payload) {
		t.Fatalf("通过预签名 URL 访问私有桶失败: status=%d", signedGetRec.Code)
	}

	// 5. 测试大文件分片上传 (Multipart Upload: Init -> Part 1 & Part 2 -> Complete)
	initRec := doReq(http.MethodPost, "/api/v1/buckets/assets/multipart/init", strings.NewReader(`{"key":"videos/clip.bin","contentType":"application/octet-stream"}`), nil, true)
	if initRec.Code != http.StatusCreated {
		t.Fatalf("初始化分片上传失败: %d", initRec.Code)
	}
	var initData struct {
		UploadID string `json:"uploadId"`
	}
	_ = json.NewDecoder(initRec.Body).Decode(&initData)

	part1 := []byte("PART-ONE-DATA-")
	part2 := []byte("PART-TWO-DATA-END")
	for idx, pData := range [][]byte{part1, part2} {
		pRec := doReq(http.MethodPut, "/api/v1/buckets/assets/multipart/"+initData.UploadID+"/"+string(rune('1'+idx)), bytes.NewReader(pData), nil, true)
		if pRec.Code != http.StatusOK {
			t.Fatalf("上传分片 %d 失败: %d %s", idx+1, pRec.Code, pRec.Body.String())
		}
	}

	compRec := doReq(http.MethodPost, "/api/v1/buckets/assets/multipart/"+initData.UploadID+"/complete", nil, nil, true)
	if compRec.Code != http.StatusOK {
		t.Fatalf("合并分片失败: status=%d body=%s", compRec.Code, compRec.Body.String())
	}

	mergedRec := doReq(http.MethodGet, "/raw/assets/videos/clip.bin", nil, nil, false)
	if mergedRec.Code != http.StatusOK || mergedRec.Body.String() != "PART-ONE-DATA-PART-TWO-DATA-END" {
		t.Fatalf("分片合并内容错误: status=%d body=%q", mergedRec.Code, mergedRec.Body.String())
	}

	// 6. 测试 S3 兼容协议层 (/s3)
	s3PutRec := doReq(http.MethodPut, "/s3/assets/s3-folder/test.txt", strings.NewReader("S3 Protocol Content"), nil, true)
	if s3PutRec.Code != http.StatusOK {
		t.Fatalf("S3 PutObject 失败: status=%d body=%s", s3PutRec.Code, s3PutRec.Body.String())
	}

	s3ListRec := doReq(http.MethodGet, "/s3/assets?delimiter=/", nil, nil, true)
	if s3ListRec.Code != http.StatusOK {
		t.Fatalf("S3 ListObjectsV2 失败: %d", s3ListRec.Code)
	}
	if !strings.Contains(s3ListRec.Body.String(), "<Prefix>s3-folder/</Prefix>") {
		t.Fatalf("S3 ListObjectsV2 XML 未包含预期的 CommonPrefixes: %s", s3ListRec.Body.String())
	}

	// 7. 测试内嵌 Vite + React 前端资源挂载与 SPA 回退
	uiRec := doReq(http.MethodGet, "/", nil, nil, false)
	if uiRec.Code != http.StatusOK || !strings.Contains(uiRec.Body.String(), `<div id="root"></div>`) {
		t.Fatalf("内嵌 Vite React 控制台页面响应异常: status=%d body=%s", uiRec.Code, uiRec.Body.String())
	}
}

// TestSecurityAndConsistencyHardening 针对全部 P0/P1/P2 审查项的专项回归测试
func TestSecurityAndConsistencyHardening(t *testing.T) {
	handler, st, ak := setupTestHandler(t)

	doReq := func(method, pathStr string, body io.Reader, headers map[string]string, withAK bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, pathStr, body)
		if withAK {
			req.Header.Set("X-Cos-Access-Key", ak.AccessKey)
			req.Header.Set("X-Cos-Secret-Key", ak.SecretKey)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// 创建测试桶
	doReq(http.MethodPost, "/api/v1/buckets", strings.NewReader(`{"name":"sec-bucket","visibility":"private"}`), nil, true)
	doReq(http.MethodPost, "/api/v1/buckets", strings.NewReader(`{"name":"pub-bucket","visibility":"public-read"}`), nil, true)
	doReq(http.MethodPost, "/api/v1/buckets", strings.NewReader(`{"name":"quota-bucket","visibility":"private","quotaBytes":100}`), nil, true)

	// [P0-1] S3 Signature V2 伪造签名必须被拒绝 (403)，合法 HMAC-SHA1 签名放行 (200)
	t.Run("P0-1_S3_SigV2_Verification", func(t *testing.T) {
		forgedRec := doReq(http.MethodGet, "/s3/sec-bucket", nil, map[string]string{
			"Authorization": "AWS " + ak.AccessKey + ":forged-random-signature",
			"Date":          time.Now().UTC().Format(time.RFC1123),
		}, false)
		if forgedRec.Code != http.StatusForbidden {
			t.Fatalf("P0-1 漏洞未修复: 伪造的 S3 V2 签名应返回 403，实际返回 %d", forgedRec.Code)
		}

		// 构造合法的 S3 V2 签名
		nowStr := time.Now().UTC().Format(time.RFC1123)
		stringToSign := "GET\n\n\n" + nowStr + "\n/s3/sec-bucket"
		mac := hmac.New(sha1.New, []byte(ak.SecretKey))
		mac.Write([]byte(stringToSign))
		validSig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

		validRec := doReq(http.MethodGet, "/s3/sec-bucket", nil, map[string]string{
			"Authorization": "AWS " + ak.AccessKey + ":" + validSig,
			"Date":          nowStr,
		}, false)
		if validRec.Code != http.StatusOK {
			t.Fatalf("合法 S3 V2 签名请求应返回 200，实际返回 %d: %s", validRec.Code, validRec.Body.String())
		}
	})

	// [P0-2] S3 SigV4 预签名过期拦截与 Header 时钟偏移校验
	t.Run("P0-2_S3_SigV4_Expiration_And_ClockSkew", func(t *testing.T) {
		// 1小时前的过期时间戳 (超出 ±15 分钟窗口)
		expiredTime := time.Now().UTC().Add(-1 * time.Hour)
		amzDate := expiredTime.Format("20060102T150405Z")
		dateStamp := expiredTime.Format("20060102")

		// 过期预签名 URL (X-Amz-Expires=60，但 X-Amz-Date 在 1 小时前)
		expiredQuery := fmt.Sprintf("/s3/sec-bucket?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=%s%%2F%s%%2Fus-east-1%%2Fs3%%2Faws4_request&X-Amz-Date=%s&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef",
			ak.AccessKey, dateStamp, amzDate)
		expRec := doReq(http.MethodGet, expiredQuery, nil, nil, false)
		if expRec.Code != http.StatusForbidden {
			t.Fatalf("P0-2 过期预签名 URL 应返回 403，实际返回 %d", expRec.Code)
		}
	})

	// [P0-3] /raw 同源 XSS 防护：nosniff + CSP sandbox + HTML/SVG 强制 attachment
	t.Run("P0-3_Raw_XSS_Protection", func(t *testing.T) {
		xssHTML := `<script>fetch('/api/v1/access-keys')</script>`
		doReq(http.MethodPut, "/api/v1/buckets/pub-bucket/objects/evil.html", strings.NewReader(xssHTML), map[string]string{
			"Content-Type": "text/html",
		}, true)

		rawRec := doReq(http.MethodGet, "/raw/pub-bucket/evil.html?response-content-disposition=inline", nil, nil, false)
		if rawRec.Code != http.StatusOK {
			t.Fatalf("GET /raw/pub-bucket/evil.html failed: %d", rawRec.Code)
		}
		if rawRec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("缺少 X-Content-Type-Options: nosniff")
		}
		if !strings.Contains(rawRec.Header().Get("Content-Security-Policy"), "sandbox") {
			t.Fatalf("缺少 Content-Security-Policy: sandbox，实际: %q", rawRec.Header().Get("Content-Security-Policy"))
		}
		if !strings.HasPrefix(rawRec.Header().Get("Content-Disposition"), "attachment;") {
			t.Fatalf("HTML 高危文件必须强制为 attachment，实际: %q", rawRec.Header().Get("Content-Disposition"))
		}
	})

	// [P0-4 & P1-17 & P1-18] 并发删写、同内容秒传与同 Key 覆盖竞态压测
	t.Run("P0-4_Concurrent_Delete_Write_Race", func(t *testing.T) {
		sharedContent := []byte("Concurrent CAS Race Condition Verification Payload 2026")
		sum := sha256.Sum256(sharedContent)
		shaHex := hex.EncodeToString(sum[:])

		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				key := fmt.Sprintf("race/file-%d.txt", id%4) // 故意让多个 goroutine 并发覆盖相同的 4 个 key
				for iter := 0; iter < 5; iter++ {
					rec := doReq(http.MethodPut, "/api/v1/buckets/pub-bucket/objects/"+key, bytes.NewReader(sharedContent), nil, true)
					if rec.Code != http.StatusOK {
						t.Errorf("并发写入失败: status=%d body=%s", rec.Code, rec.Body.String())
					}
					if iter%2 == 0 {
						delRec := doReq(http.MethodDelete, "/api/v1/buckets/pub-bucket/objects/"+key, nil, nil, true)
						if delRec.Code != http.StatusOK && delRec.Code != http.StatusNotFound {
							t.Errorf("并发删除异常: status=%d body=%s", delRec.Code, delRec.Body.String())
						}
					} else {
						fastBody := fmt.Sprintf(`{"key":%q,"sha256":%q}`, key, shaHex)
						fRec := doReq(http.MethodPost, "/api/v1/buckets/pub-bucket/fast-upload", strings.NewReader(fastBody), nil, true)
						if fRec.Code != http.StatusOK {
							t.Errorf("并发秒传异常: status=%d body=%s", fRec.Code, fRec.Body.String())
						}
					}
				}
			}(i)
		}
		wg.Wait()

		// 最终再写入一次并立即读取，确保物理块完好无损且可读
		finalPut := doReq(http.MethodPut, "/api/v1/buckets/pub-bucket/objects/race/final.txt", bytes.NewReader(sharedContent), nil, true)
		if finalPut.Code != http.StatusOK {
			t.Fatalf("最终写入失败: %d %s", finalPut.Code, finalPut.Body.String())
		}
		finalGet := doReq(http.MethodGet, "/raw/pub-bucket/race/final.txt", nil, nil, false)
		if finalGet.Code != http.StatusOK || !bytes.Equal(finalGet.Body.Bytes(), sharedContent) {
			t.Fatalf("并发删写后物理块损坏或丢失! status=%d body=%q", finalGet.Code, finalGet.Body.String())
		}
	})

	// [P0-5] X-Amz-Content-Sha256 校验与 STREAMING-AWS4-HMAC-SHA256-PAYLOAD 解码
	t.Run("P0-5_Integrity_And_AWS_Chunked_Decoding", func(t *testing.T) {
		// 1. 错误的 SHA-256 声明应返回 400
		badHashRec := doReq(http.MethodPut, "/s3/sec-bucket/bad-hash.txt", strings.NewReader("hello"), map[string]string{
			"X-Amz-Content-Sha256": strings.Repeat("0", 64),
		}, true)
		if badHashRec.Code != http.StatusBadRequest {
			t.Fatalf("错误的 X-Amz-Content-Sha256 应返回 400，实际返回 %d", badHashRec.Code)
		}

		// 2. STREAMING-AWS4-HMAC-SHA256-PAYLOAD (aws-chunked) 自动去帧头解码
		chunkedStream := "5;chunk-signature=abcdef\r\nHello\r\n6;chunk-signature=123456\r\n World\r\n0;chunk-signature=000000\r\n\r\n"
		streamRec := doReq(http.MethodPut, "/s3/pub-bucket/chunked-stream.txt", strings.NewReader(chunkedStream), map[string]string{
			"X-Amz-Content-Sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
		}, true)
		if streamRec.Code != http.StatusOK {
			t.Fatalf("aws-chunked 流上传失败: %d %s", streamRec.Code, streamRec.Body.String())
		}
		getStreamRec := doReq(http.MethodGet, "/raw/pub-bucket/chunked-stream.txt", nil, nil, false)
		if getStreamRec.Body.String() != "Hello World" {
			t.Fatalf("aws-chunked 解码后内容不匹配，期望 'Hello World'，实际 %q", getStreamRec.Body.String())
		}
	})

	// [P0-6] 配额超限拦截 (返回 507 InsufficientStorage，且不残留孤儿物理块)
	t.Run("P0-6_Bucket_Quota_Enforcement", func(t *testing.T) {
		overQuotaPayload := bytes.Repeat([]byte("A"), 200) // quota-bucket 配额为 100 字节
		qRec := doReq(http.MethodPut, "/s3/quota-bucket/too-big.bin", bytes.NewReader(overQuotaPayload), nil, true)
		if qRec.Code != http.StatusInsufficientStorage {
			t.Fatalf("S3 超出存储桶配额应返回 507，实际返回 %d: %s", qRec.Code, qRec.Body.String())
		}
		sum := sha256.Sum256(overQuotaPayload)
		if st.CAS().HasBlob(hex.EncodeToString(sum[:])) {
			t.Fatalf("配额超限被拒后磁盘上不应残留未引用的孤儿 blob 文件")
		}
	})

	// [P0-7] 文件夹删除区分大小写且不把 %/_ 当作通配符
	t.Run("P0-7_Folder_Delete_Case_And_Wildcard_Safety", func(t *testing.T) {
		doReq(http.MethodPut, "/api/v1/buckets/sec-bucket/objects/docs/a.txt", strings.NewReader("lower"), nil, true)
		doReq(http.MethodPut, "/api/v1/buckets/sec-bucket/objects/Docs/b.txt", strings.NewReader("upper"), nil, true)
		doReq(http.MethodPut, "/api/v1/buckets/sec-bucket/objects/a%25/c.txt", strings.NewReader("percent"), nil, true)
		doReq(http.MethodPut, "/api/v1/buckets/sec-bucket/objects/apple/d.txt", strings.NewReader("apple"), nil, true)

		// 删除 docs/ 不应误删 Docs/b.txt
		doReq(http.MethodDelete, "/api/v1/buckets/sec-bucket/objects?key=docs/", nil, nil, true)
		if _, err := st.GetObject("sec-bucket", "Docs/b.txt"); err != nil {
			t.Fatalf("P0-7 删除 docs/ 误删了区分大小写的 Docs/b.txt: %v", err)
		}

		// 删除 a%/ 不应误删 apple/d.txt
		doReq(http.MethodDelete, "/api/v1/buckets/sec-bucket/objects?key="+url.QueryEscape("a%/"), nil, nil, true)
		if _, err := st.GetObject("sec-bucket", "apple/d.txt"); err != nil {
			t.Fatalf("P0-7 删除 a%%/ 把 %% 当成通配符误删了 apple/d.txt: %v", err)
		}
	})

	// [P0-8] 尾部斜杠 key 在 chunked 模式下创建目录，非空内容带尾部斜杠拒绝
	t.Run("P0-8_Trailing_Slash_Key_Handling", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/s3/sec-bucket/chunked-dir/", strings.NewReader(""))
		req.ContentLength = -1 // 模拟 Transfer-Encoding: chunked
		req.Header.Set("X-Cos-Access-Key", ak.AccessKey)
		req.Header.Set("X-Cos-Secret-Key", ak.SecretKey)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("chunked 空流 PUT 尾部斜杠目录失败: %d %s", rec.Code, rec.Body.String())
		}
		obj, err := st.GetObject("sec-bucket", "chunked-dir/")
		if err != nil || !obj.IsFolder {
			t.Fatalf("预期创建文件夹 chunked-dir/，实际 err=%v obj=%+v", err, obj)
		}
	})

	// [P1-9] 分片上传跨桶越权隔离
	t.Run("P1-9_Multipart_Cross_Bucket_Isolation", func(t *testing.T) {
		initRec := doReq(http.MethodPost, "/api/v1/buckets/sec-bucket/multipart/init", strings.NewReader(`{"key":"secret.bin"}`), nil, true)
		var initData struct {
			UploadID string `json:"uploadId"`
		}
		_ = json.NewDecoder(initRec.Body).Decode(&initData)

		// 尝试通过 pub-bucket 操作 sec-bucket 的 uploadId，必须返回 404
		crossStatus := doReq(http.MethodGet, "/api/v1/buckets/pub-bucket/multipart/"+initData.UploadID, nil, nil, true)
		if crossStatus.Code != http.StatusNotFound {
			t.Fatalf("P1-9 跨桶查询 uploadId 应返回 404，实际返回 %d", crossStatus.Code)
		}
		crossPart := doReq(http.MethodPut, "/api/v1/buckets/pub-bucket/multipart/"+initData.UploadID+"/1", strings.NewReader("data"), nil, true)
		if crossPart.Code != http.StatusNotFound {
			t.Fatalf("P1-9 跨桶上传分片应返回 404，实际返回 %d", crossPart.Code)
		}
	})

	// [P1-13] 未匹配的 /api/* 路由返回 404 JSON 而非 200 HTML
	t.Run("P1-13_Unmatched_API_Returns_404_JSON", func(t *testing.T) {
		notFoundRec := doReq(http.MethodGet, "/api/v1/non-existent-endpoint", nil, nil, true)
		if notFoundRec.Code != http.StatusNotFound || !strings.Contains(notFoundRec.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("P1-13 未匹配 API 应返回 404 JSON，实际 status=%d content-type=%s", notFoundRec.Code, notFoundRec.Header().Get("Content-Type"))
		}
	})

	// [P1-16] 登出立即吊销 Token & 受限桶 Admin AK 权限边界
	t.Run("P1-16_Logout_Token_Revocation_And_Scoped_AK", func(t *testing.T) {
		loginRec := doReq(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"secretpass"}`), nil, false)
		var loginData struct {
			Token string `json:"token"`
		}
		_ = json.NewDecoder(loginRec.Body).Decode(&loginData)

		// 登出吊销
		doReq(http.MethodPost, "/api/v1/auth/logout", nil, map[string]string{
			"Authorization": "Bearer " + loginData.Token,
		}, false)

		meRec := doReq(http.MethodGet, "/api/v1/auth/me", nil, map[string]string{
			"Authorization": "Bearer " + loginData.Token,
		}, false)
		if meRec.Code != http.StatusUnauthorized {
			t.Fatalf("P1-16 登出后的 Token 应立即失效返回 401，实际返回 %d", meRec.Code)
		}

		// 创建仅允许访问 pub-bucket 但 permission=admin 的受限密钥
		scopedAK, err := st.CreateAccessKey("scoped-admin", "pub-bucket", "admin")
		if err != nil {
			t.Fatalf("CreateAccessKey failed: %v", err)
		}
		if scopedAK.CanAccessBucket("sec-bucket", false) {
			t.Fatalf("P1-16 限定了 allowedBuckets='pub-bucket' 的密钥不应拥有 sec-bucket 访问权")
		}
	})

	// [Admin Account] 首次随机密码生成、后续启动不暴露密码、CLI 重置密码使旧会话立即失效
	t.Run("Admin_RandomInit_And_Passwd_Reset", func(t *testing.T) {
		u1, pass1, created1, err := st.EnsureAdminAccount("", "")
		if err != nil || !created1 || u1 != "admin" || len(pass1) != 16 {
			t.Fatalf("首次初始化管理员失败: u=%q len(pass)=%d created=%v err=%v", u1, len(pass1), created1, err)
		}

		// 第二次启动不再返回明文密码
		u2, pass2, created2, err := st.EnsureAdminAccount("", "")
		if err != nil || created2 || u2 != "admin" || pass2 != "" {
			t.Fatalf("非首次启动不应返回明文密码: u=%q pass=%q created=%v err=%v", u2, pass2, created2, err)
		}

		// 使用首次生成的随机密码登录
		loginRec := doReq(http.MethodPost, "/api/v1/auth/login", strings.NewReader(fmt.Sprintf(`{"username":%q,"password":%q}`, u1, pass1)), nil, false)
		if loginRec.Code != http.StatusOK {
			t.Fatalf("使用初始随机密码登录失败: %d %s", loginRec.Code, loginRec.Body.String())
		}
		var loginData struct {
			Token string `json:"token"`
		}
		_ = json.NewDecoder(loginRec.Body).Decode(&loginData)

		// 模拟执行 `cosd passwd -user superuser -pass NewStrongPass99`
		newU, newP, err := st.ResetAdminCredentials("superuser", "NewStrongPass99")
		if err != nil || newU != "superuser" || newP != "NewStrongPass99" {
			t.Fatalf("ResetAdminCredentials failed: %v", err)
		}

		// 旧 Token 因 token_version 递增应立即失效 (401)
		oldMeRec := doReq(http.MethodGet, "/api/v1/auth/me", nil, map[string]string{
			"Authorization": "Bearer " + loginData.Token,
		}, false)
		if oldMeRec.Code != http.StatusUnauthorized {
			t.Fatalf("修改管理员密码后旧 Token 应立即失效返回 401，实际返回 %d", oldMeRec.Code)
		}

		// 使用新用户名和新密码登录应成功
		newLoginRec := doReq(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"superuser","password":"NewStrongPass99"}`), nil, false)
		if newLoginRec.Code != http.StatusOK {
			t.Fatalf("使用重置后的新用户名密码登录失败: %d %s", newLoginRec.Code, newLoginRec.Body.String())
		}
	})
}

func TestSecondRoundAuditFixes(t *testing.T) {
	handler, st, ak := setupTestHandler(t)

	doReqWithAK := func(method, target string, body io.Reader, headers map[string]string, key *store.AccessKey) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, body)
		if key != nil {
			req.Header.Set("X-Cos-Access-Key", key.AccessKey)
			req.Header.Set("X-Cos-Secret-Key", key.SecretKey)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	if _, err := st.CreateBucket("list-bucket", "private", 0, "*"); err != nil {
		t.Fatalf("CreateBucket list-bucket failed: %v", err)
	}
	if _, err := st.CreateBucket("priv-a", "private", 0, "*"); err != nil {
		t.Fatalf("CreateBucket priv-a failed: %v", err)
	}
	if _, err := st.CreateBucket("priv-b", "private", 0, "*"); err != nil {
		t.Fatalf("CreateBucket priv-b failed: %v", err)
	}
	if _, err := st.CreateBucket("mp-quota", "private", 100, "*"); err != nil {
		t.Fatalf("CreateBucket mp-quota failed: %v", err)
	}

	// [P1-1] S3 ListObjects + delimiter + max-keys=1 分页游标不死循环
	t.Run("P1-1_S3_ListObjects_Delimiter_Pagination_NoLoop", func(t *testing.T) {
		for _, k := range []string{"dir/a.txt", "dir/b.txt", "z1.txt", "z2.txt"} {
			if _, err := st.PutObjectFromStream("list-bucket", k, strings.NewReader("data-"+k), "text/plain", nil); err != nil {
				t.Fatalf("PutObject %s failed: %v", k, err)
			}
		}

		// Page 0: after="" -> cps=[dir/], truncated=true
		p0, err := st.ListObjectsS3("list-bucket", "", "/", 1, "")
		if err != nil {
			t.Fatalf("Page 0 failed: %v", err)
		}
		if len(p0.CommonPrefixes) != 1 || p0.CommonPrefixes[0] != "dir/" || len(p0.Objects) != 0 || !p0.IsTruncated {
			t.Fatalf("Page 0 结果异常: %+v", p0)
		}

		// Page 1: after=p0.NextToken -> objects=[z1.txt], truncated=true (绝不再次返回 dir/)
		p1, err := st.ListObjectsS3("list-bucket", "", "/", 1, p0.NextToken)
		if err != nil {
			t.Fatalf("Page 1 failed: %v", err)
		}
		if len(p1.CommonPrefixes) != 0 || len(p1.Objects) != 1 || p1.Objects[0].Key != "z1.txt" || !p1.IsTruncated {
			t.Fatalf("Page 1 出现重复前缀或游标死循环: %+v", p1)
		}

		// Page 2: after=p1.NextToken -> objects=[z2.txt], truncated=false
		p2, err := st.ListObjectsS3("list-bucket", "", "/", 1, p1.NextToken)
		if err != nil {
			t.Fatalf("Page 2 failed: %v", err)
		}
		if len(p2.CommonPrefixes) != 0 || len(p2.Objects) != 1 || p2.Objects[0].Key != "z2.txt" || p2.IsTruncated {
			t.Fatalf("Page 2 结果异常: %+v", p2)
		}

		// 兼容 S3 V1 客户端直接将 CommonPrefix "dir/" 作为 marker/startAfter 传入
		pMarker, err := st.ListObjectsS3("list-bucket", "", "/", 1, "dir/")
		if err != nil {
			t.Fatalf("pMarker failed: %v", err)
		}
		if len(pMarker.Objects) != 1 || pMarker.Objects[0].Key != "z1.txt" {
			t.Fatalf("传入 marker='dir/' 时应跳过 dir/* 直接返回 z1.txt，实际: %+v", pMarker)
		}
	})

	// [P1-2] S3 DELETE /s3/{bucket}/dir/ 默认只删目录 marker，保留子对象
	t.Run("P1-2_S3_Delete_Folder_Marker_Preserves_Children", func(t *testing.T) {
		_, _ = st.CreateFolder("list-bucket", "keepdir/")
		_, _ = st.PutObjectFromStream("list-bucket", "keepdir/child.txt", strings.NewReader("important-data"), "text/plain", nil)

		delRec := doReqWithAK(http.MethodDelete, "/s3/list-bucket/keepdir/", nil, nil, ak)
		if delRec.Code != http.StatusNoContent {
			t.Fatalf("S3 DELETE keepdir/ failed: %d", delRec.Code)
		}
		if _, err := st.GetObject("list-bucket", "keepdir/child.txt"); err != nil {
			t.Fatalf("P1-2 S3 DELETE /s3/list-bucket/keepdir/ 误删了子对象 keepdir/child.txt: %v", err)
		}
	})

	// [P1-3] 秒传 TryFastUpload 跨租户隔离：受限 AK 不能通过 SHA-256 绑定其他私有桶的数据
	t.Run("P1-3_FastUpload_Scoped_Tenant_Isolation", func(t *testing.T) {
		secretContent := "tenant-a-confidential-document-2026"
		secretObj, err := st.PutObjectFromStream("priv-a", "secret.txt", strings.NewReader(secretContent), "text/plain", nil)
		if err != nil {
			t.Fatalf("PutObject priv-a failed: %v", err)
		}

		// 创建仅允许访问 priv-b 的受限 AK
		tenantBAK, err := st.CreateAccessKey("tenant-b", "priv-b", "readwrite")
		if err != nil {
			t.Fatalf("CreateAccessKey tenant-b failed: %v", err)
		}

		// tenant-b 尝试用 priv-a 私有文件的 SHA-256 秒传到 priv-b -> 必须返回 fastUploaded=false
		fastBody := fmt.Sprintf(`{"key":"stolen.txt","sha256":%q}`, secretObj.BlobSHA256)
		fastRec := doReqWithAK(http.MethodPost, "/api/v1/buckets/priv-b/fast-upload", strings.NewReader(fastBody), map[string]string{
			"Content-Type": "application/json",
		}, tenantBAK)
		if fastRec.Code != http.StatusOK {
			t.Fatalf("fast-upload status=%d body=%s", fastRec.Code, fastRec.Body.String())
		}
		var fastResp struct {
			FastUploaded bool `json:"fastUploaded"`
		}
		_ = json.NewDecoder(fastRec.Body).Decode(&fastResp)
		if fastResp.FastUploaded {
			t.Fatalf("P1-3 漏洞未修复：受限 AK 竟能通过秒传跨桶窃取 priv-a 的私有物理块！")
		}

		// 全局 AK 秒传同一物理块应成功
		adminFastRec := doReqWithAK(http.MethodPost, "/api/v1/buckets/priv-b/fast-upload", strings.NewReader(fastBody), map[string]string{
			"Content-Type": "application/json",
		}, ak)
		_ = json.NewDecoder(adminFastRec.Body).Decode(&fastResp)
		if !fastResp.FastUploaded {
			t.Fatalf("全局管理员 AK 秒传应命中成功")
		}
	})

	// [P2-4] 登出吊销持久化落库，模拟重启后依然拒绝
	t.Run("P2-4_Persistent_Revoked_Token_Across_Restart", func(t *testing.T) {
		cfg := &config.Config{AdminUser: "admin", AdminPass: "secretpass", SecretKey: "restart-test-secret"}
		auth1 := auth.NewAuthService(cfg, st)
		tok := auth1.GenerateAdminToken(time.Hour)
		if !auth1.VerifyAdminToken(tok) {
			t.Fatalf("新签发的 Token 校验应通过")
		}
		auth1.RevokeAdminToken(tok)

		// 创建全新的 AuthService 实例模拟进程重启（内存 map 为空）
		authAfterRestart := auth.NewAuthService(cfg, st)
		if authAfterRestart.VerifyAdminToken(tok) {
			t.Fatalf("P2-4 漏洞未修复：服务重启后已登出的 Token 重新生效了！")
		}
	})

	// [P2-5] 登录防爆破不信任未受控连接的伪造 X-Forwarded-For
	t.Run("P2-5_Login_RateLimit_Ignores_Spoofed_XFF", func(t *testing.T) {
		for i := 1; i <= 10; i++ {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"wrong"}`))
			req.RemoteAddr = "198.51.100.77:54321"
			req.Header.Set("X-Forwarded-For", fmt.Sprintf("10.99.0.%d", i))
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("第 %d 次错误登录预期 401，实际 %d", i, rec.Code)
			}
		}
		// 第 11 次再换一个新的伪造 XFF，依然必须触发 429 锁定
		req11 := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"wrong"}`))
		req11.RemoteAddr = "198.51.100.77:54321"
		req11.Header.Set("X-Forwarded-For", "10.99.0.250")
		rec11 := httptest.NewRecorder()
		handler.ServeHTTP(rec11, req11)
		if rec11.Code != http.StatusTooManyRequests {
			t.Fatalf("P2-5 伪造 X-Forwarded-For 绕过了登录限流，期望 429，实际 %d", rec11.Code)
		}
	})

	// [P2-6] 分片上传暂存分片计入存储桶配额
	t.Run("P2-6_Multipart_Staged_Parts_Counted_In_Quota", func(t *testing.T) {
		u, err := st.InitiateMultipartUpload("mp-quota", "staged.bin", "application/octet-stream", nil)
		if err != nil {
			t.Fatalf("InitiateMultipartUpload failed: %v", err)
		}
		// mp-quota 配额 100 字节，先传 Part 1 (60 字节) -> 成功
		part1Rec := doReqWithAK(http.MethodPut, fmt.Sprintf("/s3/mp-quota/staged.bin?uploadId=%s&partNumber=1", u.UploadID), strings.NewReader(strings.Repeat("A", 60)), nil, ak)
		if part1Rec.Code != http.StatusOK {
			t.Fatalf("Part 1 (60B) 应成功，实际 %d: %s", part1Rec.Code, part1Rec.Body.String())
		}
		// 再传 Part 2 (60 字节)，因已暂存 60B + 新增 60B > 100B 配额，必须返回 507
		part2Rec := doReqWithAK(http.MethodPut, fmt.Sprintf("/s3/mp-quota/staged.bin?uploadId=%s&partNumber=2", u.UploadID), strings.NewReader(strings.Repeat("B", 60)), nil, ak)
		if part2Rec.Code != http.StatusInsufficientStorage {
			t.Fatalf("P2-6 暂存分片未计入配额，期望 507，实际 %d", part2Rec.Code)
		}
	})

	// [P2-7] CommitTempBlob 自动检测并修复磁盘上被截断/0字节的损坏物理块
	t.Run("P2-7_CommitTempBlob_SelfHeals_Corrupted_Blob", func(t *testing.T) {
		payload := "self-healing-cas-blob-content-verification"
		obj, err := st.PutObjectFromStream("list-bucket", "heal-1.txt", strings.NewReader(payload), "text/plain", nil)
		if err != nil {
			t.Fatalf("PutObject heal-1 failed: %v", err)
		}
		// 模拟掉电导致磁盘上的物理块文件变成 0 字节
		blobPath, err := st.CAS().BlobPath(obj.BlobSHA256)
		if err != nil {
			t.Fatalf("BlobPath failed: %v", err)
		}
		if err := os.Truncate(blobPath, 0); err != nil {
			t.Fatalf("Truncate blob failed: %v", err)
		}
		// 重新上传相同内容，CommitTempBlob 发现磁盘文件大小(0) != expectedSize，自动覆盖修复
		if _, err := st.PutObjectFromStream("list-bucket", "heal-2.txt", strings.NewReader(payload), "text/plain", nil); err != nil {
			t.Fatalf("Re-upload heal-2 failed: %v", err)
		}
		getRec := doReqWithAK(http.MethodGet, "/raw/list-bucket/heal-1.txt", nil, nil, ak)
		if getRec.Body.String() != payload {
			t.Fatalf("P2-7 损坏的 0 字节物理块未被修复，读取内容=%q", getRec.Body.String())
		}
	})

	// [P2-10 & P3] aws-chunked 解码长度校验 & x-amz-meta-* 响应头回写
	t.Run("P2-10_AWSChunked_Length_Check_And_CustomMeta_Response", func(t *testing.T) {
		chunkedStream := "5;chunk-signature=abcdef\r\nHello\r\n0;chunk-signature=000000\r\n\r\n"
		badLenRec := doReqWithAK(http.MethodPut, "/s3/list-bucket/bad-decoded-len.txt", strings.NewReader(chunkedStream), map[string]string{
			"X-Amz-Content-Sha256":         "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
			"X-Amz-Decoded-Content-Length": "99", // 实际只有 5 字节
		}, ak)
		if badLenRec.Code != http.StatusBadRequest {
			t.Fatalf("P2-10 X-Amz-Decoded-Content-Length 不匹配应返回 400，实际 %d", badLenRec.Code)
		}

		// 测试 x-amz-meta-* 上传后在 GET 响应头原样返回
		putMetaRec := doReqWithAK(http.MethodPut, "/s3/list-bucket/with-meta.txt", strings.NewReader("meta-body"), map[string]string{
			"x-amz-meta-project": "nanocos-v2",
		}, ak)
		if putMetaRec.Code != http.StatusOK {
			t.Fatalf("PUT with-meta.txt failed: %d", putMetaRec.Code)
		}
		getMetaRec := doReqWithAK(http.MethodGet, "/s3/list-bucket/with-meta.txt", nil, nil, ak)
		if got := getMetaRec.Header().Get("x-amz-meta-project"); got != "nanocos-v2" {
			t.Fatalf("GET 响应头缺少 x-amz-meta-project，期望 'nanocos-v2'，实际 %q", got)
		}
	})

	// [P2-11] AWS Signature V4 Header 正向校验、篡改拦截与过期时钟偏移拦截
	t.Run("P2-11_AWS_SigV4_Header_Positive_And_Negative", func(t *testing.T) {
		signV4Req := func(method, pathStr string, body []byte, amzDate string) *http.Request {
			req := httptest.NewRequest(method, "http://localhost:9000"+pathStr, bytes.NewReader(body))
			req.Host = "localhost:9000"
			sum := sha256.Sum256(body)
			payloadHash := hex.EncodeToString(sum[:])
			req.Header.Set("X-Amz-Date", amzDate)
			req.Header.Set("X-Amz-Content-Sha256", payloadHash)

			dateStamp := amzDate[:8]
			canonicalHeaders := fmt.Sprintf("host:localhost:9000\nx-amz-content-sha256:%s\nx-amz-date:%s\n", payloadHash, amzDate)
			signedHeaders := "host;x-amz-content-sha256;x-amz-date"
			canonicalReq := strings.Join([]string{
				method,
				pathStr,
				"",
				canonicalHeaders,
				signedHeaders,
				payloadHash,
			}, "\n")
			cHash := sha256.Sum256([]byte(canonicalReq))
			scope := fmt.Sprintf("%s/us-east-1/s3/aws4_request", dateStamp)
			stringToSign := strings.Join([]string{
				"AWS4-HMAC-SHA256",
				amzDate,
				scope,
				hex.EncodeToString(cHash[:]),
			}, "\n")

			hmac256 := func(key []byte, data string) []byte {
				m := hmac.New(sha256.New, key)
				m.Write([]byte(data))
				return m.Sum(nil)
			}
			kDate := hmac256([]byte("AWS4"+ak.SecretKey), dateStamp)
			kRegion := hmac256(kDate, "us-east-1")
			kService := hmac256(kRegion, "s3")
			kSigning := hmac256(kService, "aws4_request")
			sig := hex.EncodeToString(hmac256(kSigning, stringToSign))

			req.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", ak.AccessKey, scope, signedHeaders, sig))
			return req
		}

		nowAmz := time.Now().UTC().Format("20060102T150405Z")
		validReq := signV4Req(http.MethodPut, "/s3/list-bucket/sigv4-ok.txt", []byte("sigv4-payload"), nowAmz)
		validRec := httptest.NewRecorder()
		handler.ServeHTTP(validRec, validReq)
		if validRec.Code != http.StatusOK {
			t.Fatalf("合法 SigV4 Header 请求应返回 200，实际 %d: %s", validRec.Code, validRec.Body.String())
		}

		// 篡改签名最后一位 -> 403
		tamperedReq := signV4Req(http.MethodGet, "/s3/list-bucket/sigv4-ok.txt", nil, nowAmz)
		tamperedReq.Header.Set("Authorization", tamperedReq.Header.Get("Authorization")+"0")
		tamperedRec := httptest.NewRecorder()
		handler.ServeHTTP(tamperedRec, tamperedReq)
		if tamperedRec.Code != http.StatusForbidden {
			t.Fatalf("篡改后的 SigV4 签名应返回 403，实际 %d", tamperedRec.Code)
		}

		// 超出 ±15 分钟时钟窗口的旧签名重放 -> 403
		staleAmz := time.Now().UTC().Add(-1 * time.Hour).Format("20060102T150405Z")
		staleReq := signV4Req(http.MethodGet, "/s3/list-bucket/sigv4-ok.txt", nil, staleAmz)
		staleRec := httptest.NewRecorder()
		handler.ServeHTTP(staleRec, staleReq)
		if staleRec.Code != http.StatusForbidden {
			t.Fatalf("超出 15 分钟窗口的 SigV4 重放请求应返回 403，实际 %d", staleRec.Code)
		}

		// 路径含字面量 %2F 的 SigV4 签名校验
		encodedPathReq := signV4Req(http.MethodPut, "/s3/list-bucket/dir%2Fencoded-slash.txt", []byte("slash-payload"), nowAmz)
		encodedPathRec := httptest.NewRecorder()
		handler.ServeHTTP(encodedPathRec, encodedPathReq)
		if encodedPathRec.Code != http.StatusOK {
			t.Fatalf("含字面量 %%2F 的 SigV4 请求应返回 200，实际 %d: %s", encodedPathRec.Code, encodedPathRec.Body.String())
		}
	})

	// [Operability & S3 Edge Cases] /healthz、/readyz、/metrics、Virtual-Host CreateBucket、x-amz-checksum-sha256、热备与结构化错误码
	t.Run("Operability_Healthz_Readyz_Backup_And_ErrorCode", func(t *testing.T) {
		hzRec := doReqWithAK(http.MethodGet, "/healthz", nil, nil, nil)
		if hzRec.Code != http.StatusOK || !strings.Contains(hzRec.Body.String(), `"status":"ok"`) {
			t.Fatalf("/healthz 应免鉴权返回 200 status=ok，实际 %d: %s", hzRec.Code, hzRec.Body.String())
		}
		rzRec := doReqWithAK(http.MethodGet, "/readyz", nil, nil, nil)
		if rzRec.Code != http.StatusOK || !strings.Contains(rzRec.Body.String(), `"status":"ready"`) || !strings.Contains(rzRec.Body.String(), `"reconciling"`) {
			t.Fatalf("/readyz 应免鉴权返回 200 status=ready 且含 reconciling，实际 %d: %s", rzRec.Code, rzRec.Body.String())
		}
		metricsRec := doReqWithAK(http.MethodGet, "/metrics", nil, nil, nil)
		if metricsRec.Code != http.StatusOK || !strings.Contains(metricsRec.Body.String(), "nanocos_up 1") || !strings.Contains(metricsRec.Body.String(), "nanocos_http_requests_total") {
			t.Fatalf("/metrics 应返回 Prometheus 文本指标，实际 %d: %s", metricsRec.Code, metricsRec.Body.String())
		}

		// 验证 Virtual-Host 风格对尚未存在的存储桶执行 CreateBucket (PUT / with Host: vhost-new.localhost:9000)
		vhReq := httptest.NewRequest(http.MethodPut, "http://vhost-new.localhost:9000/", nil)
		vhReq.Host = "vhost-new.localhost:9000"
		vhReq.Header.Set("X-Amz-Date", time.Now().UTC().Format("20060102T150405Z"))
		vhReq.Header.Set("X-Cos-Access-Key", ak.AccessKey)
		vhReq.Header.Set("X-Cos-Secret-Key", ak.SecretKey)
		vhRec := httptest.NewRecorder()
		handler.ServeHTTP(vhRec, vhReq)
		if vhRec.Code != http.StatusOK {
			t.Fatalf("Virtual-Host CreateBucket 应返回 200，实际 %d: %s", vhRec.Code, vhRec.Body.String())
		}
		if _, err := st.GetBucket("vhost-new"); err != nil {
			t.Fatalf("Virtual-Host CreateBucket 后未找到存储桶 vhost-new: %v", err)
		}

		// 验证 S3 x-amz-checksum-sha256 请求头校验与响应头回写
		chkBody := []byte("checksum-sha256-verified-payload")
		chkSum := sha256.Sum256(chkBody)
		chkB64 := base64.StdEncoding.EncodeToString(chkSum[:])
		chkOkRec := doReqWithAK(http.MethodPut, "/s3/vhost-new/chk.txt", bytes.NewReader(chkBody), map[string]string{
			"x-amz-checksum-sha256": chkB64,
		}, ak)
		if chkOkRec.Code != http.StatusOK || chkOkRec.Header().Get("x-amz-checksum-sha256") != chkB64 {
			t.Fatalf("合法 x-amz-checksum-sha256 应返回 200 并回写响应头，实际 %d (hdr=%q)", chkOkRec.Code, chkOkRec.Header().Get("x-amz-checksum-sha256"))
		}
		badSum := sha256.Sum256([]byte("tampered"))
		chkBadRec := doReqWithAK(http.MethodPut, "/s3/vhost-new/chk-bad.txt", bytes.NewReader(chkBody), map[string]string{
			"x-amz-checksum-sha256": base64.StdEncoding.EncodeToString(badSum[:]),
		}, ak)
		if chkBadRec.Code != http.StatusBadRequest {
			t.Fatalf("错误的 x-amz-checksum-sha256 应返回 400，实际 %d", chkBadRec.Code)
		}

		// 验证 REST API 错误体同时包含稳定的机器码 code 与中文描述 error
		errRec := doReqWithAK(http.MethodGet, "/api/v1/buckets/non-existent-bucket/objects", nil, nil, ak)
		if errRec.Code != http.StatusNotFound {
			t.Fatalf("查询不存在桶应返回 404，实际 %d", errRec.Code)
		}
		var errBody struct {
			Code  string `json:"code"`
			Error string `json:"error"`
		}
		_ = json.NewDecoder(errRec.Body).Decode(&errBody)
		if errBody.Code != "NoSuchBucket" || errBody.Error == "" {
			t.Fatalf("REST 错误响应应包含 code='NoSuchBucket'，实际: %+v", errBody)
		}

		// 验证管理员在线热备份 API
		backupOut := t.TempDir()
		bkBody := fmt.Sprintf(`{"targetDir":%q}`, backupOut)
		bkRec := doReqWithAK(http.MethodPost, "/api/v1/admin/backup", strings.NewReader(bkBody), map[string]string{
			"Content-Type": "application/json",
		}, ak)
		if bkRec.Code != http.StatusOK {
			t.Fatalf("POST /api/v1/admin/backup 失败: %d %s", bkRec.Code, bkRec.Body.String())
		}
	})
}
