package api

import (
	"encoding/json"
	"net/http"

	"example.com/expense-platform/internal/push"
)

func (s *Server) handleSubscribe(w http.ResponseWriter, r *http.Request) {
	var sub push.Subscription
	if err := json.NewDecoder(r.Body).Decode(&sub); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.store.SaveSubscription(r.Context(), sub); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (s *Server) handleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var sub push.Subscription
	if err := json.NewDecoder(r.Body).Decode(&sub); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.store.RemoveSubscription(r.Context(), sub.Endpoint); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
