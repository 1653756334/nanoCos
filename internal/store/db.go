package store

import (
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

const currentSchemaVersion = 3

// Store 聚合了 SQLite 元数据库与 CAS 物理块存储引擎
type Store struct {
	db          *sql.DB
	dbPath      string
	cas         *CASEngine
	writeMu     sync.Mutex
	closed      bool
	reconciling atomic.Bool
	startedAt   time.Time
	stopCh      chan struct{}
	closeOnce   sync.Once
}

// CategoryStat 按文件 MIME 类型分类的容量与数量统计
type CategoryStat struct {
	Category    string  `json:"category"`
	Label       string  `json:"label"`
	Color       string  `json:"color"`
	ObjectCount int64   `json:"objectCount"`
	SizeBytes   int64   `json:"sizeBytes"`
	Percent     float64 `json:"percent"`
}

// SystemStats 展示存储系统整体概览、分类图表数据与 CAS 去重收益
type SystemStats struct {
	BucketCount          int64          `json:"bucketCount"`
	PublicBucketCount    int64          `json:"publicBucketCount"`
	PrivateBucketCount   int64          `json:"privateBucketCount"`
	ObjectCount          int64          `json:"objectCount"`
	FolderCount          int64          `json:"folderCount"`
	BlobCount            int64          `json:"blobCount"`
	LogicalBytes         int64          `json:"logicalBytes"`
	PhysicalBytes        int64          `json:"physicalBytes"`
	SavedBytes           int64          `json:"savedBytes"`
	DedupRatioPercent    float64        `json:"dedupRatioPercent"`
	AvgRefCount          float64        `json:"avgRefCount"`
	AccessKeyCount       int64          `json:"accessKeyCount"`
	MultipartActiveCount int64          `json:"multipartActiveCount"`
	Categories           []CategoryStat `json:"categories"`
	RecentObjects        []Object       `json:"recentObjects"`
	TopObjects           []Object       `json:"topObjects"`
	UptimeSeconds        int64          `json:"uptimeSeconds"`
	DiskTotalBytes       uint64         `json:"diskTotalBytes"`
	DiskFreeBytes        uint64         `json:"diskFreeBytes"`
	DiskUsedBytes        uint64         `json:"diskUsedBytes"`
	DiskUsedPercent      float64        `json:"diskUsedPercent"`
}

// NewStore 初始化 SQLite(WAL) 数据库与 CAS 物理存储引擎
func NewStore(dbPath, blobsDir, multipartDir, tmpDir string) (*Store, error) {
	for _, dir := range []string{filepath.Dir(dbPath), blobsDir, multipartDir, tmpDir} {
		if dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return nil, fmt.Errorf("创建存储目录失败 (%s): %w", dir, err)
			}
		}
	}

	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(10000)&_pragma=foreign_keys(ON)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 数据库失败: %w", err)
	}

	// SQLite WAL 模式下支持并发读，写操作通过 Store.writeMu 串行化以彻底消除 SQLITE_BUSY
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	db.SetConnMaxLifetime(30 * time.Minute)

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("连接 SQLite 数据库失败: %w", err)
	}

	if err := migrateSchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("初始化数据库表结构失败: %w", err)
	}

	cas := NewCASEngine(blobsDir, multipartDir, tmpDir)
	_ = cas.CleanTmpDir()

	st := &Store{
		db:        db,
		dbPath:    dbPath,
		cas:       cas,
		startedAt: time.Now(),
		stopCh:    make(chan struct{}),
	}

	skipStartupGC := strings.EqualFold(strings.TrimSpace(os.Getenv("NANOCOS_SKIP_STARTUP_GC")), "true") ||
		strings.TrimSpace(os.Getenv("NANOCOS_SKIP_STARTUP_GC")) == "1"

	// 后台异步执行初始对账与定期维护任务，避免海量物理块时阻塞 HTTP 监听启动
	go st.backgroundMaintenanceLoop(skipStartupGC)

	return st, nil
}

