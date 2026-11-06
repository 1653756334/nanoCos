package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseEnvReader(t *testing.T) {
	// 设置已存在的外部系统环境变量，验证不会被 .env 覆盖
	_ = os.Setenv("TEST_EXISTING_ENV", "system_value")
	defer os.Unsetenv("TEST_EXISTING_ENV")
	defer os.Unsetenv("TEST_SIMPLE")
	defer os.Unsetenv("TEST_QUOTED_DOUBLE")
	defer os.Unsetenv("TEST_QUOTED_SINGLE")
	defer os.Unsetenv("TEST_EXPORTED")

	content := `
# 这是一个注释行
TEST_SIMPLE=hello_world

# 带引号
TEST_QUOTED_DOUBLE="value with spaces"
TEST_QUOTED_SINGLE='single quoted'

# 带 export
export TEST_EXPORTED=export_val

# 试图覆盖已有系统环境变量
TEST_EXISTING_ENV=should_not_overwrite
`

	err := ParseEnvReader(strings.NewReader(content))
	if err != nil {
		t.Fatalf("ParseEnvReader 失败: %v", err)
	}

	if val := os.Getenv("TEST_SIMPLE"); val != "hello_world" {
		t.Errorf("期望 TEST_SIMPLE=hello_world，实际=%s", val)
	}
	if val := os.Getenv("TEST_QUOTED_DOUBLE"); val != "value with spaces" {
		t.Errorf("期望 TEST_QUOTED_DOUBLE=value with spaces，实际=%s", val)
	}
	if val := os.Getenv("TEST_QUOTED_SINGLE"); val != "single quoted" {
		t.Errorf("期望 TEST_QUOTED_SINGLE=single quoted，实际=%s", val)
	}
	if val := os.Getenv("TEST_EXPORTED"); val != "export_val" {
		t.Errorf("期望 TEST_EXPORTED=export_val，实际=%s", val)
	}
	if val := os.Getenv("TEST_EXISTING_ENV"); val != "system_value" {
		t.Errorf("系统已有环境变量被错误覆盖，期望 system_value，实际=%s", val)
	}
}

func TestLoadDotEnv_NotExist(t *testing.T) {
	nonExist := filepath.Join(t.TempDir(), "not_found.env")
	if err := LoadDotEnv(nonExist); err != nil {
		t.Fatalf("不存在的文件应该静默返回 nil，实际返回: %v", err)
	}
}
