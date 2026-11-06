package store

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

var (
	ErrHashMismatch    = errors.New("数据完整性校验失败：SHA-256 与客户端声明不一致")
	ErrMD5Mismatch     = errors.New("数据完整性校验失败：Content-MD5 与客户端声明不一致")
	ErrPayloadTooLarge = errors.New("上传数据超出最大允许体积限制")
)

// WriteOptions 控制流式写入时的大小上限与完整性校验参数
type WriteOptions struct {
	MaxBytes          int64  // > 0 时限制最大写入字节数（超出则返回 QuotaOrSizeErr）
	QuotaOrSizeErr    error  // 超出 MaxBytes 时返回的特定错误（默认 ErrPayloadTooLarge）
	ExpectedSHA256    string // 可选：64 位十六进制 SHA-256
	ExpectedMD5       string // 可选：Base64 或 32 位十六进制 MD5
}

// CASEngine 负责内容寻址物理块（Content-Addressable Storage）的流式落盘、分片合并与读取
type CASEngine struct {
	blobsDir     string
	multipartDir string
	tmpDir       string
}

// BlobWriteResult 表示一次流式物理写入或分片合并的结果
type BlobWriteResult struct {
	SHA256             string
	MD5                string
	SizeBytes          int64
	SniffedContentType string
	TmpPath            string // 若由 WriteStreamToTemp 生成，保存待提交的临时文件路径
}

// NewCASEngine 创建 CAS 存储引擎实例
func NewCASEngine(blobsDir, multipartDir, tmpDir string) *CASEngine {
	return &CASEngine{
		blobsDir:     blobsDir,
		multipartDir: multipartDir,
		tmpDir:       tmpDir,
	}
}

// CleanTmpDir 启动时清理 tmp 目录下因异常断电或崩溃残留的临时文件
func (c *CASEngine) CleanTmpDir() error {
	entries, err := os.ReadDir(c.tmpDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		_ = os.RemoveAll(filepath.Join(c.tmpDir, entry.Name()))
	}
	return nil
}

// BlobPath 根据 64 位 SHA-256 哈希计算两级分片物理路径: data/blobs/ab/cd/<sha256>
func (c *CASEngine) BlobPath(sha256Hex string) (string, error) {
	sha256Hex = strings.ToLower(strings.TrimSpace(sha256Hex))
	if len(sha256Hex) != 64 || !isHexString(sha256Hex) {
		return "", fmt.Errorf("非法的 SHA-256 哈希标识: %s", sha256Hex)
	}
	return filepath.Join(c.blobsDir, sha256Hex[0:2], sha256Hex[2:4], sha256Hex), nil
}