// Close 停止后台维护协程、执行 WAL Checkpoint 并关闭数据库连接
func (s *Store) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		close(s.stopCh)
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		s.closed = true
		if s.db != nil {
			_, _ = s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
			closeErr = s.db.Close()
		}
	})
	return closeErr
}

// IsReconciling 返回当前是否正在执行元数据与物理块对账
func (s *Store) IsReconciling() bool {
	return s.reconciling.Load()
}

// CAS 返回底层内容寻址存储引擎
func (s *Store) CAS() *CASEngine {
	return s.cas
}

// UptimeSeconds 返回存储引擎自启动以来的运行秒数
func (s *Store) UptimeSeconds() int64 {
	return int64(time.Since(s.startedAt).Seconds())
}

// PingHealth 执行存储引擎就绪性探针检查（SQLite 读写连通性 + CAS 目录状态）
func (s *Store) PingHealth() error {
	var one int
	if err := s.db.QueryRow(`SELECT 1`).Scan(&one); err != nil {
		return fmt.Errorf("数据库探针查询失败: %w", err)
	}
	for _, dir := range []string{s.cas.blobsDir, s.cas.multipartDir, s.cas.tmpDir} {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			return fmt.Errorf("存储目录不可用 (%s): %w", dir, err)
		}
	}
	return nil
}

// BackupToDir 执行在线一致性热备份：
// 1. 使用 SQLite `VACUUM INTO` 生成无 WAL 撕裂的一致性元数据库快照 (destDir/meta/cos.db)
// 2. 复制签名主密钥文件 (meta/secret.key)
// 3. 复制所有有效引用 (ref_count > 0) 的 CAS 物理块文件至 destDir/blobs/
func (s *Store) BackupToDir(destDir string) (dbSnapshotPath string, copiedBlobs int, err error) {
	destDir = strings.TrimSpace(destDir)
	if destDir == "" {
		return "", 0, fmt.Errorf("备份目标目录不能为空")
	}
	destMeta := filepath.Join(destDir, "meta")
	destBlobs := filepath.Join(destDir, "blobs")
	if err := os.MkdirAll(destMeta, 0755); err != nil {
		return "", 0, fmt.Errorf("创建备份 meta 目录失败: %w", err)
	}
	if err := os.MkdirAll(destBlobs, 0755); err != nil {
		return "", 0, fmt.Errorf("创建备份 blobs 目录失败: %w", err)
	}

	dbSnapshotPath = filepath.Join(destMeta, "cos.db")
	_ = os.Remove(dbSnapshotPath)

	s.writeMu.Lock()
	_, vacErr := s.db.Exec(`VACUUM INTO ?`, dbSnapshotPath)
	var activeSHAs []string
	if vacErr == nil {
		rows, qErr := s.db.Query(`SELECT sha256 FROM blobs WHERE ref_count > 0`)
		if qErr == nil {
			for rows.Next() {
				var sha string
				if err := rows.Scan(&sha); err == nil {
					activeSHAs = append(activeSHAs, sha)
				}
			}
			_ = rows.Close()
		}
	}
	s.writeMu.Unlock()

	if vacErr != nil {
		return "", 0, fmt.Errorf("SQLite VACUUM INTO 热备份失败: %w", vacErr)
	}

	// 复制同目录下的 secret.key（若存在）
	if s.dbPath != "" {
		srcSecret := filepath.Join(filepath.Dir(s.dbPath), "secret.key")
		if keyData, rErr := os.ReadFile(srcSecret); rErr == nil {
			_ = os.WriteFile(filepath.Join(destMeta, "secret.key"), keyData, 0600)
		}
	}

	dstCAS := NewCASEngine(destBlobs, filepath.Join(destDir, "multipart"), filepath.Join(destDir, "tmp"))
	for _, sha := range activeSHAs {
		srcPath, pErr := s.cas.BlobPath(sha)
		if pErr != nil {
			continue
		}
		dstPath, pErr := dstCAS.BlobPath(sha)
		if pErr != nil {
			continue
		}
		if err := copyFileAtomic(srcPath, dstPath); err != nil {
			return dbSnapshotPath, copiedBlobs, fmt.Errorf("复制物理块 %s 失败: %w", sha, err)
		}
		copiedBlobs++
	}
	return dbSnapshotPath, copiedBlobs, nil
}

