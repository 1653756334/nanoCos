# 阶段 1: 使用 pnpm --frozen-lockfile 可复现构建前端静态资源至 internal/web/dist
FROM node:22-alpine AS web-builder

RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

# 阶段 2: 编译纯静态 Go 二进制文件 (自动 //go:embed 打包 internal/web/dist)
FROM golang:1.26-alpine AS go-builder

ARG VERSION=v1.1.0
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
COPY --from=web-builder /src/internal/web/dist ./internal/web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/cosd ./cmd/cosd

# 阶段 3: 极简非特权生产运行时镜像 (< 25MB)
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata wget su-exec \
    && adduser -D -u 10001 nanocos \
    && mkdir -p /app/data \
    && chown -R nanocos:nanocos /app

ENV TZ=Asia/Shanghai
WORKDIR /app
COPY --from=go-builder /out/cosd /usr/local/bin/cosd

# 自动处理宿主机 Docker bind-mount 目录的属主权限 (避免宿主机 ./data 为 root 导致非特权用户写权限拒绝)
RUN printf '#!/bin/sh\nset -e\nif [ "$(id -u)" = "0" ]; then\n  mkdir -p /app/data\n  chown -R nanocos:nanocos /app/data 2>/dev/null || true\n  exec su-exec nanocos:nanocos "$@"\nfi\nexec "$@"\n' > /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 9000

ENV NANOCOS_ADDR=":9000"
ENV NANOCOS_DATA_DIR="/app/data"

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9000/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/local/bin/cosd"]
