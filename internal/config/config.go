package config

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// AutoLoadDotEnv 尝试在当前工作目录下寻找并加载 .env 文件；若文件不存在则静默跳过
func AutoLoadDotEnv() {
	_ = LoadDotEnv(".env")
}

// LoadDotEnv 从指定路径解析 dotenv 格式文件并注入环境变量（系统原有环境变量优先级更高，不被覆盖）
func LoadDotEnv(filename string) error {
	f, err := os.Open(filename)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	return ParseEnvReader(f)
}

// ParseEnvReader 解析任意 io.Reader 中的 KEY=VALUE 格式并注入当前进程环境变量
func ParseEnvReader(r io.Reader) error {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		key, val, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		val = strings.TrimSpace(val)
		if len(val) >= 2 {
			if (strings.HasPrefix(val, "\"") && strings.HasSuffix(val, "\"")) ||
				(strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'")) {
				val = val[1 : len(val)-1]
			}
		}
		// 仅在当前进程尚未显式定义该变量时注入，保证外部系统环境变量优先级更高
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, val)
		}
	}
	return scanner.Err()
}

// Config 保存 NanoCOS 服务的运行配置
type Config struct {
	Version     string `json:"version"`
	Addr        string `json:"addr"`
	DataDir     string `json:"dataDir"`
	AdminUser   string `json:"adminUser"`
	AdminPass   string `json:"adminPass"`
	ResetAdmin  bool   `json:"-"`
	PrintSecret bool   `json:"-"`
	PublicURL   string `json:"publicUrl"`
	SecretKey   string `json:"-"`
	S3Region    string `json:"s3Region"`
	MaxUploadGB int64  `json:"maxUploadGb"`
	TrustProxy    bool   `json:"trustProxy"`
	SkipStartupGC bool   `json:"skipStartupGc"`
	LogLevel      string `json:"logLevel"`
	LogFormat     string `json:"logFormat"`
}

// Load 解析命令行参数与环境变量（命令行参数优先于环境变量，环境变量优先于 .env，.env 优先于默认值）
func Load() *Config {
	AutoLoadDotEnv()

	cfg := &Config{}

	defaultAddr := getEnv("NANOCOS_ADDR", ":9000")
	defaultDataDir := getEnv("NANOCOS_DATA_DIR", "./data")
	defaultAdminUser := getEnv("NANOCOS_ADMIN_USER", "admin")
	defaultAdminPass := getEnv("NANOCOS_ADMIN_PASS", "")
	defaultPublicURL := getEnv("NANOCOS_PUBLIC_URL", "")
	defaultSecret := getEnv("NANOCOS_SECRET", "")
	defaultRegion := getEnv("NANOCOS_S3_REGION", "us-east-1")
	defaultMaxUploadGB, _ := strconv.ParseInt(getEnv("NANOCOS_MAX_UPLOAD_GB", "50"), 10, 64)
	if defaultMaxUploadGB <= 0 {
		defaultMaxUploadGB = 50
	}
	defaultTrustProxy := parseBoolEnv("NANOCOS_TRUST_PROXY", false)
	defaultSkipStartupGC := parseBoolEnv("NANOCOS_SKIP_STARTUP_GC", false)
	defaultPrintSecret := parseBoolEnv("NANOCOS_PRINT_SECRET", true)
	defaultLogLevel := getEnv("NANOCOS_LOG_LEVEL", "info")
	defaultLogFormat := getEnv("NANOCOS_LOG_FORMAT", "text")

	flag.StringVar(&cfg.Addr, "addr", defaultAddr, "HTTP 监听地址 (例如 :9000 或 127.0.0.1:9000)")
	flag.StringVar(&cfg.DataDir, "data-dir", defaultDataDir, "数据存储根目录")
	flag.StringVar(&cfg.AdminUser, "admin-user", defaultAdminUser, "首次初始化或重置时的管理员用户名")
	flag.StringVar(&cfg.AdminPass, "admin-pass", defaultAdminPass, "首次初始化或重置时的管理员密码 (留空则首次启动自动生成随机高强度密码)")
	flag.BoolVar(&cfg.ResetAdmin, "reset-admin", false, "强制重置管理员账号与密码并打印至终端")
	flag.BoolVar(&cfg.PrintSecret, "print-secret", defaultPrintSecret, "首次初始化时是否在标准输出打印初始明文密码与默认 SK")
	flag.StringVar(&cfg.PublicURL, "public-url", defaultPublicURL, "对外访问基准 URL (例如 https://cos.example.com，留空则自动根据请求 Host 推断)")
	flag.StringVar(&cfg.SecretKey, "secret", defaultSecret, "签名主密钥 (留空则自动生成并持久化在 data/meta/secret.key)")
	flag.StringVar(&cfg.S3Region, "s3-region", defaultRegion, "S3 协议默认区域名称")
	flag.Int64Var(&cfg.MaxUploadGB, "max-upload-gb", defaultMaxUploadGB, "单次上传最大允许体积 (单位 GiB，默认 50)")
	flag.BoolVar(&cfg.TrustProxy, "trust-proxy", defaultTrustProxy, "是否信任反向代理转发的 X-Forwarded-For / X-Real-IP 请求头")
	flag.BoolVar(&cfg.SkipStartupGC, "skip-startup-gc", defaultSkipStartupGC, "跳过启动时的后台全量物理块对账与 GC")
	flag.StringVar(&cfg.LogLevel, "log-level", defaultLogLevel, "日志级别 (debug | info | warn | error)")
	flag.StringVar(&cfg.LogFormat, "log-format", defaultLogFormat, "日志输出格式 (text | json)")
	flag.Parse()

	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	if cfg.MaxUploadGB <= 0 {
		cfg.MaxUploadGB = 50
	}
	return cfg
}

func parseBoolEnv(key string, fallback bool) bool {
	v, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(v) == "" {
		return fallback
	}
	v = strings.ToLower(strings.TrimSpace(v))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

// MaxUploadBytes 返回单次上传最大允许字节数
func (c *Config) MaxUploadBytes() int64 {
	if c == nil || c.MaxUploadGB <= 0 {
		return 50 << 30
	}
	return c.MaxUploadGB << 30
}

// EnsureDirectories 初始化所需的数据目录结构并确保 SecretKey 可用
func (c *Config) EnsureDirectories() error {
	dirs := []string{
		c.MetaDir(),
		c.BlobsDir(),
		c.MultipartDir(),
		c.TmpDir(),
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
	}

	if c.SecretKey == "" {
		secretFile := filepath.Join(c.MetaDir(), "secret.key")
		data, err := os.ReadFile(secretFile)
		if err == nil && len(strings.TrimSpace(string(data))) >= 32 {
			c.SecretKey = strings.TrimSpace(string(data))
		} else {
			buf := make([]byte, 32)
			if _, err := rand.Read(buf); err != nil {
				return err
			}
			c.SecretKey = hex.EncodeToString(buf)
			_ = os.WriteFile(secretFile, []byte(c.SecretKey), 0600)
		}
	}
	return nil
}

func (c *Config) MetaDir() string {
	return filepath.Join(c.DataDir, "meta")
}

func (c *Config) DBPath() string {
	return filepath.Join(c.MetaDir(), "cos.db")
}

func (c *Config) BlobsDir() string {
	return filepath.Join(c.DataDir, "blobs")
}

func (c *Config) MultipartDir() string {
	return filepath.Join(c.DataDir, "multipart")
}

func (c *Config) TmpDir() string {
	return filepath.Join(c.DataDir, "tmp")
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return fallback
}