func copyFileAtomic(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func (s *Store) backgroundMaintenanceLoop(skipStartupGC bool) {
	if !skipStartupGC {
		select {
		case <-s.stopCh:
			return
		default:
			_ = s.ReconcileAndGC(24 * time.Hour)
		}
	}
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			_ = s.CleanExpiredUploadsAndTokens(24 * time.Hour)
		}
	}
}

type schemaMigration struct {
	Version     int
	Description string
	Up          func(tx *sql.Tx) error
}

// migrateSchema 采用有序、逐版本独立事务的数据库迁移机制，任何一步迁移失败立即报错中止启动，杜绝静默降级
func migrateSchema(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			description TEXT NOT NULL DEFAULT '',
			applied_at DATETIME NOT NULL
		)
	`); err != nil {
		return fmt.Errorf("初始化 schema_migrations 表失败: %w", err)
	}
	// 兼容旧版 schema_migrations 表缺少 description 列的情况
	if hasDesc, err := hasColumn(db, "schema_migrations", "description"); err == nil && !hasDesc {
		if _, alterErr := db.Exec(`ALTER TABLE schema_migrations ADD COLUMN description TEXT NOT NULL DEFAULT ''`); alterErr != nil {
			return fmt.Errorf("升级 schema_migrations 表结构失败: %w", alterErr)
		}
	}

	migrations := []schemaMigration{
		{
			Version:     1,
			Description: "Initial core tables (buckets, blobs, objects, multipart, access_keys)",
			Up: func(tx *sql.Tx) error {
				ddl := `
				CREATE TABLE IF NOT EXISTS buckets (
					name TEXT PRIMARY KEY,
					visibility TEXT NOT NULL DEFAULT 'private',
					quota_bytes INTEGER NOT NULL DEFAULT 0,
					cors_origins TEXT NOT NULL DEFAULT '*',
					object_count INTEGER NOT NULL DEFAULT 0,
					used_bytes INTEGER NOT NULL DEFAULT 0,
					created_at DATETIME NOT NULL
				);

				CREATE TABLE IF NOT EXISTS blobs (
					sha256 TEXT PRIMARY KEY,
					md5 TEXT NOT NULL,
					size_bytes INTEGER NOT NULL,
					ref_count INTEGER NOT NULL DEFAULT 1,
					created_at DATETIME NOT NULL
				);

				CREATE TABLE IF NOT EXISTS objects (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					bucket TEXT NOT NULL,
					key TEXT NOT NULL,
					parent_dir TEXT NOT NULL DEFAULT '',
					is_folder INTEGER NOT NULL DEFAULT 0,
					blob_sha256 TEXT,
					size_bytes INTEGER NOT NULL DEFAULT 0,
					content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
					etag TEXT NOT NULL DEFAULT '',
					custom_meta TEXT NOT NULL DEFAULT '{}',
					updated_at DATETIME NOT NULL,
					UNIQUE(bucket, key),
					FOREIGN KEY(bucket) REFERENCES buckets(name) ON DELETE RESTRICT
				);

				CREATE INDEX IF NOT EXISTS idx_objects_bucket_parent ON objects(bucket, parent_dir, is_folder DESC, key ASC);
				CREATE INDEX IF NOT EXISTS idx_objects_bucket_key ON objects(bucket, key);
				CREATE INDEX IF NOT EXISTS idx_objects_blob ON objects(blob_sha256);

				CREATE TABLE IF NOT EXISTS multipart_uploads (
					upload_id TEXT PRIMARY KEY,
					bucket TEXT NOT NULL,
					key TEXT NOT NULL,
					content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
					custom_meta TEXT NOT NULL DEFAULT '{}',
					created_at DATETIME NOT NULL,
					FOREIGN KEY(bucket) REFERENCES buckets(name) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS multipart_parts (
					upload_id TEXT NOT NULL,
					part_number INTEGER NOT NULL,
					size_bytes INTEGER NOT NULL,
					etag TEXT NOT NULL,
					sha256 TEXT NOT NULL,
					uploaded_at DATETIME NOT NULL,
					PRIMARY KEY(upload_id, part_number),
					FOREIGN KEY(upload_id) REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE
				);

				CREATE TABLE IF NOT EXISTS access_keys (
					access_key TEXT PRIMARY KEY,
					secret_key TEXT NOT NULL,
					name TEXT NOT NULL,
					allowed_buckets TEXT NOT NULL DEFAULT '*',
					permission TEXT NOT NULL DEFAULT 'readwrite',
					created_at DATETIME NOT NULL
				);
				`
				_, err := tx.Exec(ddl)
				return err
			},
		},
		{
			Version:     2,
			Description: "Add incremental bucket counters and admin_account table",
			Up: func(tx *sql.Tx) error {
				hasObjCnt, err := hasColumnTx(tx, "buckets", "object_count")
				if err != nil {
					return err
				}
				if !hasObjCnt {
					if _, err := tx.Exec(`ALTER TABLE buckets ADD COLUMN object_count INTEGER NOT NULL DEFAULT 0`); err != nil {
						return err
					}
				}
				hasUsedBytes, err := hasColumnTx(tx, "buckets", "used_bytes")
				if err != nil {
					return err
				}
				if !hasUsedBytes {
					if _, err := tx.Exec(`ALTER TABLE buckets ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0`); err != nil {
						return err
					}
				}
				_, err = tx.Exec(`
					CREATE TABLE IF NOT EXISTS admin_account (
						id INTEGER PRIMARY KEY CHECK (id = 1),
						username TEXT NOT NULL,
						password_salt TEXT NOT NULL,
						password_hash TEXT NOT NULL,
						token_version INTEGER NOT NULL DEFAULT 1,
						updated_at DATETIME NOT NULL
					)
				`)
				return err
			},
		},
		{
			Version:     3,
			Description: "Add persistent revoked_tokens table and dashboard query indexes",
			Up: func(tx *sql.Tx) error {
				ddl := `
				CREATE TABLE IF NOT EXISTS revoked_tokens (
					token_hash TEXT PRIMARY KEY,
					expires_at INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_objects_recent ON objects(is_folder, updated_at DESC);
				CREATE INDEX IF NOT EXISTS idx_objects_size ON objects(is_folder, size_bytes DESC);
				CREATE INDEX IF NOT EXISTS idx_objects_ctype ON objects(is_folder, content_type, size_bytes);
				`
				_, err := tx.Exec(ddl)
				return err
			},
		},
	}

	for _, m := range migrations {
		var applied int
		err := db.QueryRow(`SELECT 1 FROM schema_migrations WHERE version = ?`, m.Version).Scan(&applied)
		if err == nil {
			continue
		}
		if err != sql.ErrNoRows {
			return fmt.Errorf("检查迁移版本 %d 状态失败: %w", m.Version, err)
		}

		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if err := m.Up(tx); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("执行数据库迁移 v%d (%s) 失败: %w", m.Version, m.Description, err)
		}
		if _, err := tx.Exec(
			`INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
			m.Version, m.Description, time.Now().UTC(),
		); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("记录数据库迁移版本 v%d 失败: %w", m.Version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("提交数据库迁移版本 v%d 失败: %w", m.Version, err)
		}
		slog.Info("数据库 Schema 迁移已应用", "version", m.Version, "description", m.Description)
	}

	if _, err := db.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, currentSchemaVersion)); err != nil {
		return err
	}
	return nil
}

type queryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func hasColumn(q queryer, table, column string) (bool, error) {
	rows, err := q.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if strings.EqualFold(name, column) {
			return true, nil
		}
	}
	return false, nil
}

func hasColumnTx(tx *sql.Tx, table, column string) (bool, error) {
	return hasColumn(tx, table, column)
}

// RevokeTokenHash 将已登出的管理员 Token 摘要持久化落库，重启后依然保持吊销状态
func (s *Store) RevokeTokenHash(tokenHash string, expUnix int64) {
	if tokenHash == "" {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	now := time.Now().Unix()
	_, _ = s.db.Exec(`DELETE FROM revoked_tokens WHERE expires_at <= ?`, now)
	_, _ = s.db.Exec(`INSERT OR REPLACE INTO revoked_tokens (token_hash, expires_at) VALUES (?, ?)`, tokenHash, expUnix)
}

// IsTokenHashRevoked 检查管理员 Token 摘要是否在持久化吊销列表中
func (s *Store) IsTokenHashRevoked(tokenHash string) bool {
	if tokenHash == "" {
		return false
	}
	var exp int64
	err := s.db.QueryRow(`SELECT expires_at FROM revoked_tokens WHERE token_hash = ?`, tokenHash).Scan(&exp)
	if err != nil {
		return false
	}
	return exp > time.Now().Unix()
}

// CleanExpiredUploadsAndTokens 轻量级定期维护任务：清理超时未完成的分片上传与已过期的吊销 Token，不阻塞正常读写
func (s *Store) CleanExpiredUploadsAndTokens(multipartTTL time.Duration) error {
	now := time.Now().UTC()

	s.writeMu.Lock()
	if s.closed {
		s.writeMu.Unlock()
		return nil
	}
	_, _ = s.db.Exec(`DELETE FROM revoked_tokens WHERE expires_at <= ?`, now.Unix())

	var expiredIDs []string
	if multipartTTL > 0 {
		cutoff := now.Add(-multipartTTL)
		rows, err := s.db.Query(`SELECT upload_id FROM multipart_uploads WHERE created_at < ?`, cutoff)
		if err == nil {
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err == nil {
					expiredIDs = append(expiredIDs, id)
				}
			}
			_ = rows.Close()
			for _, id := range expiredIDs {
				_, _ = s.db.Exec(`DELETE FROM multipart_uploads WHERE upload_id = ?`, id)
			}
		}
	}
	s.writeMu.Unlock()

	for _, id := range expiredIDs {
		_ = s.cas.CleanupMultipart(id)
	}
	return nil
}

