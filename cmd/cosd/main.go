package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"nanocos/internal/api"
	"nanocos/internal/auth"
	"nanocos/internal/config"
	"nanocos/internal/store"
)

// version 可在编译时通过 -ldflags "-X main.version=v1.x.y" 注入
var version = "v1.1.0"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "-version", "--version", "-v":
			fmt.Printf("NanoCOS %s\n", version)
			return
		case "passwd", "reset-password":
			if err := runPasswdCommand(os.Args[2:]); err != nil {
				slog.Error("重置管理员凭证失败", "error", err)
				os.Exit(1)
			}
			return
		case "backup":
			if err := runBackupCommand(os.Args[2:]); err != nil {
				slog.Error("执行数据热备份失败", "error", err)
				os.Exit(1)
			}
			return
		}
	}

	if err := run(); err != nil {
		slog.Error("NanoCOS 服务异常退出", "error", err)
		os.Exit(1)
	}
}

func setupLogger(levelStr, formatStr string) {
	var level slog.Level
	switch strings.ToLower(strings.TrimSpace(levelStr)) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if strings.EqualFold(strings.TrimSpace(formatStr), "json") {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		handler = slog.NewTextHandler(os.Stdout, opts)
	}
	slog.SetDefault(slog.New(handler))
}

func runPasswdCommand(args []string) error {
	fs := flag.NewFlagSet("passwd", flag.ContinueOnError)
	defaultDataDir := os.Getenv("NANOCOS_DATA_DIR")
	if strings.TrimSpace(defaultDataDir) == "" {
		defaultDataDir = "./data"
	}
	var dataDir, newUser, newPass string
	fs.StringVar(&dataDir, "data-dir", defaultDataDir, "数据存储根目录")
	fs.StringVar(&newUser, "user", "", "要修改的新管理员用户名 (留空则保持原用户名)")
	fs.StringVar(&newPass, "pass", "", "要设置的新管理员密码 (不少于6位，留空则自动生成16位随机强密码)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg := &config.Config{DataDir: dataDir}
	if err := cfg.EnsureDirectories(); err != nil {
		return fmt.Errorf("初始化存储目录失败: %w", err)
	}

	st, err := store.NewStore(cfg.DBPath(), cfg.BlobsDir(), cfg.MultipartDir(), cfg.TmpDir())
	if err != nil {
		return fmt.Errorf("打开数据库失败: %w", err)
	}
	defer st.Close()

	finalUser, finalPass, err := st.ResetAdminCredentials(newUser, newPass)
	if err != nil {
		return err
	}

	fmt.Println("================================================================")
	fmt.Println("  NanoCOS 管理员凭证已成功更新 (所有历史登录会话已强制失效)")
	fmt.Println("================================================================")
	fmt.Printf("  数据目录   : %s\n", cfg.DataDir)
	fmt.Printf("  管理员账号 : %s\n", finalUser)
	fmt.Printf("  管理员密码 : %s\n", finalPass)
	fmt.Println("================================================================")
	return nil
}

func runBackupCommand(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	defaultDataDir := os.Getenv("NANOCOS_DATA_DIR")
	if strings.TrimSpace(defaultDataDir) == "" {
		defaultDataDir = "./data"
	}
	var dataDir, outDir string
	fs.StringVar(&dataDir, "data-dir", defaultDataDir, "源数据存储根目录")
	fs.StringVar(&outDir, "out", "", "备份输出目录 (留空则默认写入 <data-dir>/backups/<timestamp>)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg := &config.Config{DataDir: dataDir}
	if err := cfg.EnsureDirectories(); err != nil {
		return fmt.Errorf("访问源存储目录失败: %w", err)
	}
	if strings.TrimSpace(outDir) == "" {
		outDir = filepath.Join(dataDir, "backups", time.Now().UTC().Format("20060102-150405"))
	}

	st, err := store.NewStore(cfg.DBPath(), cfg.BlobsDir(), cfg.MultipartDir(), cfg.TmpDir())
	if err != nil {
		return fmt.Errorf("打开源数据库失败: %w", err)
	}
	defer st.Close()

	dbSnap, copiedBlobs, err := st.BackupToDir(outDir)
	if err != nil {
		return err
	}

	fmt.Println("================================================================")
	fmt.Println("  NanoCOS 一致性热备份已完成 (SQLite VACUUM INTO + CAS Blobs)")
	fmt.Println("================================================================")
	fmt.Printf("  备份目标目录 : %s\n", outDir)
	fmt.Printf("  元数据快照   : %s\n", dbSnap)
	fmt.Printf("  已备份物理块 : %d 个\n", copiedBlobs)
	fmt.Println("================================================================")
	return nil
}

func run() error {
	cfg := config.Load()
	cfg.Version = version
	setupLogger(cfg.LogLevel, cfg.LogFormat)

	if err := cfg.EnsureDirectories(); err != nil {
		return fmt.Errorf("初始化存储目录失败: %w", err)
	}

	st, err := store.NewStore(cfg.DBPath(), cfg.BlobsDir(), cfg.MultipartDir(), cfg.TmpDir())
	if err != nil {
		return fmt.Errorf("初始化存储引擎失败: %w", err)
	}
	defer func() {
		_ = st.CAS().CleanTmpDir()
		_ = st.Close()
	}()

	var adminUser, initialPlainPass string
	var adminCreatedNew bool
	if cfg.ResetAdmin {
		adminUser, initialPlainPass, err = st.ResetAdminCredentials(cfg.AdminUser, cfg.AdminPass)
		if err != nil {
			return fmt.Errorf("重置管理员账户失败: %w", err)
		}
		adminCreatedNew = true
	} else {
		adminUser, initialPlainPass, adminCreatedNew, err = st.EnsureAdminAccount(cfg.AdminUser, cfg.AdminPass)
		if err != nil {
			return fmt.Errorf("初始化管理员账户失败: %w", err)
		}
	}
	cfg.AdminUser = adminUser

	defaultAK, akCreatedNew, err := st.EnsureDefaultAccessKey()
	if err != nil {
		slog.Warn("初始化默认 AccessKey 失败", "error", err)
	}

	authSvc := auth.NewAuthService(cfg, st)
	srv := api.NewServer(cfg, st, authSvc)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	printStartupBanner(cfg, adminUser, initialPlainPass, adminCreatedNew, defaultAK, akCreatedNew)

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		return err
	case sig := <-sigCh:
		slog.Info("收到退出信号，正在优雅停机...", "signal", sig.String())
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
		slog.Info("NanoCOS 服务已安全停止")
		return nil
	}
}

func printStartupBanner(cfg *config.Config, adminUser, initialPlainPass string, adminCreatedNew bool, ak *store.AccessKey, akCreatedNew bool) {
	displayHost := cfg.Addr
	if strings.HasPrefix(displayHost, ":") {
		displayHost = "localhost" + displayHost
	}
	baseURL := cfg.PublicURL
	if baseURL == "" {
		baseURL = "http://" + displayHost
	}

	fmt.Println("================================================================")
	fmt.Printf("  NanoCOS %s — 轻量级 CAS 内容寻址与 S3 兼容对象存储服务\n", cfg.Version)
	fmt.Println("================================================================")
	fmt.Printf("  Web 管理控制台 : %s\n", baseURL)
	fmt.Printf("  REST API 地址  : %s/api/v1\n", baseURL)
	fmt.Printf("  S3 兼容节点    : %s/s3 (Region: %s)\n", baseURL, cfg.S3Region)
	fmt.Printf("  直链流媒体网关 : %s/raw/{bucket}/{key}\n", baseURL)
	fmt.Printf("  健康检查探针   : %s/healthz | %s/readyz\n", baseURL, baseURL)
	fmt.Printf("  数据存储目录   : %s\n", cfg.DataDir)
	fmt.Println("----------------------------------------------------------------")
	if adminCreatedNew {
		if cfg.PrintSecret {
			fmt.Println("  [!] 首次初始化/重置管理员凭证 (仅显示一次，请立即记录或登录后修改):")
			fmt.Printf("      管理员账号 : %s\n", adminUser)
			fmt.Printf("      管理员密码 : %s\n", initialPlainPass)
		} else {
			fmt.Printf("  控制台管理员   : %s (已按 -print-secret=false 隐藏初始密码，请执行 `cosd passwd` 查看或重置)\n", adminUser)
		}
	} else {
		fmt.Printf("  控制台管理员   : %s (已初始化，遗忘密码可执行 `cosd passwd` 重置)\n", adminUser)
	}
	if ak != nil {
		fmt.Println("----------------------------------------------------------------")
		if akCreatedNew && cfg.PrintSecret {
			fmt.Println("  [!] 首次启动自动生成默认主密钥 AK/SK (仅首次显示明文 SK):")
			fmt.Printf("      AccessKey (AK) : %s\n", ak.AccessKey)
			fmt.Printf("      SecretKey (SK) : %s\n", ak.SecretKey)
		} else {
			fmt.Printf("  默认主密钥 AK  : %s (SK 已隐藏，可在 Web 控制台查看)\n", ak.AccessKey)
		}
	}
	fmt.Println("================================================================")
}
