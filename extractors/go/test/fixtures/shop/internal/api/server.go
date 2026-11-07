// Package api は HTTP API。
package api

import (
	"net/http"

	"example.com/shop/internal/domain"
	"example.com/shop/internal/store"
)

type Server struct {
	mux *http.ServeMux
	st  *store.Store
}

func NewServer(st *store.Store) *Server {
	s := &Server{mux: http.NewServeMux(), st: st}
	s.mux.HandleFunc("GET /orders", s.handleList)
	s.mux.HandleFunc("POST /orders", s.handleCreate)
	s.mux.HandleFunc("DELETE /orders/{id}", s.handleDelete)
	// s.mux.HandleFunc("GET /disabled", s.handleList)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) handleList(w http.ResponseWriter, r *http.Request)   { _ = domain.Order{} }
func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {}
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {}
