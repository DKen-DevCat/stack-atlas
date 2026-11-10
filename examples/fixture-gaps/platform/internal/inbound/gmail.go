// Package inbound は Gmail の push 通知を受けて取り込む。
package inbound

import (
	"net/http"

	"example.com/expense-platform/internal/parser"
	"example.com/expense-platform/internal/store"
)

// Handler は Gmail push の HTTP ハンドラ。
type Handler struct {
	parser *parser.Parser
	store  *store.Store
}

// NewHandler は Handler を作る。
func NewHandler(p *parser.Parser, s *store.Store) *Handler {
	return &Handler{parser: p, store: s}
}

// ServeHTTP は通知を処理する。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	charge, ok := h.parser.Parse("unknown", r.FormValue("body"))
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := h.store.InsertTransaction(r.Context(), charge.ToTransaction("gmail")); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}
