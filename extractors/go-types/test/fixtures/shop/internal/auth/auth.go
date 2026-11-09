// Package auth は Authorization ヘッダを見る middleware。
package auth

import "net/http"

// Require は Authorization が無ければ 401 を返す。
func Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
