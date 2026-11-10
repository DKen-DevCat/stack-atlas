// Package web はルートとハンドラ。
package web

import (
	"net/http"

	"example.com/shop/internal/auth"
)

// Users と Orders はどちらも Get を持つ（名前の衝突）。
type Users struct{}

// Orders は注文。
type Orders struct{}

// Routes はルートを登録して、認証の middleware で mux 全体を包む。
func Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", Users{}.Get)
	mux.HandleFunc("GET /orders", Orders{}.Get)
	mux.HandleFunc("POST /items", createItem)
	mux.HandleFunc("/health", health)
	return auth.Require(mux)
}

// Get は衝突しない関数（レシーバ無しなので fn:internal/web.Get のまま）。
func Get() string { return "get" }
