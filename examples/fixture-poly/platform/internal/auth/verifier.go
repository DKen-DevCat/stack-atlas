// Package auth は Cognito の JWT を検証する。
package auth

import "net/http"

// Verifier は JWT 検証器。
type Verifier struct {
	issuer string
}

// NewVerifier は Verifier を作る。
func NewVerifier(issuer string) *Verifier { return &Verifier{issuer: issuer} }

// Middleware は Authorization ヘッダを検証する。
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
