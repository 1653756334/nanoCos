package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"path/filepath"
	"strings"
	"time"
)

var (
	ErrObjectNotFound = errors.New("对象不存在")
	ErrInvalidKey     = errors.New("对象路径 Key 不合法")
)

// Object 表示存储桶中的一个文件对象或虚拟目录
type Object struct {
	ID          int64             `json:"id"`
	Bucket      string            `json:"bucket"`
	Key         string            `json:"key"`
	Name        string            `json:"name"`
	ParentDir   string            `json:"parentDir"`
	IsFolder    bool              `json:"isFolder"`
	BlobSHA256  string            `json:"blobSha256,omitempty"`
	SizeBytes   int64             `json:"sizeBytes"`
	ContentType string            `json:"contentType"`
	ETag        string            `json:"etag"`
	CustomMeta  map[string]string `json:"customMeta,omitempty"`
	UpdatedAt   time.Time         `json:"updatedAt"`
}

// NormalizeObjectKey 清理并校验对象路径 Key。
// 若 isFolder=false 但 rawKey 以 '/' 结尾，拒绝并报错，防止尾部斜杠被静默剥离导致客户端按原 key 404。
func NormalizeObjectKey(rawKey string, isFolder bool) (string, error) {
	cleaned := strings.ReplaceAll(strings.TrimSpace(rawKey), "\\", "/")
	cleaned = strings.TrimLeft(cleaned, "/")
	if cleaned == "" {
		return "", ErrInvalidKey
	}
	hasTrailingSlash := strings.HasSuffix(cleaned, "/")
	if !isFolder && hasTrailingSlash {
		return "", ErrInvalidKey
	}

	parts := strings.Split(cleaned, "/")
	var validParts []string
	for _, p := range parts {
		if p == "" {
			continue
		}
		if p == "." || p == ".." {
			return "", ErrInvalidKey
		}
		validParts = append(validParts, p)
	}
	if len(validParts) == 0 {
		return "", ErrInvalidKey
	}
	res := strings.Join(validParts, "/")
	if isFolder && !strings.HasSuffix(res, "/") {
		res += "/"
	}
	return res, nil
}

// ExtractParentAndName 提取父目录前缀（以 / 结尾，根目录为 ""）与当前条目名称
func ExtractParentAndName(key string) (parentDir string, name string) {
	trimmed := strings.TrimSuffix(key, "/")
	idx := strings.LastIndex(trimmed, "/")
	if idx == -1 {
		if strings.HasSuffix(key, "/") {
			return "", trimmed + "/"
		}
		return "", trimmed
	}
	parent := trimmed[:idx+1]
	base := trimmed[idx+1:]
	if strings.HasSuffix(key, "/") {
		base += "/"
	}
	return parent, base
}

// ResolveContentType 结合文件后缀与流嗅探结果返回最佳 MIME 类型
func ResolveContentType(key, providedType, sniffedType string) string {
	providedType = strings.TrimSpace(providedType)
	if providedType != "" && providedType != "application/octet-stream" {
		return providedType
	}
	ext := strings.ToLower(filepath.Ext(strings.TrimSuffix(key, "/")))
	extMap := map[string]string{
		".md":   "text/markdown; charset=utf-8",
		".txt":  "text/plain; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".yaml": "text/yaml; charset=utf-8",
		".yml":  "text/yaml; charset=utf-8",
		".xml":  "application/xml; charset=utf-8",
		".html": "text/html; charset=utf-8",
		".css":  "text/css; charset=utf-8",
		".js":   "application/javascript; charset=utf-8",
		".mjs":  "application/javascript; charset=utf-8",
		".ts":   "text/plain; charset=utf-8",
		".go":   "text/plain; charset=utf-8",
		".py":   "text/plain; charset=utf-8",
		".rs":   "text/plain; charset=utf-8",
		".sh":   "text/plain; charset=utf-8",
		".sql":  "text/plain; charset=utf-8",
		".svg":  "image/svg+xml",
		".webp": "image/webp",
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".ico":  "image/x-icon",
		".mp4":  "video/mp4",
		".webm": "video/webm",
		".mp3":  "audio/mpeg",
		".wav":  "audio/wav",
		".ogg":  "audio/ogg",
		".pdf":  "application/pdf",
		".wasm": "application/wasm",
	}
	if m, ok := extMap[ext]; ok {
		return m
	}
	if ext != "" {
		if m := mime.TypeByExtension(ext); m != "" {
			return m
		}
	}
	if sniffedType != "" {
		return sniffedType
	}
	return "application/octet-stream"
}

