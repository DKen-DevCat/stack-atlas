package api

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handleDays(w http.ResponseWriter, r *http.Request) {
	days, err := s.store.DailyTotals(r.Context(), r.URL.Query().Get("month"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(days)
}

func (s *Server) handleEntries(w http.ResponseWriter, r *http.Request) {
	txs, err := s.store.ListRecent(r.Context(), 50)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = json.NewEncoder(w).Encode(txs)
}
