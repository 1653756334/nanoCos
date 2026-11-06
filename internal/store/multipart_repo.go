package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

var (
	ErrMultipartNotFound = errors.New("分片上传任务不存在或与目标存储桶不匹配")
	ErrInvalidPartNumber = errors.New("分片序号必须在 1 ~ 10000 之间")
	ErrInvalidPartOrder  = errors.New("合并分片列表必须按 PartNumber 严格升序排列")
	ErrInvalidPartETag   = errors.New("分片 ETag 校验不匹配或分片不存在")
	ErrNoMultipartParts  = errors.New("未找到任何已上传的分片，无法合并")
)

// MultipartUpload 表示一个进行中的分片上传会话
type MultipartUpload struct {
	UploadID    string            `json:"uploadId"`
	Bucket      string            `json:"bucket"`
	Key         string            `json:"key"`
	ContentType string            `json:"contentType"`
	CustomMeta  map[string]string `json:"customMeta,omitempty"`
	CreatedAt   time.Time         `json:"createdAt"`
	Parts       []MultipartPart   `json:"parts,omitempty"`
}

// MultipartPart 表示已成功上传的单个分片元数据
type MultipartPart struct {
	UploadID   string    `json:"uploadId"`
	PartNumber int       `json:"partNumber"`
	SizeBytes  int64     `json:"sizeBytes"`
	ETag       string    `json:"etag"`
	SHA256     string    `json:"sha256"`
	UploadedAt time.Time `json:"uploadedAt"`
}

// CompletePartSpec 客户端在 CompleteMultipartUpload 时提交的分片校验清单
type CompletePartSpec struct {
	PartNumber int
	ETag       string
}

