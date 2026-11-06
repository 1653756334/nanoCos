package auth

import (
	"encoding/hex"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"nanocos/internal/config"
	"nanocos/internal/store"
)

func TestAWSSigV4OfficialVectorsAndHelpers(t *testing.T) {
	// 1. 验证 RFC 3986 URI 百分号编码规则与 %2F 字面量保留
	if got := s3PercentEncode("a b+c~d/e"); got != "a%20b%2Bc~d%2Fe" {
		t.Fatalf("s3PercentEncode = %q, want 'a%%20b%%2Bc~d%%2Fe'", got)
	}
	if got := s3URIPath("/bucket/my key+1.txt"); got != "/bucket/my%20key%2B1.txt" {
		t.Fatalf("s3URIPath = %q, want '/bucket/my%%20key%%2B1.txt'", got)
	}
	parsedURL, err := url.Parse("http://localhost:9000/s3/mybucket/a%2Fb/c+d.txt")
	if err != nil {
		t.Fatalf("url.Parse failed: %v", err)
	}
	if got := s3CanonicalURI(parsedURL); got != "/s3/mybucket/a%2Fb/c%2Bd.txt" {
		t.Fatalf("s3CanonicalURI 应当保留字面量 %%2F，got %q, want '/s3/mybucket/a%%2Fb/c%%2Bd.txt'", got)
	}

	// 2. 验证 AWS S3 官方文档标准测试向量 (Known-Answer Test Vector)
	// 参考 AWS S3 SigV4 官方规范:
	// SecretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" (S3 文档向量)
	// Date = 20130524T000000Z, Region = us-east-1, Service = s3
	// GET https://examplebucket.s3.amazonaws.com/test.txt (Range: bytes=0-9)
	const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
	kSigning := deriveS3SigningKey(awsSecret, "20130524", "us-east-1", "s3")
	if len(kSigning) != 32 {
		t.Fatalf("deriveS3SigningKey 长度应为 32 字节")
	}

	awsReq := httptest.NewRequest("GET", "http://examplebucket.s3.amazonaws.com/test.txt", nil)
	awsReq.Host = "examplebucket.s3.amazonaws.com"
	awsReq.Header.Set("Range", "bytes=0-9")
	awsReq.Header.Set("x-amz-content-sha256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
	awsReq.Header.Set("x-amz-date", "20130524T000000Z")
	gotSig := computeS3SigV4(
		awsReq,
		awsSecret,
		"20130524",
		"us-east-1",
		"s3",
		"host;range;x-amz-content-sha256;x-amz-date",
		"20130524T000000Z",
		false,
	)
	const wantOfficialGetSig = "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if gotSig != wantOfficialGetSig {
		t.Fatalf("AWS S3 官方 GET 测试向量签名不匹配:\n got: %s\nwant: %s", gotSig, wantOfficialGetSig)
	}

	// 3. 验证 AWS S3 官方 Presigned URL 标准测试向量
	presignURL := "http://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host"
	awsPreReq := httptest.NewRequest("GET", presignURL, nil)
	awsPreReq.Host = "examplebucket.s3.amazonaws.com"
	gotPreSig := computeS3SigV4(
		awsPreReq,
		awsSecret,
		"20130524",
		"us-east-1",
		"s3",
		"host",
		"20130524T000000Z",
		true,
	)
	const wantOfficialPresignSig = "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
	if gotPreSig != wantOfficialPresignSig {
		t.Fatalf("AWS S3 官方 Presigned URL 测试向量签名不匹配:\n got: %s\nwant: %s", gotPreSig, wantOfficialPresignSig)
	}

	// 4. 验证 AWS S3 官方 Streaming Chunk Signature 标准测试向量
	// Seed signature = 4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9
	// Chunk 1: 65536 bytes of 'a'
	const seedSig = "4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9"
	chunk1SHA := sha256Hex([]byte(strings.Repeat("a", 65536)))
	const wantChunk1Sig = "ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648"
	gotChunk1Sig := ComputeS3ChunkSignature(kSigning, "20130524T000000Z", "20130524/us-east-1/s3/aws4_request", seedSig, chunk1SHA)
	if gotChunk1Sig != wantChunk1Sig {
		t.Fatalf("AWS S3 官方 Chunk #1 签名向量不匹配:\n got: %s\nwant: %s (kSigning=%s)", gotChunk1Sig, wantChunk1Sig, hex.EncodeToString(kSigning))
	}
	// Chunk 2: 1024 bytes of 'a'
	chunk2SHA := sha256Hex([]byte(strings.Repeat("a", 1024)))
	const wantChunk2Sig = "0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497"
	gotChunk2Sig := ComputeS3ChunkSignature(kSigning, "20130524T000000Z", "20130524/us-east-1/s3/aws4_request", gotChunk1Sig, chunk2SHA)
	if gotChunk2Sig != wantChunk2Sig {
		t.Fatalf("AWS S3 官方 Chunk #2 签名向量不匹配:\n got: %s\nwant: %s", gotChunk2Sig, wantChunk2Sig)
	}
	// Chunk 3 (final 0-byte chunk)
	const wantFinalChunkSig = "b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9"
	gotFinalChunkSig := ComputeS3ChunkSignature(kSigning, "20130524T000000Z", "20130524/us-east-1/s3/aws4_request", gotChunk2Sig, sha256Hex(nil))
	if gotFinalChunkSig != wantFinalChunkSig {
		t.Fatalf("AWS S3 官方 Final Chunk 签名向量不匹配:\n got: %s\nwant: %s", gotFinalChunkSig, wantFinalChunkSig)
	}

	base := t.TempDir()
	st, err := store.NewStore(
		filepath.Join(base, "cos.db"),
		filepath.Join(base, "blobs"),
		filepath.Join(base, "mp"),
		filepath.Join(base, "tmp"),
	)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer st.Close()

	cfg := &config.Config{
		AdminUser: "admin",
		AdminPass: "pass123456",
		SecretKey: "unit-test-secret-key-for-auth-service",
		S3Region:  "us-east-1",
	}
	svc := NewAuthService(cfg, st)

	// 5. 测试预签名生成与防篡改校验
	qStr, _, err := svc.GeneratePresignedQuery("GET", "mybucket", "folder/file.txt", 600, "ADMIN")
	if err != nil {
		t.Fatalf("GeneratePresignedQuery failed: %v", err)
	}
	req := httptest.NewRequest("GET", "http://localhost:9000/raw/mybucket/folder/file.txt?"+qStr, nil)
	p, ok := svc.VerifyPresignedQuery(req, "mybucket", "folder/file.txt")
	if !ok || p == nil || !p.IsAdmin {
		t.Fatalf("VerifyPresignedQuery 应当验证通过")
	}
	if _, ok := svc.VerifyPresignedQuery(req, "mybucket", "folder/other.txt"); ok {
		t.Fatalf("预签名 URL 跨 Key 使用应当被拒绝")
	}

	// 6. 测试登录防爆破上限驱逐逻辑
	for i := 0; i < 4100; i++ {
		svc.RecordLoginFailure(time.Now().Format("150405") + "-" + string(rune(i)))
	}
	if len(svc.loginAttempts) > 4096 {
		t.Fatalf("loginAttempts map 大小超出了 4096 上限: %d", len(svc.loginAttempts))
	}
}

func FuzzS3PercentEncode(f *testing.F) {
	for _, s := range []string{"", "simple", "a/b/c+d e%20f~g", "中文/路径/文件 (1).txt"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, input string) {
		out := s3PercentEncode(input)
		if strings.Contains(out, " ") || strings.Contains(out, "+") || strings.Contains(out, "/") {
			t.Fatalf("s3PercentEncode 输出不应包含未编码的空格、加号或斜杠: %q", out)
		}
		pathOut := s3URIPath(input)
		if strings.Contains(pathOut, " ") || strings.Contains(pathOut, "+") {
			t.Fatalf("s3URIPath 输出不应包含未编码的空格或加号: %q", pathOut)
		}
	})
}