// ReconcileAndGC 执行元数据与物理块对账、过期分片清理及孤儿块回收。
// 批量加载已知 SHA-256 集合并在锁外执行磁盘清理，大幅缩短写锁持有时间。
func (s *Store) ReconcileAndGC(multipartTTL time.Duration) error {
	s.reconciling.Store(true)
	defer s.reconciling.Store(false)

	_ = s.CleanExpiredUploadsAndTokens(multipartTTL)

	s.writeMu.Lock()
	if s.closed {
		s.writeMu.Unlock()
		return nil
	}
	// 1. 重新校准 buckets 表的增量统计列 (object_count, used_bytes)
	_, _ = s.db.Exec(`
		UPDATE buckets SET
			object_count = COALESCE((SELECT COUNT(*) FROM objects o WHERE o.bucket = buckets.name AND o.is_folder = 0), 0),
			used_bytes   = COALESCE((SELECT SUM(o.size_bytes) FROM objects o WHERE o.bucket = buckets.name AND o.is_folder = 0), 0)
	`)

	// 2. 重新校准 blobs 表的引用计数，回收 ref_count <= 0 的记录
	_, _ = s.db.Exec(`
		UPDATE blobs SET
			ref_count = COALESCE((SELECT COUNT(*) FROM objects o WHERE o.blob_sha256 = blobs.sha256 AND o.is_folder = 0), 0)
	`)

	var zeroBlobs []string
	if rows, err := s.db.Query(`SELECT sha256 FROM blobs WHERE ref_count <= 0`); err == nil {
		for rows.Next() {
			var sha string
			if err := rows.Scan(&sha); err == nil {
				zeroBlobs = append(zeroBlobs, sha)
			}
		}
		_ = rows.Close()
		for _, sha := range zeroBlobs {
			_, _ = s.db.Exec(`DELETE FROM blobs WHERE sha256 = ? AND ref_count <= 0`, sha)
		}
	}
	for _, sha := range zeroBlobs {
		_ = s.cas.DeleteBlob(sha)
	}

	// 3. 一次性加载所有有效 blobs 与活跃 upload_id 到内存集合，避免 WalkDir 期间逐文件查库
	validBlobs := make(map[string]struct{})
	if rows, err := s.db.Query(`SELECT sha256 FROM blobs WHERE ref_count > 0`); err == nil {
		for rows.Next() {
			var sha string
			if err := rows.Scan(&sha); err == nil {
				validBlobs[strings.ToLower(sha)] = struct{}{}
			}
		}
		_ = rows.Close()
	}

	activeUploads := make(map[string]struct{})
	if rows, err := s.db.Query(`SELECT upload_id FROM multipart_uploads`); err == nil {
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil {
				activeUploads[id] = struct{}{}
			}
		}
		_ = rows.Close()
	}

	// 4. 清理磁盘上不在 multipart_uploads 表中的孤儿分片目录
	if entries, err := os.ReadDir(s.cas.multipartDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			uploadID := entry.Name()
			if _, ok := activeUploads[uploadID]; !ok {
				_ = s.cas.CleanupMultipart(uploadID)
			}
		}
	}

	// 5. 扫描磁盘 blobs 目录，用内存 map O(1) 比对回收孤儿物理块文件
	_ = filepath.WalkDir(s.cas.blobsDir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		sha := strings.ToLower(d.Name())
		if len(sha) != 64 || !isHexString(sha) {
			return nil
		}
		if _, ok := validBlobs[sha]; !ok {
			_ = os.Remove(path)
		}
		return nil
	})
	s.writeMu.Unlock()

	return nil
}