// HasBlob 检查物理块文件在磁盘上是否存在
func (c *CASEngine) HasBlob(sha256Hex string) bool {
	p, err := c.BlobPath(sha256Hex)
	if err != nil {
		return false
	}
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// VerifyBlob 校验磁盘上的物理块文件是否完好且 SHA-256 匹配
func (c *CASEngine) VerifyBlob(sha256Hex string) (bool, error) {
	f, err := c.OpenBlob(sha256Hex)
	if err != nil {
		return false, err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false, err
	}
	actual := hex.EncodeToString(h.Sum(nil))
	return strings.EqualFold(actual, sha256Hex), nil
}

// WriteStreamToTemp 将输入流写入临时文件并完成 fsync、SHA-256、MD5、大小上限及完整性校验。
// 临时文件暂不转入 blobsDir，由调用方在持有 Store 写锁的事务中调用 CommitTempBlob 原子转正，彻底消除删写 TOCTOU 竞态。
func (c *CASEngine) WriteStreamToTemp(r io.Reader, opts WriteOptions) (*BlobWriteResult, error) {
	tmpFile, err := os.CreateTemp(c.tmpDir, "upload-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("创建临时上传文件失败: %w", err)
	}
	tmpPath := tmpFile.Name()
	keepTmp := false
	defer func() {
		_ = tmpFile.Close()
		if !keepTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	shaHasher := sha256.New()
	md5Hasher := md5.New()
	sniffBuf := make([]byte, 512)
	sniffN := 0

	buf := make([]byte, 64*1024)
	var totalBytes int64

	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			totalBytes += int64(n)
			if opts.MaxBytes > 0 && totalBytes > opts.MaxBytes {
				if opts.QuotaOrSizeErr != nil {
					return nil, opts.QuotaOrSizeErr
				}
				return nil, ErrPayloadTooLarge
			}

			chunk := buf[:n]
			if sniffN < len(sniffBuf) {
				copied := copy(sniffBuf[sniffN:], chunk)
				sniffN += copied
			}
			if _, wErr := tmpFile.Write(chunk); wErr != nil {
				return nil, fmt.Errorf("写入临时文件失败: %w", wErr)
			}
			_, _ = shaHasher.Write(chunk)
			_, _ = md5Hasher.Write(chunk)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, fmt.Errorf("读取上传数据流失败: %w", readErr)
		}
	}

	shaSum := shaHasher.Sum(nil)
	md5Sum := md5Hasher.Sum(nil)
	shaHex := hex.EncodeToString(shaSum)
	md5Hex := hex.EncodeToString(md5Sum)

	// 校验客户端声明的 SHA-256
	if err := verifyExpectedSHA256(opts.ExpectedSHA256, shaHex); err != nil {
		return nil, err
	}
	// 校验客户端声明的 Content-MD5
	if err := verifyExpectedMD5(opts.ExpectedMD5, md5Sum, md5Hex); err != nil {
		return nil, err
	}

	// 持久化保证：在关闭前执行 fsync 确保文件内容落盘
	if err := tmpFile.Sync(); err != nil {
		return nil, fmt.Errorf("同步临时文件到磁盘失败: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return nil, fmt.Errorf("关闭临时文件失败: %w", err)
	}

	sniffedType := "application/octet-stream"
	if sniffN > 0 {
		sniffedType = http.DetectContentType(sniffBuf[:sniffN])
	}

	keepTmp = true
	return &BlobWriteResult{
		SHA256:             shaHex,
		MD5:                md5Hex,
		SizeBytes:          totalBytes,
		SniffedContentType: sniffedType,
		TmpPath:            tmpPath,
	}, nil
}

// CommitTempBlob 在持有 Store 写锁期间将临时文件原子提升为正式 CAS 物理块。
// 若磁盘上已有同名物理块，必须同时校验其文件大小与 expectedSize 一致才直接复用；若大小不符（如掉电截断残留），强制使用新文件覆盖自愈。
func (c *CASEngine) CommitTempBlob(tmpPath, sha256Hex string, expectedSize int64) error {
	if tmpPath == "" {
		return nil
	}
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	targetPath, err := c.BlobPath(sha256Hex)
	if err != nil {
		return err
	}

	if info, statErr := os.Stat(targetPath); statErr == nil && !info.IsDir() {
		if info.Size() == expectedSize {
			return nil
		}
		// 磁盘已有文件大小不匹配（如断电截断），移除损坏文件后用完整临时文件覆盖自愈
		_ = os.Remove(targetPath)
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return fmt.Errorf("创建物理块分片目录失败: %w", err)
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		if info, statErr := os.Stat(targetPath); statErr == nil && !info.IsDir() && info.Size() == expectedSize {
			return nil
		}
		return fmt.Errorf("原子移动物理块失败: %w", err)
	}
	return nil
}

// DiscardTempBlob 清理未提交的临时文件
func (c *CASEngine) DiscardTempBlob(tmpPath string) {
	if tmpPath != "" {
		_ = os.Remove(tmpPath)
	}
}

// OpenBlob 以只读模式打开 CAS 物理块文件（供 http.ServeContent 进行 Range 读取和流式传输）
func (c *CASEngine) OpenBlob(sha256Hex string) (*os.File, error) {
	p, err := c.BlobPath(sha256Hex)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

// DeleteBlob 删除无引用的物理块文件
func (c *CASEngine) DeleteBlob(sha256Hex string) error {
	p, err := c.BlobPath(sha256Hex)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// PartPath 返回分片上传单个分片的暂存路径
func (c *CASEngine) PartPath(uploadID string, partNumber int) (string, error) {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" || strings.ContainsAny(uploadID, `/\..`) {
		return "", fmt.Errorf("非法的 uploadID")
	}
	return filepath.Join(c.multipartDir, uploadID, fmt.Sprintf("part.%05d", partNumber)), nil
}

// WritePartWithOptions 流式接收并校验单个分片文件（含 fsync 与哈希校验）
func (c *CASEngine) WritePartWithOptions(uploadID string, partNumber int, r io.Reader, opts WriteOptions) (*BlobWriteResult, error) {
	partPath, err := c.PartPath(uploadID, partNumber)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(partPath), 0755); err != nil {
		return nil, fmt.Errorf("创建分片目录失败: %w", err)
	}

	tmpFile, err := os.CreateTemp(c.tmpDir, "part-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("创建分片临时文件失败: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
	}()

	shaHasher := sha256.New()
	md5Hasher := md5.New()
	buf := make([]byte, 64*1024)
	var totalBytes int64

	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			totalBytes += int64(n)
			if opts.MaxBytes > 0 && totalBytes > opts.MaxBytes {
				if opts.QuotaOrSizeErr != nil {
					return nil, opts.QuotaOrSizeErr
				}
				return nil, ErrPayloadTooLarge
			}
			chunk := buf[:n]
			if _, wErr := tmpFile.Write(chunk); wErr != nil {
				return nil, fmt.Errorf("写入分片数据失败: %w", wErr)
			}
			_, _ = shaHasher.Write(chunk)
			_, _ = md5Hasher.Write(chunk)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, fmt.Errorf("读取分片数据失败: %w", readErr)
		}
	}

	shaSum := shaHasher.Sum(nil)
	md5Sum := md5Hasher.Sum(nil)
	shaHex := hex.EncodeToString(shaSum)
	md5Hex := hex.EncodeToString(md5Sum)

	if err := verifyExpectedSHA256(opts.ExpectedSHA256, shaHex); err != nil {
		return nil, err
	}
	if err := verifyExpectedMD5(opts.ExpectedMD5, md5Sum, md5Hex); err != nil {
		return nil, err
	}

	if err := tmpFile.Sync(); err != nil {
		return nil, fmt.Errorf("同步分片文件到磁盘失败: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return nil, err
	}

	if err := os.Rename(tmpPath, partPath); err != nil {
		return nil, fmt.Errorf("保存分片文件失败: %w", err)
	}

	return &BlobWriteResult{
		SHA256:    shaHex,
		MD5:       md5Hex,
		SizeBytes: totalBytes,
	}, nil
}

