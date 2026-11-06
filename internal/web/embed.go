package web

import "embed"

// EmbeddedDist 内嵌 Web 管理控制台静态资源
//
//go:embed all:dist
var EmbeddedDist embed.FS