// PutObjectFromStream 流式接收文件、写入 CAS 并在数据库事务中更新对象与引用计数
func (s *Store) PutObjectFromStream(bucket, rawKey string, r io.Reader, contentType string, customMeta map[string]string) (*Object, error) {
	return s.PutObjectFromStreamWithOptions(bucket, rawKey, r, contentType, customMeta, WriteOptions{})
}

// PutObjectFromStreamWithOptions 支持大小限制、配额预检、SHA256/MD5 校验及尾部斜杠目录识别的流式上传
func (s *Store) PutObjectFromStreamWithOptions(bucket, rawKey string, r io.Reader, contentType string, customMeta map[string]string, opts WriteOptions) (*Object, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	cleanedRaw := strings.ReplaceAll(strings.TrimSpace(rawKey), "\\", "/")

	// 若以 '/' 结尾：探测流是否为空。空流视为创建目录（兼容 S3 chunked 模式下 ContentLength=-1 的目录创建请求），非空流报错拒绝
	if strings.HasSuffix(cleanedRaw, "/") {
		var probe [1]byte
		n, err := r.Read(probe[:])
		if n == 0 && (err == nil || errors.Is(err, io.EOF)) {
			return s.CreateFolder(bucket, rawKey)
		}
		return nil, ErrInvalidKey
	}

	key, err := NormalizeObjectKey(rawKey, false)
	if err != nil {
		return nil, err
	}
	b, err := s.GetBucket(bucket)
	if err != nil {
		return nil, err
	}

	// 流式落盘前进行存储桶配额上限计算（包含已暂存分片），超配额时在流写入中途立即断流，避免写满磁盘
	if b.QuotaBytes > 0 {
		var oldSize int64
		_ = s.db.QueryRow(`SELECT size_bytes FROM objects WHERE bucket = ? AND key = ? AND is_folder = 0`, bucket, key).Scan(&oldSize)
		staged := s.getBucketStagedMultipartBytes(bucket, "", 0)
		remainingQuota := b.QuotaBytes - b.UsedBytes - staged + oldSize
		if remainingQuota < 0 {
			return nil, ErrQuotaExceeded
		}
		r = &quotaLimitReader{r: r, remaining: remainingQuota}
	}

	writeRes, err := s.cas.WriteStreamToTemp(r, opts)
	if err != nil {
		return nil, err
	}
	defer s.cas.DiscardTempBlob(writeRes.TmpPath)

	finalType := ResolveContentType(key, contentType, writeRes.SniffedContentType)

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.saveBlobObjectLocked(bucket, key, writeRes.SHA256, writeRes.MD5, writeRes.SizeBytes, finalType, customMeta, writeRes.TmpPath)
}

type quotaLimitReader struct {
	r         io.Reader
	remaining int64
}

func (q *quotaLimitReader) Read(p []byte) (int, error) {
	n, err := q.r.Read(p)
	if n > 0 {
		q.remaining -= int64(n)
		if q.remaining < 0 {
			return n, ErrQuotaExceeded
		}
	}
	return n, err
}

// TryFastUpload 秒传探测与绑定：全程在 Store 写锁保护下校验物理块与引用计数，彻底消除与 DeleteObject 的 TOCTOU 竞态
func (s *Store) TryFastUpload(bucket, rawKey, sha256Hex, contentType string, customMeta map[string]string) (*Object, bool, error) {
	return s.TryFastUploadScoped(bucket, rawKey, sha256Hex, contentType, customMeta, true, nil)
}