// ScrubBlobs 扫描并校验所有物理块的 SHA-256 完整性，返回已检查数量与损坏的 SHA-256 列表
func (s *Store) ScrubBlobs() (checked int, corrupted []string, err error) {
	rows, err := s.db.Query(`SELECT sha256 FROM blobs WHERE ref_count > 0`)
	if err != nil {
		return 0, nil, err
	}
	var shas []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err == nil {
			shas = append(shas, sha)
		}
	}
	_ = rows.Close()

	for _, sha := range shas {
		checked++
		ok, vErr := s.cas.VerifyBlob(sha)
		if vErr != nil || !ok {
			corrupted = append(corrupted, sha)
		}
	}
	return checked, corrupted, nil
}

// GetSystemStats 查询全局统计数据、类型分布图表数据、最近上传与 Top 大文件
func (s *Store) GetSystemStats() (*SystemStats, error) {
	stats := &SystemStats{
		UptimeSeconds: int64(time.Since(s.startedAt).Seconds()),
	}

	if err := s.db.QueryRow(`
		SELECT
			COUNT(*),
			COALESCE(SUM(CASE WHEN visibility = 'public-read' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN visibility != 'public-read' THEN 1 ELSE 0 END), 0)
		FROM buckets
	`).Scan(&stats.BucketCount, &stats.PublicBucketCount, &stats.PrivateBucketCount); err != nil {
		return nil, err
	}

	if err := s.db.QueryRow(`
		SELECT
			COALESCE(SUM(CASE WHEN is_folder = 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN is_folder = 1 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN is_folder = 0 THEN size_bytes ELSE 0 END), 0)
		FROM objects
	`).Scan(&stats.ObjectCount, &stats.FolderCount, &stats.LogicalBytes); err != nil {
		return nil, err
	}

	if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM blobs WHERE ref_count > 0`).Scan(&stats.BlobCount, &stats.PhysicalBytes); err != nil {
		return nil, err
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM access_keys`).Scan(&stats.AccessKeyCount); err != nil {
		return nil, err
	}
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM multipart_uploads`).Scan(&stats.MultipartActiveCount)

	if stats.LogicalBytes > stats.PhysicalBytes {
		stats.SavedBytes = stats.LogicalBytes - stats.PhysicalBytes
	}
	if stats.LogicalBytes > 0 {
		stats.DedupRatioPercent = float64(stats.SavedBytes) * 100.0 / float64(stats.LogicalBytes)
	}
	if stats.BlobCount > 0 {
		stats.AvgRefCount = float64(stats.ObjectCount) / float64(stats.BlobCount)
	} else {
		stats.AvgRefCount = 1.0
	}

	// 1. 按媒体类型聚合统计
	catMap := map[string]*CategoryStat{
		"image":   {Category: "image", Label: "图片媒体 (Images)", Color: "#3b82f6"},
		"media":   {Category: "media", Label: "音视频流 (Video/Audio)", Color: "#8b5cf6"},
		"doc":     {Category: "doc", Label: "文档与代码 (Docs/Code)", Color: "#10b981"},
		"archive": {Category: "archive", Label: "归档与二进制 (Archives/Bin)", Color: "#f59e0b"},
	}

	rows, err := s.db.Query(`SELECT content_type, COUNT(*), COALESCE(SUM(size_bytes), 0) FROM objects WHERE is_folder = 0 GROUP BY content_type`)
	if err == nil {
		for rows.Next() {
			var ct string
			var cnt, sz int64
			if err := rows.Scan(&ct, &cnt, &sz); err == nil {
				key := classifyContentType(ct)
				item := catMap[key]
				item.ObjectCount += cnt
				item.SizeBytes += sz
			}
		}
		_ = rows.Close()
	}

	order := []string{"image", "media", "doc", "archive"}
	stats.Categories = make([]CategoryStat, 0, len(order))
	for _, k := range order {
		c := catMap[k]
		if stats.LogicalBytes > 0 {
			c.Percent = float64(c.SizeBytes) * 100.0 / float64(stats.LogicalBytes)
		}
		stats.Categories = append(stats.Categories, *c)
	}

	// 2. 最近上传的 6 个文件对象
	stats.RecentObjects = s.queryObjectSlice(`
		SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
		FROM objects
		WHERE is_folder = 0
		ORDER BY updated_at DESC
		LIMIT 6
	`)

	// 3. 容量最大的 Top 6 文件对象
	stats.TopObjects = s.queryObjectSlice(`
		SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
		FROM objects
		WHERE is_folder = 0
		ORDER BY size_bytes DESC
		LIMIT 6
	`)

	// 4. 查询数据存储目录所在物理磁盘的总容量与剩余空间
	dataDir := filepath.Dir(s.dbPath)
	if total, free, err := getDiskSpace(dataDir); err == nil && total > 0 {
		stats.DiskTotalBytes = total
		stats.DiskFreeBytes = free
		if total >= free {
			stats.DiskUsedBytes = total - free
			stats.DiskUsedPercent = math.Round(float64(stats.DiskUsedBytes)*1000.0/float64(total)) / 10.0
		}
	}

	return stats, nil
}

func (s *Store) queryObjectSlice(query string) []Object {
	rows, err := s.db.Query(query)
	if err != nil {
		return []Object{}
	}
	defer rows.Close()
	var list []Object
	for rows.Next() {
		if obj, err := scanObjectRow(rows); err == nil {
			list = append(list, *obj)
		}
	}
	if list == nil {
		return []Object{}
	}
	return list
}

func classifyContentType(ct string) string {
	lower := strings.ToLower(ct)
	switch {
	case strings.HasPrefix(lower, "image/"):
		return "image"
	case strings.HasPrefix(lower, "video/") || strings.HasPrefix(lower, "audio/"):
		return "media"
	case strings.HasPrefix(lower, "text/") ||
		strings.Contains(lower, "json") ||
		strings.Contains(lower, "xml") ||
		strings.Contains(lower, "yaml") ||
		strings.Contains(lower, "javascript") ||
		strings.Contains(lower, "pdf"):
		return "doc"
	default:
		return "archive"
	}
}
