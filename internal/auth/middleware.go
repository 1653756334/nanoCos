package auth

import (
	"context"
	"net/http"
)

type ctxKey struct{}

// WithPrincipal 将已认证身份写入请求 Context
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext 从请求 Context 获取当前身份
func FromContext(ctx context.Context) *Principal {
	if p, ok := ctx.Value(ctxKey{}).(*Principal); ok {
		return p
	}
	return nil
}

// Middleware 解析请求中的认证信息并注入 Context（不强制拦截，由具体 Handler 根据公开/私有策略决定是否放行）
func (a *AuthService) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := a.AuthenticateRequest(r)
		if p != nil {
			r = r.WithContext(WithPrincipal(r.Context(), p))
		}
		next.ServeHTTP(w, r)
	})
}
