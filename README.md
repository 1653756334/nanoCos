# NanoCOS — 轻量级 CAS 内容寻址与 S3 兼容对象存储服务

NanoCOS 是一款单二进制交付、零外部依赖（内嵌 SQLite WAL + CAS SHA-256 物理块存储引擎 + React/Ant Design v6 Web 管理控制台）、同时支持 **AWS S3 协议** 与 **RESTful JSON API** 的自托管对象存储服务。

---

## 一、核心架构特性

1. **CAS 内容寻址全局去重 (`SHA-256 + RefCount`)**：
   - 物理数据按 `data/blobs/<sha[0:2]>/<sha[2:4]>/<sha256>` 两级目录存放，写入过程先在 `data/tmp` 完成流式哈希校验与 `fsync` 落盘，再在元数据事务内原子转正（`CommitTempBlob`），若发现磁盘残留截断坏块会自动覆盖修复。
   - 支持 **SHA-256 秒传**（`POST /api/v1/buckets/{bucket}/fast-upload`，带跨租户访问域隔离）与 **零拷贝复制/重命名**（`POST /api/v1/buckets/{bucket}/copy` 及 S3 `x-amz-copy-source`）。
2. **双协议网关**：
   - **AWS S3 兼容协议**（Path-Style `/s3/{bucket}/{key}`、根路径 `/` 自动嗅探、Virtual-Host `<bucket>.<host>`），支持 AWS Signature V4（Header 与 Presigned URL，含 ±15 分钟防重放窗口与 `X-Amz-Expires` 过期校验）、Signature V2（完整 HMAC-SHA1）及 `aws-chunked` 流式传输解码。
   - **现代 REST API (`/api/v1/*`)**：统一返回结构化错误码 `{"code": "...", "error": "..."}`。
   - **高速直链与流媒体网关 (`/raw/{bucket}/{key}`)**：原生支持 HTTP Range (`206 Partial Content`)、ETag `304 Not Modified`，并内置 `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox` 防御同源存储型 XSS。

---

## 二、快速启动与构建

```bash
# 1. 构建前端并编译单文件二进制 (推荐通过 Makefile)
make all

# 或手动执行：
cd web && pnpm install --frozen-lockfile && pnpm run build && cd ..
go build -trimpath -ldflags="-s -w -X main.version=v1.1.0" -o cosd ./cmd/cosd

# 2. 启动服务
./cosd -addr :9000 -data-dir ./data
```

---

## 三、配置参数与环境变量说明

命令行参数优先级高于环境变量，环境变量高于默认值：

| 命令行参数 | 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `-addr` | `NANOCOS_ADDR` | `:9000` | HTTP 监听地址 |
| `-data-dir` | `NANOCOS_DATA_DIR` | `./data` | 数据存储根目录 (`meta/`, `blobs/`, `multipart/`, `tmp/`) |
| `-admin-user` | `NANOCOS_ADMIN_USER` | `admin` | **仅首次建库或配合 `-reset-admin` 时生效**的管理员账号 |
| `-admin-pass` | `NANOCOS_ADMIN_PASS` | *(空，自动生成)* | **仅首次建库或配合 `-reset-admin` 时生效**的密码；留空则首次启动自动生成 16 位随机强密码 |
| `-reset-admin` | — | `false` | 启动时强制将管理员账号/密码重置为 `-admin-user` / `-admin-pass` |
| `-print-secret` | `NANOCOS_PRINT_SECRET` | `true` | 首次初始化时是否在控制台打印明文密码与默认 SK（生产环境日志采集中可设为 `false`） |
| `-secret` | `NANOCOS_SECRET` | *(自动持久化)* | 主签名密钥（默认自动生成 64 位随机十六进制并保存在 `data/meta/secret.key`，权限 `0600`） |
| `-public-url` | `NANOCOS_PUBLIC_URL` | *(自动推断)* | 对外访问基准 URL（如 `https://cos.example.com`） |
| `-s3-region` | `NANOCOS_S3_REGION` | `us-east-1` | S3 协议默认区域 |
| `-max-upload-gb` | `NANOCOS_MAX_UPLOAD_GB` | `50` | 单次请求流式上传最大允许体积（单位 GiB） |
| `-trust-proxy` | `NANOCOS_TRUST_PROXY` | `false` | 是否信任反代转发的 `X-Forwarded-For` / `X-Real-IP`（仅在受控 Nginx/Caddy 后开启） |
| `-skip-startup-gc` | `NANOCOS_SKIP_STARTUP_GC` | `false` | 是否跳过启动时的后台异步物理块全量对账与孤儿块回收 |
| `-log-level` | `NANOCOS_LOG_LEVEL` | `info` | 日志级别：`debug` \| `info` \| `warn` \| `error` |
| `-log-format` | `NANOCOS_LOG_FORMAT` | `text` | 日志格式：`text` \| `json` |

---

## 四、管理员口令生命周期与 `secret.key` 轮换说明

1. **首次初始化语义**：
   - 当 `data/meta/cos.db` 的 `admin_account` 表尚无记录时，服务首次启动会创建管理员账户（使用标准 **PBKDF2-HMAC-SHA256 600,000 轮**加盐哈希存储），并在终端打印一次随机密码。
   - **一旦初始化完成，后续重启均以数据库 `admin_account` 表为准**，修改环境变量 `NANOCOS_ADMIN_PASS` 不会覆盖已有密码（除非显式加上 `-reset-admin`）。
