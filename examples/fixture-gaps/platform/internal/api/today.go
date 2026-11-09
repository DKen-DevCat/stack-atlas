package api

import (
	"encoding/json"
	"net/http"
	"time"

	"example.com/expense-platform/internal/domain"
)

func (s *Server) handleToday(w http.ResponseWriter, r *http.Request) {
	day := time.Now()
	// date（YYYY-MM-DD）は任意。空なら今日
	if d := r.URL.Query().Get("date"); d != "" {
		parsed, err := time.Parse("2006-01-02", d)
		if err != nil {
			http.Error(w, "date は YYYY-MM-DD", http.StatusBadRequest)
			return
		}
		day = parsed
	}
	txs, err := s.store.ListByDate(r.Context(), day)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	total := domain.Sum(txs)
	resp := map[string]any{"total": total, "entries": txs}
	_ = json.NewEncoder(w).Encode(resp)
}
