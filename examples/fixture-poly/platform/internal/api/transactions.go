package api

import (
	"encoding/json"
	"net/http"

	"example.com/expense-platform/internal/domain"
)

func (s *Server) handleCreateTransaction(w http.ResponseWriter, r *http.Request) {
	var tx domain.Transaction
	if err := json.NewDecoder(r.Body).Decode(&tx); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
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
