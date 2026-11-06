package store_test

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nanocos/internal/store"
)

func newTestStore(t testing.TB) *store.Store {
	t.Helper()
	base := t.TempDir()
	st, err := store.NewStore(
		filepath.Join(base, "meta", "cos.db"),
		filepath.Join(base, "blobs"),
		filepath.Join(base, "multipart"),
		filepath.Join(base, "tmp"),
	)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	t.Cleanup(func() {
		_ = st.Close()
	})
	return st
}

func TestStoreMigrationsPBKDF2AndHotBackup(t *testing.T) {
	base := t.TempDir()
	metaDir := filepath.Join(base, "meta")
	_ = os.MkdirAll(metaDir, 0755)
	_ = os.WriteFile(filepath.Join(metaDir, "secret.key"), []byte("0123456789abcdef0123456789abcdef"), 0600)

	st, err := store.NewStore(
		filepath.Join(metaDir, "cos.db"),
		filepath.Join(base, "blobs"),
		filepath.Join(base, "multipart"),
		filepath.Join(base, "tmp"),
	)
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer st.Close()

	// 1. 验证健康检查探针
	if err := st.PingHealth(); err != nil {
		t.Fatalf("PingHealth failed: %v", err)
	}

	// 2. 验证管理员密码标准 PBKDF2-SHA256 哈希与校验
	user, plainPass, created, err := st.EnsureAdminAccount("admin", "StrongPass#2026")
	if err != nil || !created || user != "admin" || plainPass != "StrongPass#2026" {
		t.Fatalf("EnsureAdminAccount failed: u=%q p=%q created=%v err=%v", user, plainPass, created, err)
	}
	if _, ok := st.VerifyAdminCredentials("admin", "StrongPass#2026"); !ok {
		t.Fatalf("VerifyAdminCredentials 应当校验通过")
	}
	if _, ok := st.VerifyAdminCredentials("admin", "WrongPassword"); ok {
		t.Fatalf("VerifyAdminCredentials 错误密码不应通过")
	}

	// 3. 写入存储桶与对象，执行在线热备份 (VACUUM INTO) 并从备份目录恢复验证
	if _, err := st.CreateBucket("backup-test", "private", 0, "*"); err != nil {
		t.Fatalf("CreateBucket failed: %v", err)
	}
	if _, err := st.PutObjectFromStream("backup-test", "dir/hello.txt", strings.NewReader("consistent-backup-payload"), "text/plain", map[string]string{"env": "prod"}); err != nil {
		t.Fatalf("PutObjectFromStream failed: %v", err)
	}

	backupDir := filepath.Join(t.TempDir(), "snap")
	dbSnap, copiedBlobs, err := st.BackupToDir(backupDir)
	if err != nil {
		t.Fatalf("BackupToDir failed: %v", err)
	}
	if copiedBlobs != 1 || dbSnap == "" {
		t.Fatalf("期望备份 1 个物理块，实际 copiedBlobs=%d dbSnap=%q", copiedBlobs, dbSnap)
	}

	// 从备份目录启动全新的 Store 实例验证数据与物理块完整性
	restoredStore, err := store.NewStore(
		filepath.Join(backupDir, "meta", "cos.db"),
		filepath.Join(backupDir, "blobs"),
		filepath.Join(backupDir, "multipart"),
		filepath.Join(backupDir, "tmp"),
	)
	if err != nil {
		t.Fatalf("从热备份恢复打开 Store 失败: %v", err)
	}
	defer restoredStore.Close()

	obj, err := restoredStore.GetObject("backup-test", "dir/hello.txt")
	if err != nil || obj.SizeBytes != int64(len("consistent-backup-payload")) || obj.CustomMeta["env"] != "prod" {
		t.Fatalf("备份恢复后对象元数据不匹配: obj=%+v err=%v", obj, err)
	}
	checked, corrupted, err := restoredStore.ScrubBlobs()
	if err != nil || checked != 1 || len(corrupted) != 0 {
		t.Fatalf("备份恢复后物理块巡检失败: checked=%d corrupted=%v err=%v", checked, corrupted, err)
	}
}

func FuzzNormalizeObjectKey(f *testing.F) {
	seeds := []string{
		"a/b/c.txt",
		"/leading/slash.png",
		"folder/subfolder/",
		"../traversal/attempt",
		"a//b///c",
		"\\",
		".",
		"..",
		"a%/b_c/文件.txt",
	}
	for _, s := range seeds {
		f.Add(s, false)
		f.Add(s, true)
	}
	f.Fuzz(func(t *testing.T, raw string, isFolder bool) {
		norm, err := store.NormalizeObjectKey(raw, isFolder)
		if err != nil {
			return
		}
		if norm == "" {
			t.Fatalf("NormalizeObjectKey 返回了空 key 且无错误 (raw=%q)", raw)
		}
		if strings.HasPrefix(norm, "/") {
			t.Fatalf("NormalizeObjectKey 结果不应以 '/' 开头: %q", norm)
		}
		if isFolder != strings.HasSuffix(norm, "/") {
			t.Fatalf("NormalizeObjectKey isFolder=%v 与结果尾部斜杠不一致: %q", isFolder, norm)
		}
		for _, seg := range strings.Split(strings.TrimSuffix(norm, "/"), "/") {
			if seg == "" || seg == "." || seg == ".." {
				t.Fatalf("NormalizeObjectKey 包含非法路径段 %q: %q", seg, norm)
			}
		}
	})
}

func FuzzPrefixUpperBound(f *testing.F) {
	for _, s := range []string{"a", "dir/", "docs/2026/", "\xff", "a\xff"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, prefix string) {
		if prefix == "" {
			return
		}
		upper := store.PrefixUpperBound(prefix)
		if upper != "" {
			if upper <= prefix {
				t.Fatalf("PrefixUpperBound(%q) = %q 必须严格大于原前缀", prefix, upper)
			}
			child := prefix + "a"
			if !(child >= prefix && child < upper) {
				t.Fatalf("子路径 %q 必须落在 [%q, %q) 区间内", child, prefix, upper)
			}
		}
	})
}

func BenchmarkCASWriteAndDedup(b *testing.B) {
	st := newTestStore(b)
	_, _ = st.CreateBucket("bench", "private", 0, "*")
	payload := bytes.Repeat([]byte("NanoCOS-CAS-Benchmark-Block-"), 1024) // ~28KB

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		key := fmt.Sprintf("item-%d.bin", i%32)
		if _, err := st.PutObjectFromStream("bench", key, bytes.NewReader(payload), "application/octet-stream", nil); err != nil {
			b.Fatalf("PutObject failed: %v", err)
		}
	}
}