// TryFastUploadScoped 带存储桶访问域隔离的秒传探测与绑定：
// 若调用方并非管理员或全局通配密钥（canReadAllBuckets == false），则仅当目标 SHA-256 物理块已在目标桶、公开读桶或该密钥有权访问的桶中存在对象引用时才允许秒传，防止受限 AK 通过猜测 SHA-256 跨租户窃取私有文件内容。
func (s *Store) TryFastUploadScoped(bucket, rawKey, sha256Hex, contentType string, customMeta map[string]string, canReadAllBuckets bool, allowedBuckets []string) (*Object, bool, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	key, err := NormalizeObjectKey(rawKey, false)
	if err != nil {
		return nil, false, err
	}
	sha256Hex = strings.ToLower(strings.TrimSpace(sha256Hex))
	if len(sha256Hex) != 64 || !isHexString(sha256Hex) {
		return nil, false, nil
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if !s.cas.HasBlob(sha256Hex) {
		return nil, false, nil
	}

	var md5Hex string
	var sizeBytes int64
	err = s.db.QueryRow(`SELECT md5, size_bytes FROM blobs WHERE sha256 = ? AND ref_count > 0`, sha256Hex).Scan(&md5Hex, &sizeBytes)
	if err != nil {
		return nil, false, nil
	}

	if !canReadAllBuckets {
		allowedSet := make(map[string]struct{}, len(allowedBuckets)+1)
		allowedSet[bucket] = struct{}{}
		for _, ab := range allowedBuckets {
			ab = strings.ToLower(strings.TrimSpace(ab))
			if ab != "" {
				allowedSet[ab] = struct{}{}
			}
		}

		rows, qErr := s.db.Query(`
			SELECT DISTINCT o.bucket, b.visibility
			FROM objects o
			JOIN buckets b ON b.name = o.bucket
			WHERE o.blob_sha256 = ? AND o.is_folder = 0
		`, sha256Hex)
		if qErr != nil {
			return nil, false, nil
		}
		authorized := false
		for rows.Next() {
			var objBucket, vis string
			if err := rows.Scan(&objBucket, &vis); err == nil {
				if vis == "public-read" {
					authorized = true
					break
				}
				if _, ok := allowedSet[strings.ToLower(objBucket)]; ok {
					authorized = true
					break
				}
			}
		}
		_ = rows.Close()
		if !authorized {
			return nil, false, nil
		}
	}

	finalType := ResolveContentType(key, contentType, "")
	obj, err := s.saveBlobObjectLocked(bucket, key, sha256Hex, md5Hex, sizeBytes, finalType, customMeta, "")
	if err != nil {
		return nil, false, err
	}
	return obj, true, nil
}

// SaveBlobObject 将已落盘的 CAS 物理块绑定到指定 (bucket, key)
func (s *Store) SaveBlobObject(bucket, key, sha256Hex, md5Hex string, sizeBytes int64, contentType string, customMeta map[string]string) (*Object, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.saveBlobObjectLocked(bucket, key, sha256Hex, md5Hex, sizeBytes, contentType, customMeta, "")
}

// saveBlobObjectLocked 在调用方已持有 s.writeMu 的前提下，原子完成临时块转正、配额复核、引用计数维护与元数据 Upsert
func (s *Store) saveBlobObjectLocked(bucket, key, sha256Hex, md5Hex string, sizeBytes int64, contentType string, customMeta map[string]string, tmpPath string) (*Object, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))

	var quotaBytes, usedBytes int64
	err := s.db.QueryRow(`SELECT quota_bytes, used_bytes FROM buckets WHERE name = ?`, bucket).Scan(&quotaBytes, &usedBytes)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrBucketNotFound
		}
		return nil, err
	}

	metaJSON := "{}"
	if len(customMeta) > 0 {
		if bData, err := json.Marshal(customMeta); err == nil {
			metaJSON = string(bData)
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	// 查询是否已有同名文件对象
	var oldSHA sql.NullString
	var oldSize int64
	var oldIsFolder int
	err = tx.QueryRow(`SELECT blob_sha256, size_bytes, is_folder FROM objects WHERE bucket = ? AND key = ?`, bucket, key).Scan(&oldSHA, &oldSize, &oldIsFolder)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	existedFile := err == nil && oldIsFolder == 0

	// 事务内严格复核存储桶配额
	if quotaBytes > 0 {
		projected := usedBytes - oldSize + sizeBytes
		if projected > quotaBytes {
			return nil, ErrQuotaExceeded
		}
	}

	// 在写锁保护下将临时文件原子转入 CAS blobs 目录（若已存在同名物理块但大小不符则自动覆盖修复损坏块）
	if tmpPath != "" {
		if err := s.cas.CommitTempBlob(tmpPath, sha256Hex, sizeBytes); err != nil {
			return nil, err
		}
	} else if !s.cas.HasBlob(sha256Hex) {
		return nil, errors.New("底层 CAS 物理块不存在")
	}

	now := time.Now().UTC()
	var zeroRefOldBlob string

	if !existedFile || oldSHA.String != sha256Hex {
		res, err := tx.Exec(`UPDATE blobs SET ref_count = ref_count + 1 WHERE sha256 = ?`, sha256Hex)
		if err != nil {
			return nil, err
		}
		rowsAff, _ := res.RowsAffected()
		if rowsAff == 0 {
			if _, err := tx.Exec(
				`INSERT INTO blobs (sha256, md5, size_bytes, ref_count, created_at) VALUES (?, ?, ?, 1, ?)`,
				sha256Hex, md5Hex, sizeBytes, now,
			); err != nil {
				return nil, err
			}
		}

		// 若覆盖了旧物理块，扣减旧物理块的引用计数
		if existedFile && oldSHA.Valid && oldSHA.String != "" {
			if _, err := tx.Exec(`UPDATE blobs SET ref_count = ref_count - 1 WHERE sha256 = ?`, oldSHA.String); err != nil {
				return nil, err
			}
			var rem int64
			if err := tx.QueryRow(`SELECT ref_count FROM blobs WHERE sha256 = ?`, oldSHA.String).Scan(&rem); err == nil && rem <= 0 {
				_, _ = tx.Exec(`DELETE FROM blobs WHERE sha256 = ?`, oldSHA.String)
				zeroRefOldBlob = oldSHA.String
			}
		}
	}

	// 自动确保所有祖先虚拟文件夹记录存在
	if err := ensureAncestorFoldersTx(tx, bucket, key, now); err != nil {
		return nil, err
	}

	parentDir, _ := ExtractParentAndName(key)
	etag := md5Hex
	if etag == "" && len(sha256Hex) >= 32 {
		etag = sha256Hex[:32]
	}

	// 使用 ON CONFLICT(bucket, key) DO UPDATE 保证并发或覆盖写入的幂等性
	_, err = tx.Exec(`
		INSERT INTO objects (bucket, key, parent_dir, is_folder, blob_sha256, size_bytes, content_type, etag, custom_meta, updated_at)
		VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(bucket, key) DO UPDATE SET
			parent_dir   = excluded.parent_dir,
			is_folder    = 0,
			blob_sha256  = excluded.blob_sha256,
			size_bytes   = excluded.size_bytes,
			content_type = excluded.content_type,
			etag         = excluded.etag,
			custom_meta  = excluded.custom_meta,
			updated_at   = excluded.updated_at
	`, bucket, key, parentDir, sha256Hex, sizeBytes, contentType, etag, metaJSON, now)
	if err != nil {
		return nil, err
	}

	// 增量更新存储桶的 object_count 与 used_bytes
	var deltaCount int64 = 1
	if existedFile {
		deltaCount = 0
	}
	deltaBytes := sizeBytes - oldSize
	if _, err := tx.Exec(`
		UPDATE buckets
		SET object_count = MAX(0, object_count + ?),
		    used_bytes   = MAX(0, used_bytes + ?)
		WHERE name = ?
	`, deltaCount, deltaBytes, bucket); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	// 仍在 s.writeMu 锁保护内删除 0 引用旧块，杜绝删写竞态
	if zeroRefOldBlob != "" {
		_ = s.cas.DeleteBlob(zeroRefOldBlob)
	}

	return s.GetObject(bucket, key)
}

// CreateFolder 创建显式虚拟文件夹（支持多级路径自动创建）
func (s *Store) CreateFolder(bucket, rawFolderKey string) (*Object, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	folderKey, err := NormalizeObjectKey(rawFolderKey, true)
	if err != nil {
		return nil, err
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var exists int
	if err := s.db.QueryRow(`SELECT 1 FROM buckets WHERE name = ?`, bucket).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrBucketNotFound
		}
		return nil, err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	if err := ensureAncestorFoldersTx(tx, bucket, folderKey, now); err != nil {
		return nil, err
	}

	parentDir, _ := ExtractParentAndName(folderKey)
	_, err = tx.Exec(`
		INSERT INTO objects (bucket, key, parent_dir, is_folder, blob_sha256, size_bytes, content_type, etag, custom_meta, updated_at)
		VALUES (?, ?, ?, 1, NULL, 0, 'application/x-directory', '', '{}', ?)
		ON CONFLICT(bucket, key) DO UPDATE SET
			updated_at = excluded.updated_at
		WHERE objects.is_folder = 1
	`, bucket, folderKey, parentDir, now)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetObject(bucket, folderKey)
}

func ensureAncestorFoldersTx(tx *sql.Tx, bucket, key string, now time.Time) error {
	trimmed := strings.TrimSuffix(key, "/")
	parts := strings.Split(trimmed, "/")
	if len(parts) <= 1 {
		return nil
	}
	current := ""
	for i := 0; i < len(parts)-1; i++ {
		parent := current
		current = current + parts[i] + "/"
		_, err := tx.Exec(`
			INSERT OR IGNORE INTO objects (bucket, key, parent_dir, is_folder, blob_sha256, size_bytes, content_type, etag, custom_meta, updated_at)
			VALUES (?, ?, ?, 1, NULL, 0, 'application/x-directory', '', '{}', ?)
		`, bucket, current, parent, now)
		if err != nil {
			return err
		}
	}
	return nil
}

// GetObject 查询单个对象元数据
func (s *Store) GetObject(bucket, rawKey string) (*Object, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	isFolder := strings.HasSuffix(strings.ReplaceAll(strings.TrimSpace(rawKey), "\\", "/"), "/")
	key, err := NormalizeObjectKey(rawKey, isFolder)
	if err != nil {
		return nil, err
	}

	row := s.db.QueryRow(`
		SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
		FROM objects
		WHERE bucket = ? AND key = ?
	`, bucket, key)

	obj, err := scanObjectRow(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrObjectNotFound
		}
		return nil, err
	}
	return obj, nil
}

