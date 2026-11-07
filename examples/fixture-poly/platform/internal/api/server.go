// Package api は HTTP ルーティングとハンドラを持つ。
package api

import (
	"net/http"

	"example.com/expense-platform/internal/auth"
	"example.com/expense-platform/internal/store"
)

// Server は API サーバー。
type Server struct {
	store    *store.Store
	verifier *auth.Verifier
}

// NewServer は Server を作る。
func NewServer(st *store.Store, v *auth.Verifier) *Server {
	return &Server{store: st, verifier: v}
}

// Handler はルートを登録した http.Handler を返す。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /today", s.handleToday)
	mux.HandleFunc("GET /days", s.handleDays)
	mux.HandleFunc("GET /entries", s.handleEntries)
	mux.HandleFunc("POST /transactions", s.handleCreateTransaction)
	mux.HandleFunc("DELETE /transactions/{id}", s.handleDeleteTransaction)
	mux.HandleFunc("POST /push/subscriptions", s.handleSubscribe)
	mux.HandleFunc("DELETE /push/subscriptions", s.handleUnsubscribe)
	return s.verifier.Middleware(mux)
}
