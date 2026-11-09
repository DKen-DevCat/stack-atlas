package api

import (
	"encoding/json"
	"net/http"
	"time"

	"example.com/expense-platform/internal/domain"
)

func (s *Server) handleCreateTransaction(w http.ResponseWriter, r *http.Request) {
	// 入力元（画面・取り込み）ごとにフィールドが少しずつ違うので、いったん map で受けて詰め替える
	var raw map[string]any
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	id, _ := raw["id"].(string)
	merchant, _ := raw["merchant"].(string)
	amount, _ := raw["amount"].(float64)
	tx := domain.Transaction{ID: id, Merchant: merchant, Amount: int64(amount), OccurredAt: time.Now()}
	if err := s.store.InsertTransaction(r.Context(), tx); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) handleDeleteTransaction(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteTransaction(r.Context(), r.PathValue("id")); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