// InitiateMultipartUpload 创建分片上传任务
func (s *Store) InitiateMultipartUpload(bucket, rawKey, contentType string, customMeta map[string]string) (*MultipartUpload, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	if _, err := s.GetBucket(bucket); err != nil {
		return nil, err
	}
	key, err := NormalizeObjectKey(rawKey, false)
	if err != nil {
		return nil, err
	}

	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	uploadID := hex.EncodeToString(buf)

	finalType := ResolveContentType(key, contentType, "")
	metaJSON := "{}"
	if len(customMeta) > 0 {
		if b, err := json.Marshal(customMeta); err == nil {
			metaJSON = string(b)
		}
	}

	s.writeMu.Lock()
	now := time.Now().UTC()
	_, err = s.db.Exec(`
		INSERT INTO multipart_uploads (upload_id, bucket, key, content_type, custom_meta, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, uploadID, bucket, key, finalType, metaJSON, now)
	s.writeMu.Unlock()
	if err != nil {
		return nil, err
	}

	return &MultipartUpload{
		UploadID:    uploadID,
		Bucket:      bucket,
		Key:         key,
		ContentType: finalType,
		CustomMeta:  customMeta,
		CreatedAt:   now,
		Parts:       []MultipartPart{},
	}, nil
}

// ListMultipartUploads 列出指定存储桶内进行中的分片上传会话（兼容 S3 ListMultipartUploads / rclone 清理）
func (s *Store) ListMultipartUploads(bucket, prefix string) ([]MultipartUpload, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	if _, err := s.GetBucket(bucket); err != nil {
		return nil, err
	}

	var rows *sql.Rows
	var err error
	if prefix == "" {
		rows, err = s.db.Query(`
			SELECT upload_id, bucket, key, content_type, custom_meta, created_at
			FROM multipart_uploads
			WHERE bucket = ?
			ORDER BY created_at ASC
		`, bucket)
	} else {
		rows, err = s.db.Query(`
			SELECT upload_id, bucket, key, content_type, custom_meta, created_at
			FROM multipart_uploads
			WHERE bucket = ? AND substr(key, 1, length(?)) = ?
			ORDER BY created_at ASC
		`, bucket, prefix, prefix)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []MultipartUpload
	for rows.Next() {
		var u MultipartUpload
		var metaStr string
		if err := rows.Scan(&u.UploadID, &u.Bucket, &u.Key, &u.ContentType, &metaStr, &u.CreatedAt); err != nil {
			return nil, err
		}
		if metaStr != "" && metaStr != "{}" {
			_ = json.Unmarshal([]byte(metaStr), &u.CustomMeta)
		}
		list = append(list, u)
	}
	if list == nil {
		list = []MultipartUpload{}
	}
	return list, nil
}

// GetMultipartUploadScoped 查询分片上传任务并强制校验所属 bucket 与 key（防止跨桶越权访问或篡改）
func (s *Store) GetMultipartUploadScoped(bucket, expectedRawKey, uploadID string) (*MultipartUpload, error) {
	uploadID = strings.TrimSpace(uploadID)
	var u MultipartUpload
	var metaStr string
	err := s.db.QueryRow(`
		SELECT upload_id, bucket, key, content_type, custom_meta, created_at
		FROM multipart_uploads
		WHERE upload_id = ?
	`, uploadID).Scan(&u.UploadID, &u.Bucket, &u.Key, &u.ContentType, &metaStr, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrMultipartNotFound
		}
		return nil, err
	}
	if bucket != "" && !strings.EqualFold(u.Bucket, strings.TrimSpace(bucket)) {
		return nil, ErrMultipartNotFound
	}
	if expectedRawKey != "" {
		normKey, err := NormalizeObjectKey(expectedRawKey, false)
		if err != nil || u.Key != normKey {
			return nil, ErrMultipartNotFound
		}
	}

	if metaStr != "" && metaStr != "{}" {
		_ = json.Unmarshal([]byte(metaStr), &u.CustomMeta)
	}

	rows, err := s.db.Query(`
		SELECT upload_id, part_number, size_bytes, etag, sha256, uploaded_at
		FROM multipart_parts
		WHERE upload_id = ?
		ORDER BY part_number ASC
	`, uploadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var parts []MultipartPart
	for rows.Next() {
		var p MultipartPart
		if err := rows.Scan(&p.UploadID, &p.PartNumber, &p.SizeBytes, &p.ETag, &p.SHA256, &p.UploadedAt); err != nil {
			return nil, err
		}
		parts = append(parts, p)
	}
	if parts == nil {
		parts = []MultipartPart{}
	}
	u.Parts = parts
	return &u, nil
}

// getBucketStagedMultipartBytes 计算指定存储桶当前所有未完成分片已占用的磁盘字节数（可排除正在覆盖的单个分片）
func (s *Store) getBucketStagedMultipartBytes(bucket, excludeUploadID string, excludePartNumber int) int64 {
	var total int64
	if excludeUploadID != "" && excludePartNumber > 0 {
		_ = s.db.QueryRow(`
			SELECT COALESCE(SUM(mp.size_bytes), 0)
			FROM multipart_parts mp
			JOIN multipart_uploads mu ON mu.upload_id = mp.upload_id
			WHERE mu.bucket = ? AND NOT (mp.upload_id = ? AND mp.part_number = ?)
		`, bucket, excludeUploadID, excludePartNumber).Scan(&total)
	} else {
		_ = s.db.QueryRow(`
			SELECT COALESCE(SUM(mp.size_bytes), 0)
			FROM multipart_parts mp
			JOIN multipart_uploads mu ON mu.upload_id = mp.upload_id
			WHERE mu.bucket = ?
		`, bucket).Scan(&total)
	}
	return total
}

// UploadPartScoped 校验所属 bucket/key 并保存单个分片（将已暂存分片计入桶配额预算，防止通过未合并分片耗尽磁盘）
func (s *Store) UploadPartScoped(bucket, expectedRawKey, uploadID string, partNumber int, r io.Reader, opts WriteOptions) (*MultipartPart, error) {
	if partNumber < 1 || partNumber > 10000 {
		return nil, ErrInvalidPartNumber
	}
	u, err := s.GetMultipartUploadScoped(bucket, expectedRawKey, uploadID)
	if err != nil {
		return nil, err
	}

	// 检查存储桶配额上限（扣除桶已用字节 + 该桶内所有已暂存未合并的分片字节）
	if b, bErr := s.GetBucket(u.Bucket); bErr == nil && b.QuotaBytes > 0 {
		staged := s.getBucketStagedMultipartBytes(u.Bucket, uploadID, partNumber)
		remaining := b.QuotaBytes - b.UsedBytes - staged
		if remaining <= 0 {
			return nil, ErrQuotaExceeded
		}
		if opts.MaxBytes == 0 || remaining < opts.MaxBytes {
			opts.MaxBytes = remaining
			opts.QuotaOrSizeErr = ErrQuotaExceeded
		}
	}

	res, err := s.cas.WritePartWithOptions(uploadID, partNumber, r, opts)
	if err != nil {
		return nil, err
	}

	s.writeMu.Lock()
	if b, bErr := s.GetBucket(u.Bucket); bErr == nil && b.QuotaBytes > 0 {
		staged := s.getBucketStagedMultipartBytes(u.Bucket, uploadID, partNumber)
		if b.UsedBytes+staged+res.SizeBytes > b.QuotaBytes {
			s.writeMu.Unlock()
			return nil, ErrQuotaExceeded
		}
	}
	now := time.Now().UTC()
	_, err = s.db.Exec(`
		INSERT INTO multipart_parts (upload_id, part_number, size_bytes, etag, sha256, uploaded_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(upload_id, part_number) DO UPDATE SET
			size_bytes = excluded.size_bytes,
			etag = excluded.etag,
			sha256 = excluded.sha256,
			uploaded_at = excluded.uploaded_at
	`, uploadID, partNumber, res.SizeBytes, res.MD5, res.SHA256, now)
	s.writeMu.Unlock()
	if err != nil {
		return nil, err
	}

	return &MultipartPart{
		UploadID:   uploadID,
		PartNumber: partNumber,
		SizeBytes:  res.SizeBytes,
		ETag:       res.MD5,
		SHA256:     res.SHA256,
		UploadedAt: now,
	}, nil
}

// CompleteMultipartUploadScoped 校验所属 bucket/key 及客户端提交的 Part/ETag 列表，流式合并并原子入库
func (s *Store) CompleteMultipartUploadScoped(bucket, expectedRawKey, uploadID string, clientParts []CompletePartSpec) (*Object, error) {
	u, err := s.GetMultipartUploadScoped(bucket, expectedRawKey, uploadID)
	if err != nil {
		return nil, err
	}
	if len(u.Parts) == 0 {
		return nil, ErrNoMultipartParts
	}

	var partNums []int
	if len(clientParts) > 0 {
		partMap := make(map[int]MultipartPart, len(u.Parts))
		for _, p := range u.Parts {
			partMap[p.PartNumber] = p
		}
		lastNum := 0
		for _, cp := range clientParts {
			if cp.PartNumber <= lastNum {
				return nil, ErrInvalidPartOrder
			}
			lastNum = cp.PartNumber
			dbPart, ok := partMap[cp.PartNumber]
			if !ok {
				return nil, ErrInvalidPartETag
			}
			cleanETag := strings.Trim(strings.TrimSpace(cp.ETag), `"`)
			if cleanETag != "" && !strings.EqualFold(cleanETag, dbPart.ETag) {
				return nil, ErrInvalidPartETag
			}
			partNums = append(partNums, cp.PartNumber)
		}
	} else {
		partNums = make([]int, len(u.Parts))
		for i, p := range u.Parts {
			partNums[i] = p.PartNumber
		}
	}

	merged, err := s.cas.MergePartsToTemp(uploadID, partNums, WriteOptions{})
	if err != nil {
		return nil, fmt.Errorf("流式合并分片失败: %w", err)
	}
	defer s.cas.DiscardTempBlob(merged.TmpPath)

	finalType := ResolveContentType(u.Key, u.ContentType, merged.SniffedContentType)

	s.writeMu.Lock()
	obj, err := s.saveBlobObjectLocked(u.Bucket, u.Key, merged.SHA256, merged.MD5, merged.SizeBytes, finalType, u.CustomMeta, merged.TmpPath)
	if err != nil {
		s.writeMu.Unlock()
		return nil, err
	}
	_, _ = s.db.Exec(`DELETE FROM multipart_uploads WHERE upload_id = ?`, uploadID)
	s.writeMu.Unlock()

	_ = s.cas.CleanupMultipart(uploadID)
	return obj, nil
}

// AbortMultipartUploadScoped 校验所属 bucket/key 后取消分片上传并清理磁盘分片
func (s *Store) AbortMultipartUploadScoped(bucket, expectedRawKey, uploadID string) error {
	if _, err := s.GetMultipartUploadScoped(bucket, expectedRawKey, uploadID); err != nil {
		return err
	}
	s.writeMu.Lock()
	_, err := s.db.Exec(`DELETE FROM multipart_uploads WHERE upload_id = ?`, uploadID)
	s.writeMu.Unlock()
	if err != nil {
		return err
	}
	return s.cas.CleanupMultipart(uploadID)
}