// MergePartsToTemp 按分片序号顺序流式合并所有分片到临时文件（修复 io.Pipe 泄漏风险）
func (c *CASEngine) MergePartsToTemp(uploadID string, partNumbers []int, opts WriteOptions) (*BlobWriteResult, error) {
	pr, pw := io.Pipe()

	go func() {
		defer pw.Close()
		buf := make([]byte, 64*1024)
		for _, partNum := range partNumbers {
			partPath, err := c.PartPath(uploadID, partNum)
			if err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			f, err := os.Open(partPath)
			if err != nil {
				_ = pw.CloseWithError(fmt.Errorf("打开分片 %d 失败: %w", partNum, err))
				return
			}
			_, copyErr := io.CopyBuffer(pw, f, buf)
			_ = f.Close()
			if copyErr != nil {
				_ = pw.CloseWithError(fmt.Errorf("读取分片 %d 失败: %w", partNum, copyErr))
				return
			}
		}
	}()

	res, err := c.WriteStreamToTemp(pr, opts)
	// 关键修复：无论 WriteStreamToTemp 成功还是提前报错返回，都显式关闭 Pipe 读端以唤醒可能阻塞的写端 goroutine
	if err != nil {
		_ = pr.CloseWithError(err)
	} else {
		_ = pr.Close()
	}
	return res, err
}

// CleanupMultipart 清理指定分片上传任务的临时分片目录
func (c *CASEngine) CleanupMultipart(uploadID string) error {
	uploadID = strings.TrimSpace(uploadID)
	if uploadID == "" || strings.ContainsAny(uploadID, `/\..`) {
		return fmt.Errorf("非法的 uploadID")
	}
	dir := filepath.Join(c.multipartDir, uploadID)
	if err := os.RemoveAll(dir); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func verifyExpectedSHA256(expected, actualHex string) error {
	expected = strings.TrimSpace(expected)
	if expected == "" ||
		strings.EqualFold(expected, "UNSIGNED-PAYLOAD") ||
		strings.HasPrefix(strings.ToUpper(expected), "STREAMING-") {
		return nil
	}
	if !strings.EqualFold(expected, actualHex) {
		return ErrHashMismatch
	}
	return nil
}

func verifyExpectedMD5(expected string, actualSum []byte, actualHex string) error {
	expected = strings.TrimSpace(expected)
	if expected == "" {
		return nil
	}
	// 支持 32 位 Hex 格式
	if len(expected) == 32 && isHexString(strings.ToLower(expected)) {
		if !strings.EqualFold(expected, actualHex) {
			return ErrMD5Mismatch
		}
		return nil
	}
	// 支持标准 HTTP Content-MD5 (Base64 格式)
	decoded, err := base64.StdEncoding.DecodeString(expected)
	if err != nil || !bytes.Equal(decoded, actualSum) {
		return ErrMD5Mismatch
	}
	return nil
}

func isHexString(s string) bool {
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
			return false
		}
	}
	return true
}
