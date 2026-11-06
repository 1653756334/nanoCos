package store

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

var (
	ErrInvalidCredentials = errors.New("用户名或密码错误")
	ErrWeakPassword       = errors.New("密码长度不能少于 6 位")
	ErrEmptyUsername      = errors.New("管理员用户名不能为空")
)

const (
	pbkdf2DefaultIterations = 600000 // OWASP 推荐的 PBKDF2-HMAC-SHA256 迭代次数 (600,000 轮)
	pbkdf2KeyLength         = 32
	legacyHashIterations    = 60000
)

// AdminAccount 表示持久化的控制台管理员账户元信息（不含密码明文）
type AdminAccount struct {
	Username     string    `json:"username"`
	TokenVersion int64     `json:"tokenVersion"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// EnsureAdminAccount 确保管理员账户已初始化。
// 若数据库中尚无管理员记录（首次初始化），则使用传入的 initUser/initPass（若 initPass 为空则生成 16 位高强度随机密码）写入数据库，
// 并返回明文密码供控制台首次且唯一一次打印；后续启动 createdNew=false 且 plainPassword 返回空字符串。
func (s *Store) EnsureAdminAccount(initUser, initPass string) (username string, plainPassword string, createdNew bool, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var existingUser string
	err = s.db.QueryRow(`SELECT username FROM admin_account WHERE id = 1`).Scan(&existingUser)
	if err == nil {
		return existingUser, "", false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", "", false, err
	}

	username = strings.TrimSpace(initUser)
	if username == "" {
		username = "admin"
	}

	plainPassword = strings.TrimSpace(initPass)
	if plainPassword == "" {
		plainPassword, err = generateRandomPassword(16)
		if err != nil {
			return "", "", false, err
		}
	}

	salt, hash, err := hashPassword(plainPassword)
	if err != nil {
		return "", "", false, err
	}

	now := time.Now().UTC()
	_, err = s.db.Exec(`
		INSERT INTO admin_account (id, username, password_salt, password_hash, token_version, updated_at)
		VALUES (1, ?, ?, ?, 1, ?)
	`, username, salt, hash, now)
	if err != nil {
		return "", "", false, err
	}

	return username, plainPassword, true, nil
}

// VerifyAdminCredentials 校验管理员登录用户名与密码，成功时返回账户详情与当前 tokenVersion
func (s *Store) VerifyAdminCredentials(username, password string) (*AdminAccount, bool) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return nil, false
	}

	var acc AdminAccount
	var salt, storedHash string
	err := s.db.QueryRow(`
		SELECT username, password_salt, password_hash, token_version, updated_at
		FROM admin_account
		WHERE id = 1
	`).Scan(&acc.Username, &salt, &storedHash, &acc.TokenVersion, &acc.UpdatedAt)
	if err != nil {
		return nil, false
	}

	if !hmac.Equal([]byte(acc.Username), []byte(username)) {
		return nil, false
	}
	matched, needsUpgrade := verifyPasswordHash(password, salt, storedHash)
	if !matched {
		return nil, false
	}
	if needsUpgrade {
		// 平滑密码学升级：若旧库使用的是旧版哈希，登录验证成功后自动就地重哈希升级为标准 PBKDF2-SHA256 (600,000 轮)
		if newSalt, newHash, hErr := hashPassword(password); hErr == nil {
			s.writeMu.Lock()
			_, _ = s.db.Exec(`UPDATE admin_account SET password_salt = ?, password_hash = ? WHERE id = 1`, newSalt, newHash)
			s.writeMu.Unlock()
		}
	}
	return &acc, true
}

// GetAdminAccount 查询当前管理员账户信息与 tokenVersion
func (s *Store) GetAdminAccount() (*AdminAccount, error) {
	var acc AdminAccount
	err := s.db.QueryRow(`
		SELECT username, token_version, updated_at
		FROM admin_account
		WHERE id = 1
	`).Scan(&acc.Username, &acc.TokenVersion, &acc.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &acc, nil
}

// ResetAdminCredentials 供命令行工具 (cosd passwd) 或在线修改密码调用，更新用户名/密码并自增 token_version 使旧会话立即失效。
// 若 newUsername 为空则保持原用户名不变；若 newPassword 为空则自动生成 16 位随机密码并返回。
func (s *Store) ResetAdminCredentials(newUsername, newPassword string) (finalUser string, finalPlainPass string, err error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var currentUser string
	err = s.db.QueryRow(`SELECT username FROM admin_account WHERE id = 1`).Scan(&currentUser)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", "", err
	}

	finalUser = strings.TrimSpace(newUsername)
	if finalUser == "" {
		if currentUser != "" {
			finalUser = currentUser
		} else {
			finalUser = "admin"
		}
	}

	finalPlainPass = strings.TrimSpace(newPassword)
	if finalPlainPass == "" {
		finalPlainPass, err = generateRandomPassword(16)
		if err != nil {
			return "", "", err
		}
	} else if len(finalPlainPass) < 6 {
		return "", "", ErrWeakPassword
	}

	salt, hash, err := hashPassword(finalPlainPass)
	if err != nil {
		return "", "", err
	}

	now := time.Now().UTC()
	if exists {
		_, err = s.db.Exec(`
			UPDATE admin_account
			SET username = ?, password_salt = ?, password_hash = ?, token_version = token_version + 1, updated_at = ?
			WHERE id = 1
		`, finalUser, salt, hash, now)
	} else {
		_, err = s.db.Exec(`
			INSERT INTO admin_account (id, username, password_salt, password_hash, token_version, updated_at)
			VALUES (1, ?, ?, ?, 1, ?)
		`, finalUser, salt, hash, now)
	}
	if err != nil {
		return "", "", err
	}
	return finalUser, finalPlainPass, nil
}

// UpdateAdminCredentialsWithVerify 在线修改管理员用户名与密码（需先校验原密码）
func (s *Store) UpdateAdminCredentialsWithVerify(currentPassword, newUsername, newPassword string) (*AdminAccount, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var currentUser, salt, storedHash string
	err := s.db.QueryRow(`
		SELECT username, password_salt, password_hash
		FROM admin_account
		WHERE id = 1
	`).Scan(&currentUser, &salt, &storedHash)
	if err != nil {
		return nil, err
	}

	if matched, _ := verifyPasswordHash(currentPassword, salt, storedHash); !matched {
		return nil, ErrInvalidCredentials
	}

	targetUser := strings.TrimSpace(newUsername)
	if targetUser == "" {
		targetUser = currentUser
	}
	targetPass := strings.TrimSpace(newPassword)
	newSalt, newHash := salt, storedHash
	if targetPass != "" {
		if len(targetPass) < 6 {
			return nil, ErrWeakPassword
		}
		newSalt, newHash, err = hashPassword(targetPass)
		if err != nil {
			return nil, err
		}
	}

	now := time.Now().UTC()
	if _, err := s.db.Exec(`
		UPDATE admin_account
		SET username = ?, password_salt = ?, password_hash = ?, token_version = token_version + 1, updated_at = ?
		WHERE id = 1
	`, targetUser, newSalt, newHash, now); err != nil {
		return nil, err
	}

	var updated AdminAccount
	err = s.db.QueryRow(`
		SELECT username, token_version, updated_at
		FROM admin_account
		WHERE id = 1
	`).Scan(&updated.Username, &updated.TokenVersion, &updated.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &updated, nil
}

func hashPassword(password string) (saltHex string, hashSpec string, err error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", "", fmt.Errorf("生成密码盐失败: %w", err)
	}
	saltHex = hex.EncodeToString(salt)
	dk, err := pbkdf2.Key(sha256.New, password, salt, pbkdf2DefaultIterations, pbkdf2KeyLength)
	if err != nil {
		return "", "", fmt.Errorf("PBKDF2 密钥派生失败: %w", err)
	}
	hashSpec = fmt.Sprintf("pbkdf2-sha256$%d$%s", pbkdf2DefaultIterations, hex.EncodeToString(dk))
	return saltHex, hashSpec, nil
}

// verifyPasswordHash 校验密码是否匹配。支持带算法与迭代次数前缀的标准格式 ("pbkdf2-sha256$600000$<hex>")，
// 并向后兼容旧版无前缀哈希（匹配成功后标记 needsUpgrade=true 以触发透明升级）。
func verifyPasswordHash(password, saltHex, storedHash string) (matched bool, needsUpgrade bool) {
	if strings.HasPrefix(storedHash, "pbkdf2-sha256$") {
		parts := strings.Split(storedHash, "$")
		if len(parts) != 3 {
			return false, false
		}
		iters, err := strconv.Atoi(parts[1])
		if err != nil || iters < 10000 {
			return false, false
		}
		saltBytes, err := hex.DecodeString(saltHex)
		if err != nil {
			return false, false
		}
		dk, err := pbkdf2.Key(sha256.New, password, saltBytes, iters, pbkdf2KeyLength)
		if err != nil {
			return false, false
		}
		actualHex := hex.EncodeToString(dk)
		if !hmac.Equal([]byte(actualHex), []byte(parts[2])) {
			return false, false
		}
		return true, iters < pbkdf2DefaultIterations
	}

	// 向后兼容旧版哈希格式，验证通过后自动升级至标准 PBKDF2-SHA256
	legacy := deriveLegacyPasswordHash(password, saltHex)
	if hmac.Equal([]byte(legacy), []byte(storedHash)) {
		return true, true
	}
	return false, false
}

func deriveLegacyPasswordHash(password, saltHex string) string {
	key := []byte(password)
	data := []byte("nanocos-admin-salt:" + saltHex)
	var acc [32]byte

	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(data)
	cur := mac.Sum(nil)
	copy(acc[:], cur)

	for i := 1; i < legacyHashIterations; i++ {
		mac.Reset()
		_, _ = mac.Write(cur)
		cur = mac.Sum(cur[:0])
		for j := 0; j < 32; j++ {
			acc[j] ^= cur[j]
		}
	}
	return hex.EncodeToString(acc[:])
}

func generateRandomPassword(length int) (string, error) {
	const charset = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, length)
	max := big.NewInt(int64(len(charset)))
	for i := 0; i < length; i++ {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		buf[i] = charset[n.Int64()]
	}
	return string(buf), nil
}
