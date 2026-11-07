package api

import (
	"encoding/json"
	"net/http"
	"time"

	"example.com/expense-platform/internal/domain"
)

func (s *Server) handleToday(w http.ResponseWriter, r *http.Request) {
	txs, err := s.store.ListByDate(r.Context(), time.Now())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	total := domain.Sum(txs)
	_ = json.NewEncoder(w).Encode(map[string]any{"total": total, "entries": txs})
}
