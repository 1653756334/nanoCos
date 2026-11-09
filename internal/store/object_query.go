package store

import (
	"database/sql"
	"encoding/json"
	"path"
	"sort"
	"strings"
)

// DirectoryListing 表示 Web 控制台目录树浏览分页结果
type DirectoryListing struct {
	Bucket      string   `json:"bucket"`
	Prefix      string   `json:"prefix"`
	Breadcrumbs []string `json:"breadcrumbs"`
	Items       []Object `json:"items"`
	TotalCount  int64    `json:"totalCount"`
}

// S3ListResult 表示 S3 ListObjects (V1 & V2) 兼容查询结果
type S3ListResult struct {
	Objects        []Object
	CommonPrefixes []string
	IsTruncated    bool
	NextToken      string
}

// PrefixUpperBound 计算精确前缀查询的字典序上界 (供 SQLite B-Tree 索引范围扫描 key >= prefix AND key < upper)
func PrefixUpperBound(prefix string) string {
	return prefixUpperBound(prefix)
}

func prefixUpperBound(prefix string) string {
	b := []byte(prefix)
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] < 0xFF {
			b[i]++
			return string(b[:i+1])
		}
	}
	return ""
}

// escapeLikePattern 转义 SQLite LIKE 模式中的 \, %, _ 特殊字符
func escapeLikePattern(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

func buildBrowseOrderClause(sortBy, sortOrder string) string {
	dir := "ASC"
	switch strings.ToLower(strings.TrimSpace(sortOrder)) {
	case "desc", "descend":
		dir = "DESC"
	}
	switch strings.ToLower(strings.TrimSpace(sortBy)) {
	case "size", "sizebytes", "size_bytes":
		return "is_folder DESC, size_bytes " + dir + ", key ASC"
	case "updatedat", "updated_at":
		return "is_folder DESC, updated_at " + dir + ", key ASC"
	default:
		return "is_folder DESC, key " + dir
	}
}

// BrowseDirectory 供 Web 控制台按目录层级或关键字高速浏览对象（默认按名称升序）
func (s *Store) BrowseDirectory(bucket, prefix, search string, limit, offset int) (*DirectoryListing, error) {
	return s.BrowseDirectorySorted(bucket, prefix, search, limit, offset, "key", "asc")
}

// BrowseDirectorySorted 供 Web 控制台按目录层级、关键字及指定字段排序高速浏览对象
func (s *Store) BrowseDirectorySorted(bucket, prefix, search string, limit, offset int, sortBy, sortOrder string) (*DirectoryListing, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	if _, err := s.GetBucket(bucket); err != nil {
		return nil, err
	}

	prefix = strings.ReplaceAll(strings.TrimSpace(prefix), "\\", "/")
	prefix = strings.TrimLeft(prefix, "/")
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}

	orderClause := buildBrowseOrderClause(sortBy, sortOrder)
	search = strings.TrimSpace(search)
	var total int64
	var rows *sql.Rows
	var err error

	if search != "" {
		likePattern := "%" + escapeLikePattern(search) + "%"
		if prefix == "" {
			if err := s.db.QueryRow(
				`SELECT COUNT(*) FROM objects WHERE bucket = ? AND key LIKE ? ESCAPE '\'`,
				bucket, likePattern,
			).Scan(&total); err != nil {
				return nil, err
			}
			rows, err = s.db.Query(`
				SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
				FROM objects
				WHERE bucket = ? AND key LIKE ? ESCAPE '\'
				ORDER BY `+orderClause+`
				LIMIT ? OFFSET ?
			`, bucket, likePattern, limit, offset)
		} else {
			if err := s.db.QueryRow(
				`SELECT COUNT(*) FROM objects WHERE bucket = ? AND substr(key, 1, length(?)) = ? AND key LIKE ? ESCAPE '\'`,
				bucket, prefix, prefix, likePattern,
			).Scan(&total); err != nil {
				return nil, err
			}
			rows, err = s.db.Query(`
				SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
				FROM objects
				WHERE bucket = ? AND substr(key, 1, length(?)) = ? AND key LIKE ? ESCAPE '\'
				ORDER BY `+orderClause+`
				LIMIT ? OFFSET ?
			`, bucket, prefix, prefix, likePattern, limit, offset)
		}
	} else {
		if err := s.db.QueryRow(
			`SELECT COUNT(*) FROM objects WHERE bucket = ? AND parent_dir = ?`,
			bucket, prefix,
		).Scan(&total); err != nil {
			return nil, err
		}
		rows, err = s.db.Query(`
			SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
			FROM objects
			WHERE bucket = ? AND parent_dir = ?
			ORDER BY `+orderClause+`
			LIMIT ? OFFSET ?
		`, bucket, prefix, limit, offset)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []Object
	for rows.Next() {
		obj, err := scanObjectRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *obj)
	}
	if items == nil {
		items = []Object{}
	}

	var crumbs []string
	if prefix != "" {
		parts := strings.Split(strings.TrimSuffix(prefix, "/"), "/")
		acc := ""
		for _, p := range parts {
			if p != "" {
				acc += p + "/"
				crumbs = append(crumbs, acc)
			}
		}
	}
	if crumbs == nil {
		crumbs = []string{}
	}

	return &DirectoryListing{
		Bucket:      bucket,
		Prefix:      prefix,
		Breadcrumbs: crumbs,
		Items:       items,
		TotalCount:  total,
	}, nil
}

