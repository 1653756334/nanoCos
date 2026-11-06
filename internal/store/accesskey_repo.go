package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

var ErrAccessKeyNotFound = errors.New("AccessKey 不存在")

// AccessKey 表示一组用于 API 或 S3 客户端接入的 AK/SK 访问凭证
type AccessKey struct {
	AccessKey      string    `json:"accessKey"`
	SecretKey      string    `json:"secretKey"`
	Name           string    `json:"name"`
	AllowedBuckets string    `json:"allowedBuckets"` // "*" 或逗号分隔的桶名
	Permission     string    `json:"permission"`     // "read" | "readwrite" | "admin"
	CreatedAt      time.Time `json:"createdAt"`
}

// EnsureDefaultAccessKey 若系统中尚无任何 AK/SK，则自动生成一组默认管理员密钥；否则返回最早创建的主密钥
func (s *Store) EnsureDefaultAccessKey() (*AccessKey, bool, error) {
	var item AccessKey
	err := s.db.QueryRow(`
		SELECT access_key, secret_key, name, allowed_buckets, permission, created_at
		FROM access_keys
		ORDER BY created_at ASC
		LIMIT 1
	`).Scan(&item.AccessKey, &item.SecretKey, &item.Name, &item.AllowedBuckets, &item.Permission, &item.CreatedAt)
	if err == nil {
		return &item, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}

	ak, err := s.CreateAccessKey("默认主密钥 (Default)", "*", "admin")
	if err != nil {
		return nil, false, err
	}
	return ak, true, nil
}

// CreateAccessKey 生成并保存一组新的 AK/SK
func (s *Store) CreateAccessKey(name, allowedBuckets, permission string) (*AccessKey, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "API 密钥"
	}
	allowedBuckets = strings.TrimSpace(allowedBuckets)
	if allowedBuckets == "" {
		allowedBuckets = "*"
	}
	switch strings.ToLower(strings.TrimSpace(permission)) {
	case "read":
		permission = "read"
	case "admin":
		permission = "admin"
	default:
		permission = "readwrite"
	}

	akBuf := make([]byte, 8)
	skBuf := make([]byte, 20)
	if _, err := rand.Read(akBuf); err != nil {
		return nil, err
	}
	if _, err := rand.Read(skBuf); err != nil {
		return nil, err
	}

	ak := "COSAK" + strings.ToUpper(hex.EncodeToString(akBuf))
	sk := hex.EncodeToString(skBuf)
	now := time.Now().UTC()

	s.writeMu.Lock()
	_, err := s.db.Exec(`
		INSERT INTO access_keys (access_key, secret_key, name, allowed_buckets, permission, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, ak, sk, name, allowedBuckets, permission, now)
	s.writeMu.Unlock()
	if err != nil {
		return nil, err
	}

	return &AccessKey{
		AccessKey:      ak,
		SecretKey:      sk,
		Name:           name,
		AllowedBuckets: allowedBuckets,
		Permission:     permission,
		CreatedAt:      now,
	}, nil
}

// GetAccessKey 根据 AccessKey ID 查询凭证
func (s *Store) GetAccessKey(ak string) (*AccessKey, error) {
	ak = strings.TrimSpace(ak)
	var item AccessKey
	err := s.db.QueryRow(`
		SELECT access_key, secret_key, name, allowed_buckets, permission, created_at
		FROM access_keys
		WHERE access_key = ?
	`, ak).Scan(&item.AccessKey, &item.SecretKey, &item.Name, &item.AllowedBuckets, &item.Permission, &item.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrAccessKeyNotFound
		}
		return nil, err
	}
	return &item, nil
}

// ListAccessKeys 列出所有 AK/SK 密钥
func (s *Store) ListAccessKeys() ([]AccessKey, error) {
	rows, err := s.db.Query(`
		SELECT access_key, secret_key, name, allowed_buckets, permission, created_at
		FROM access_keys
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []AccessKey
	for rows.Next() {
		var item AccessKey
		if err := rows.Scan(&item.AccessKey, &item.SecretKey, &item.Name, &item.AllowedBuckets, &item.Permission, &item.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	if list == nil {
		list = []AccessKey{}
	}
	return list, rows.Err()
}

// DeleteAccessKey 删除指定 AK
func (s *Store) DeleteAccessKey(ak string) error {
	s.writeMu.Lock()
	res, err := s.db.Exec(`DELETE FROM access_keys WHERE access_key = ?`, strings.TrimSpace(ak))
	s.writeMu.Unlock()
	if err != nil {
		return err
	}
	aff, _ := res.RowsAffected()
	if aff == 0 {
		return ErrAccessKeyNotFound
	}
	return nil
}

// CanAccessBucket 校验该密钥是否有权对指定 Bucket 进行读或写操作（严格遵循 AllowedBuckets 范围）
func (ak *AccessKey) CanAccessBucket(bucket string, writeRequired bool) bool {
	if ak == nil {
		return false
	}
	if writeRequired && ak.Permission == "read" {
		return false
	}
	if strings.TrimSpace(ak.AllowedBuckets) == "*" {
		return true
	}
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	for _, b := range strings.Split(ak.AllowedBuckets, ",") {
		if strings.ToLower(strings.TrimSpace(b)) == bucket {
			return true
		}
	}
	return false
}
