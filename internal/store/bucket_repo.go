package store

import (
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var (
	ErrBucketNotFound      = errors.New("存储桶不存在")
	ErrBucketAlreadyExists = errors.New("存储桶已存在")
	ErrBucketNotEmpty      = errors.New("存储桶非空，请先清空桶内对象或启用强制删除")
	ErrQuotaExceeded       = errors.New("超出存储桶容量配额限制")
	bucketNameRegex        = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$`)
)

// Bucket 表示一个逻辑存储桶及其容量统计
type Bucket struct {
	Name        string    `json:"name"`
	Visibility  string    `json:"visibility"` // "private" | "public-read"
	QuotaBytes  int64     `json:"quotaBytes"` // 0 表示不限制
	CORSOrigins string    `json:"corsOrigins"`
	CreatedAt   time.Time `json:"createdAt"`
	ObjectCount int64     `json:"objectCount"`
	UsedBytes   int64     `json:"usedBytes"`
}

// ValidateBucketName 校验 Bucket 名称是否符合 S3 命名规范 (3~63 字符，小写字母、数字、连字符、点)
func ValidateBucketName(name string) error {
	name = strings.TrimSpace(name)
	if !bucketNameRegex.MatchString(name) || strings.Contains(name, "..") {
		return fmt.Errorf("存储桶名称不合法（需为 3~63 位小写字母、数字、中划线或点，且首尾为字母或数字）")
	}
	return nil
}

// NormalizeVisibility 校验并规范化桶访问权限
func NormalizeVisibility(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "public-read", "public":
		return "public-read"
	default:
		return "private"
	}
}

// CreateBucket 创建新的存储桶
func (s *Store) CreateBucket(name, visibility string, quotaBytes int64, corsOrigins string) (*Bucket, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if err := ValidateBucketName(name); err != nil {
		return nil, err
	}
	visibility = NormalizeVisibility(visibility)
	if strings.TrimSpace(corsOrigins) == "" {
		corsOrigins = "*"
	}
	if quotaBytes < 0 {
		quotaBytes = 0
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	now := time.Now().UTC()
	_, err := s.db.Exec(
		`INSERT INTO buckets (name, visibility, quota_bytes, cors_origins, object_count, used_bytes, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)`,
		name, visibility, quotaBytes, corsOrigins, now,
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(strings.ToLower(err.Error()), "constraint") {
			return nil, ErrBucketAlreadyExists
		}
		return nil, err
	}

	return &Bucket{
		Name:        name,
		Visibility:  visibility,
		QuotaBytes:  quotaBytes,
		CORSOrigins: corsOrigins,
		CreatedAt:   now,
		ObjectCount: 0,
		UsedBytes:   0,
	}, nil
}

// UpdateBucket 更新存储桶权限、配额或 CORS 配置
func (s *Store) UpdateBucket(name, visibility string, quotaBytes int64, corsOrigins string) (*Bucket, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	visibility = NormalizeVisibility(visibility)
	if strings.TrimSpace(corsOrigins) == "" {
		corsOrigins = "*"
	}
	if quotaBytes < 0 {
		quotaBytes = 0
	}

	s.writeMu.Lock()
	res, err := s.db.Exec(
		`UPDATE buckets SET visibility = ?, quota_bytes = ?, cors_origins = ? WHERE name = ?`,
		visibility, quotaBytes, corsOrigins, name,
	)
	s.writeMu.Unlock()
	if err != nil {
		return nil, err
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return nil, ErrBucketNotFound
	}
	return s.GetBucket(name)
}

// GetBucket O(1) 主键查询单个存储桶详情及增量维护的实时用量统计（消除热路径 LEFT JOIN 全表扫描）
func (s *Store) GetBucket(name string) (*Bucket, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	var b Bucket
	err := s.db.QueryRow(`
		SELECT name, visibility, quota_bytes, cors_origins, created_at, object_count, used_bytes
		FROM buckets
		WHERE name = ?
	`, name).Scan(&b.Name, &b.Visibility, &b.QuotaBytes, &b.CORSOrigins, &b.CreatedAt, &b.ObjectCount, &b.UsedBytes)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrBucketNotFound
		}
		return nil, err
	}
	return &b, nil
}

// ListBuckets 获取所有存储桶及其容量统计
func (s *Store) ListBuckets() ([]Bucket, error) {
	rows, err := s.db.Query(`
		SELECT name, visibility, quota_bytes, cors_origins, created_at, object_count, used_bytes
		FROM buckets
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []Bucket
	for rows.Next() {
		var b Bucket
		if err := rows.Scan(&b.Name, &b.Visibility, &b.QuotaBytes, &b.CORSOrigins, &b.CreatedAt, &b.ObjectCount, &b.UsedBytes); err != nil {
			return nil, err
		}
		list = append(list, b)
	}
	if list == nil {
		list = []Bucket{}
	}
	return list, rows.Err()
}

// DeleteBucket 删除存储桶（若 force=true 则同时清理桶内所有对象并回收无引用物理块，全过程持有写锁防竞态）
func (s *Store) DeleteBucket(name string, force bool) error {
	name = strings.ToLower(strings.TrimSpace(name))

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var bucketExists int
	if err := s.db.QueryRow(`SELECT 1 FROM buckets WHERE name = ?`, name).Scan(&bucketExists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrBucketNotFound
		}
		return err
	}

	var totalRows int64
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM objects WHERE bucket = ?`, name).Scan(&totalRows); err != nil {
		return err
	}
	if totalRows > 0 && !force {
		return ErrBucketNotEmpty
	}

	// 查询该桶下所有未完成的分片上传任务以便清理磁盘目录
	var uploadIDs []string
	if uRows, err := s.db.Query(`SELECT upload_id FROM multipart_uploads WHERE bucket = ?`, name); err == nil {
		for uRows.Next() {
			var uid string
			if err := uRows.Scan(&uid); err == nil {
				uploadIDs = append(uploadIDs, uid)
			}
		}
		_ = uRows.Close()
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var zeroRefBlobs []string
	if totalRows > 0 {
		rows, err := tx.Query(`
			SELECT blob_sha256, COUNT(*) 
			FROM objects 
			WHERE bucket = ? AND is_folder = 0 AND blob_sha256 IS NOT NULL AND blob_sha256 != ''
			GROUP BY blob_sha256
		`, name)
		if err != nil {
			return err
		}
		type blobDec struct {
			sha string
			cnt int64
		}
		var decs []blobDec
		for rows.Next() {
			var d blobDec
			if err := rows.Scan(&d.sha, &d.cnt); err != nil {
				_ = rows.Close()
				return err
			}
			decs = append(decs, d)
		}
		_ = rows.Close()

		for _, d := range decs {
			if _, err := tx.Exec(`UPDATE blobs SET ref_count = ref_count - ? WHERE sha256 = ?`, d.cnt, d.sha); err != nil {
				return err
			}
			var ref int64
			if err := tx.QueryRow(`SELECT ref_count FROM blobs WHERE sha256 = ?`, d.sha).Scan(&ref); err == nil && ref <= 0 {
				_, _ = tx.Exec(`DELETE FROM blobs WHERE sha256 = ?`, d.sha)
				zeroRefBlobs = append(zeroRefBlobs, d.sha)
			}
		}

		if _, err := tx.Exec(`DELETE FROM objects WHERE bucket = ?`, name); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`DELETE FROM multipart_uploads WHERE bucket = ?`, name); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM buckets WHERE name = ?`, name); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	for _, uid := range uploadIDs {
		_ = s.cas.CleanupMultipart(uid)
	}
	for _, sha := range zeroRefBlobs {
		_ = s.cas.DeleteBlob(sha)
	}
	return nil
}