// ListObjectsS3 支持 S3 协议的 prefix + delimiter 列表查询（精确前缀范围索引 + SQL LIMIT 优化）
func (s *Store) ListObjectsS3(bucket, prefix, delimiter string, maxKeys int, startAfter string) (*S3ListResult, error) {
	bucket = strings.ToLower(strings.TrimSpace(bucket))
	if _, err := s.GetBucket(bucket); err != nil {
		return nil, err
	}
	if maxKeys <= 0 || maxKeys > 1000 {
		maxKeys = 1000
	}

	var rows *sql.Rows
	var err error

	// 当无 delimiter 时，直接在 SQL 层通过 LIMIT maxKeys+1 截断，避免扫全表
	if delimiter == "" {
		if prefix == "" {
			rows, err = s.db.Query(`
				SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
				FROM objects
				WHERE bucket = ? AND is_folder = 0 AND key > ?
				ORDER BY key ASC
				LIMIT ?
			`, bucket, startAfter, maxKeys+1)
		} else {
			upper := prefixUpperBound(prefix)
			lower := prefix
			if startAfter > lower {
				lower = startAfter
			}
			if upper != "" {
				rows, err = s.db.Query(`
					SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
					FROM objects
					WHERE bucket = ? AND is_folder = 0 AND key >= ? AND key < ? AND key > ? AND substr(key, 1, length(?)) = ?
					ORDER BY key ASC
					LIMIT ?
				`, bucket, lower, upper, startAfter, prefix, prefix, maxKeys+1)
			} else {
				rows, err = s.db.Query(`
					SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
					FROM objects
					WHERE bucket = ? AND is_folder = 0 AND key > ? AND substr(key, 1, length(?)) = ?
					ORDER BY key ASC
					LIMIT ?
				`, bucket, startAfter, prefix, prefix, maxKeys+1)
			}
		}
	} else {
		if prefix == "" {
			rows, err = s.db.Query(`
				SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
				FROM objects
				WHERE bucket = ? AND is_folder = 0 AND key > ?
				ORDER BY key ASC
			`, bucket, startAfter)
		} else {
			upper := prefixUpperBound(prefix)
			lower := prefix
			if startAfter > lower {
				lower = startAfter
			}
			if upper != "" {
				rows, err = s.db.Query(`
					SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
					FROM objects
					WHERE bucket = ? AND is_folder = 0 AND key >= ? AND key < ? AND key > ? AND substr(key, 1, length(?)) = ?
					ORDER BY key ASC
				`, bucket, lower, upper, startAfter, prefix, prefix)
			} else {
				rows, err = s.db.Query(`
					SELECT id, bucket, key, parent_dir, is_folder, COALESCE(blob_sha256, ''), size_bytes, content_type, etag, custom_meta, updated_at
					FROM objects
					WHERE bucket = ? AND is_folder = 0 AND key > ? AND substr(key, 1, length(?)) = ?
					ORDER BY key ASC
				`, bucket, startAfter, prefix, prefix)
			}
		}
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	res := &S3ListResult{
		Objects:        []Object{},
		CommonPrefixes: []string{},
	}
	prefixSet := make(map[string]struct{})
	count := 0
	var lastScannedKey string

	for rows.Next() {
		obj, err := scanObjectRow(rows)
		if err != nil {
			return nil, err
		}
		if delimiter != "" && strings.HasPrefix(obj.Key, prefix) {
			rest := strings.TrimPrefix(obj.Key, prefix)
			if idx := strings.Index(rest, delimiter); idx >= 0 {
				cp := prefix + rest[:idx+len(delimiter)]
				// 若客户端把 CommonPrefix (例如 "dir/") 作为 startAfter/marker 传入，则该公共前缀下的全部子对象均属于已翻过的条目
				if startAfter != "" && cp <= startAfter {
					lastScannedKey = obj.Key
					continue
				}
				if _, exists := prefixSet[cp]; exists {
					// 同一公共前缀下的后续 key 直接跳过，不计入 maxKeys，但推进底层扫描游标以防续页死循环
					lastScannedKey = obj.Key
					continue
				}
				if count >= maxKeys {
					res.IsTruncated = true
					res.NextToken = lastScannedKey
					break
				}
				prefixSet[cp] = struct{}{}
				res.CommonPrefixes = append(res.CommonPrefixes, cp)
				lastScannedKey = obj.Key
				count++
				continue
			}
		}

		if count >= maxKeys {
			res.IsTruncated = true
			res.NextToken = lastScannedKey
			break
		}
		res.Objects = append(res.Objects, *obj)
		lastScannedKey = obj.Key
		count++
	}
	sort.Strings(res.CommonPrefixes)
	return res, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanObjectRow(scanner rowScanner) (*Object, error) {
	var obj Object
	var isFolderInt int
	var metaStr string
	err := scanner.Scan(
		&obj.ID,
		&obj.Bucket,
		&obj.Key,
		&obj.ParentDir,
		&isFolderInt,
		&obj.BlobSHA256,
		&obj.SizeBytes,
		&obj.ContentType,
		&obj.ETag,
		&metaStr,
		&obj.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	obj.IsFolder = isFolderInt == 1
	_, name := ExtractParentAndName(obj.Key)
	if name == "" {
		name = path.Base(obj.Key)
	}
	obj.Name = name
	if metaStr != "" && metaStr != "{}" {
		_ = json.Unmarshal([]byte(metaStr), &obj.CustomMeta)
	}
	return &obj, nil
}