2. **修改或重置管理员密码**：
   - **命令行重置（推荐运维使用）**：
     ```bash
     # 自动生成 16 位新随机密码并使所有旧会话立即失效
     ./cosd passwd -data-dir ./data

     # 指定新用户名与新密码
     ./cosd passwd -data-dir ./data -user myadmin -pass "MyNewStrongPass#2026"
     ```
   - **Web 控制台在线修改**：登录后点击右上角【账号安全】弹窗（调用 `PUT /api/v1/auth/account`），验证当前密码后更新用户名或密码，`token_version` 自动递增使其他设备上的旧 Token 立即失效。
3. **`data/meta/secret.key` 轮换影响**：
   - `secret.key` 用于签发管理员会话 Token 与自定义 `/raw` 预签名链接（注：标准 S3 SigV4 预签名使用的是对应 `AccessKey` 的 `SecretKey`）。
   - 若删除或替换 `data/meta/secret.key` 并重启服务，所有已登录的 Web 管理后台会话与通过 `/api/v1/buckets/{bucket}/presign` 签发的旧直链将立即失效，底层对象数据不受影响。

---

## 五、备份、恢复与日常维护指南

### 1. 在线一致性热备份 (`cosd backup`)
SQLite 运行在 WAL 模式下，**切勿在服务运行期间直接用 `cp` 或 `tar` 裸拷 `data/meta/cos.db`**（会导致 `.db` 与 `.db-wal` 撕裂损坏）。请使用内置的一致性热备命令或 API：

```bash
# CLI 一键热备（底层使用 SQLite `VACUUM INTO` 生成一致性快照并同步复制有效 CAS 物理块）
./cosd backup -data-dir ./data -out ./backups/snap-20261106

# 或通过管理员 API 触发热备：
curl -X POST http://localhost:9000/api/v1/admin/backup \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"targetDir": "./backups/snap-20261106"}'
```

### 2. 数据恢复步骤
1. 停止 `cosd` 服务；
2. 将备份目录中的 `meta/cos.db`、`meta/secret.key` 以及 `blobs/` 完整覆盖回目标 `<data-dir>`（确保 `cos.db` 与 `blobs/` 来自同一次快照）；
3. 启动 `cosd`，启动时会自动执行一次 `ReconcileAndGC` 校准计数。

### 3. 健康检查、Prometheus 监控、数据巡检 (Scrub) 与垃圾回收 (GC)
- **存活探针**：`GET /healthz`（返回 `200 OK` `{"status":"ok","version":"v1.1.0","uptimeSeconds":...}`）
- **就绪探针**：`GET /readyz`（检查 SQLite 读写与 CAS 目录状态，返回 `{"status":"ready","reconciling":false}`）
- **Prometheus 监控指标**：`GET /metrics`（输出标准 Prometheus 文本格式指标，包含 `nanocos_up`、`nanocos_logical_bytes`、`nanocos_physical_bytes`、`nanocos_saved_bytes`、`nanocos_http_requests_total` 等）
- **REST OpenAPI 规范**：完整接口契约与错误码定义见 [`docs/openapi.yaml`](./docs/openapi.yaml)
- **物理块完整性巡检**：`POST /api/v1/admin/scrub`（全量重算所有 `ref_count > 0` 物理块的 SHA-256，校验磁盘静默位翻转）
- **手动触发对账与 GC**：`POST /api/v1/admin/gc`（重算桶容量、清理超时 24h 的未完成分片与 0 引用孤儿物理块；启动时对账默认在后台协程异步执行，不阻塞监听端口）

---

## 六、S3 协议兼容矩阵

| S3 操作 | 状态 | 说明 |
| :--- | :---: | :--- |
| `ListBuckets` (`GET /s3`) | ✅ 支持 | 按当前 AccessKey 权限过滤可见桶 |
| `CreateBucket` / `DeleteBucket` / `HeadBucket` | ✅ 支持 | 支持 Path-Style 与 Virtual-Host 风格创建/探测桶，支持 `x-amz-acl` (`private` / `public-read`) |
| `GetBucketLocation` (`GET /s3/{bucket}?location`) | ✅ 支持 | 返回配置的 `S3Region` |
| `ListObjects` V1 & V2 (`prefix`, `delimiter`, `max-keys`, `continuation-token`, `marker`, `encoding-type=url`) | ✅ 支持 | 精确 B-Tree 范围索引，支持公共前缀折叠与精确游标翻页 |
| `PutObject` / `GetObject` / `HeadObject` | ✅ 支持 | 支持 `Range`、`If-None-Match`、`x-amz-meta-*`、`Content-MD5`、`X-Amz-Content-Sha256`、`x-amz-checksum-sha256` 及 `aws-chunked` 流式上传（注：SigV4 Header 模式下逐块校验 `chunk-signature` 链；非 SigV4 Header 的 `STREAMING-UNSIGNED-PAYLOAD-TRAILER` 依赖 TLS、解码长度与尾部 `x-amz-checksum-sha256` 校验） |
| `CopyObject` (`PUT` + `x-amz-copy-source`) | ✅ 支持 | CAS 零拷贝元数据引用递增，支持 `x-amz-metadata-directive: REPLACE` |
| `DeleteObject` / `DeleteObjects` (`POST ?delete`) | ✅ 支持 | 删 `dir/` 默认仅删 0 字节目录 marker（传 `x-cos-recursive: true` 可递归删目录树） |
| `InitiateMultipartUpload` / `UploadPart` / `CompleteMultipartUpload` / `AbortMultipartUpload` / `ListParts` / `ListMultipartUploads` | ✅ 支持 | 暂存分片计入桶配额预算，合并时校验 Part 升序与 ETag |
| Bucket Versioning / Object Lock / Bucket Policy XML / Lifecycle XML | ❌ 暂不支持 | 采用桶级 `private` / `public-read` + AK 分桶授权模型替代复杂 XML Policy |