// CopyObject 零拷贝复制对象或递归零拷贝复制整个文件夹（仅增加 CAS 引用计数与元数据，毫秒级完成）
func (s *Store) CopyObject(srcBucket, srcKey, dstBucket, dstKey string) (*Object, error) {
	srcBucket = strings.ToLower(strings.TrimSpace(srcBucket))
	dstBucket = strings.ToLower(strings.TrimSpace(dstBucket))
	srcObj, err := s.GetObject(srcBucket, srcKey)
	if err != nil {
		return nil, err
	}

	// 若源对象为文件夹，递归零拷贝复制其下所有子文件夹与文件对象（复制前预检目标桶总配额，防止半途失败）
	if srcObj.IsFolder {
		dstFolderKey, err := NormalizeObjectKey(dstKey, true)
		if err != nil {
			return nil, err
		}
		dstB, err := s.GetBucket(dstBucket)
		if err != nil {
			return nil, err
		}

		upper := prefixUpperBound(srcObj.Key)
		var rows *sql.Rows
		if upper != "" {
			rows, err = s.db.Query(`
				SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
				FROM objects
				WHERE bucket = ? AND key > ? AND key < ? AND substr(key, 1, length(?)) = ?
				ORDER BY is_folder DESC, key ASC
			`, srcBucket, srcObj.Key, upper, srcObj.Key, srcObj.Key)
		} else {
			rows, err = s.db.Query(`
				SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
				FROM objects
				WHERE bucket = ? AND key > ? AND substr(key, 1, length(?)) = ?
				ORDER BY is_folder DESC, key ASC
			`, srcBucket, srcObj.Key, srcObj.Key, srcObj.Key)
		}
		if err != nil {
			return nil, err
		}
		var children []*Object
		var totalCopyBytes int64
		for rows.Next() {
			if child, scanErr := scanObjectRow(rows); scanErr == nil {
				children = append(children, child)
				if !child.IsFolder {
					totalCopyBytes += child.SizeBytes
				}
			}
		}
		_ = rows.Close()

		if dstB.QuotaBytes > 0 && dstB.UsedBytes+totalCopyBytes > dstB.QuotaBytes {
			return nil, ErrQuotaExceeded
		}

		rootFolder, err := s.CreateFolder(dstBucket, dstFolderKey)
		if err != nil {
			return nil, err
		}

		for _, child := range children {
			relPath := strings.TrimPrefix(child.Key, srcObj.Key)
			targetChildKey := dstFolderKey + relPath
			if child.IsFolder {
				if _, err := s.CreateFolder(dstBucket, targetChildKey); err != nil {
					return nil, err
				}
			} else {
				if _, err := s.SaveBlobObject(dstBucket, targetChildKey, child.BlobSHA256, child.ETag, child.SizeBytes, child.ContentType, child.CustomMeta); err != nil {
					return nil, err
				}
			}
		}
		return rootFolder, nil
	}

	normDstKey, err := NormalizeObjectKey(dstKey, false)
	if err != nil {
		return nil, err
	}
	return s.SaveBlobObject(dstBucket, normDstKey, srcObj.BlobSHA256, srcObj.ETag, srcObj.SizeBytes, srcObj.ContentType, srcObj.CustomMeta)
}

// DeleteObject 删除单个对象或递归删除文件夹（供 REST API 与管理后台调用）
func (s *Store) DeleteObject(bucket, rawKey string) (int64, error) {
	return s.DeleteObjectWithMode(bucket, rawKey, true)
}

// DeleteObjectWithMode 删除对象。当 recursive=false 且目标以 '/' 结尾时，仅删除该 0 字节目录 marker 本身而不递归删除子对象（严格对齐 AWS S3 DELETE 语义）。
func (s *Store) DeleteObjectWithMode(bucket, rawKey string, recursive bool) (int64, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	isFolder := strings.HasSuffix(strings.ReplaceAll(strings.TrimSpace(rawKey), "\\", "/"), "/")
	key, err := NormalizeObjectKey(rawKey, isFolder)
	if err != nil {
		return 0, err
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	var rows *sql.Rows
	upper := prefixUpperBound(key)
	if isFolder && recursive {
		if upper != "" {
			rows, err = tx.Query(`
				SELECT key, is_folder, COALESCE(blob_sha256, ''), size_bytes
				FROM objects
				WHERE bucket = ? AND key >= ? AND key < ? AND substr(key, 1, length(?)) = ?
			`, bucket, key, upper, key, key)
		} else {
			rows, err = tx.Query(`
				SELECT key, is_folder, COALESCE(blob_sha256, ''), size_bytes
				FROM objects
				WHERE bucket = ? AND key >= ? AND substr(key, 1, length(?)) = ?
			`, bucket, key, key, key)
		}
	} else {
		rows, err = tx.Query(`
			SELECT key, is_folder, COALESCE(blob_sha256, ''), size_bytes
			FROM objects
			WHERE bucket = ? AND key = ?
		`, bucket, key)
	}
	if err != nil {
		return 0, err
	}

	type targetItem struct {
		key      string
		isFolder int
		sha      string
		size     int64
	}
	var targets []targetItem
	for rows.Next() {
		var t targetItem
		if err := rows.Scan(&t.key, &t.isFolder, &t.sha, &t.size); err != nil {
			_ = rows.Close()
			return 0, err
		}
		targets = append(targets, t)
	}
	_ = rows.Close()

	if len(targets) == 0 {
		return 0, ErrObjectNotFound
	}

	var zeroRefBlobs []string
	var removedFiles int64
	var removedBytes int64

	for _, t := range targets {
		if t.isFolder == 0 {
			removedFiles++
			removedBytes += t.size
			if t.sha != "" {
				if _, err := tx.Exec(`UPDATE blobs SET ref_count = ref_count - 1 WHERE sha256 = ?`, t.sha); err != nil {
					return 0, err
				}
				var rem int64
				if err := tx.QueryRow(`SELECT ref_count FROM blobs WHERE sha256 = ?`, t.sha).Scan(&rem); err == nil && rem <= 0 {
					_, _ = tx.Exec(`DELETE FROM blobs WHERE sha256 = ?`, t.sha)
					zeroRefBlobs = append(zeroRefBlobs, t.sha)
				}
			}
		}
	}

	var delRes sql.Result
	if isFolder && recursive {
		if upper != "" {
			delRes, err = tx.Exec(`
				DELETE FROM objects
				WHERE bucket = ? AND key >= ? AND key < ? AND substr(key, 1, length(?)) = ?
			`, bucket, key, upper, key, key)
		} else {
			delRes, err = tx.Exec(`
				DELETE FROM objects
				WHERE bucket = ? AND key >= ? AND substr(key, 1, length(?)) = ?
			`, bucket, key, key, key)
		}
	} else {
		delRes, err = tx.Exec(`DELETE FROM objects WHERE bucket = ? AND key = ?`, bucket, key)
	}
	if err != nil {
		return 0, err
	}
	deletedCount, _ := delRes.RowsAffected()

	if removedFiles > 0 || removedBytes > 0 {
		if _, err := tx.Exec(`
			UPDATE buckets
			SET object_count = MAX(0, object_count - ?),
			    used_bytes   = MAX(0, used_bytes - ?)
			WHERE name = ?
		`, removedFiles, removedBytes, bucket); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	for _, sha := range zeroRefBlobs {
		_ = s.cas.DeleteBlob(sha)
	}
	return deletedCount, nil
}
