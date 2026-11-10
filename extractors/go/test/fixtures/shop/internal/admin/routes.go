package admin

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/admin/users", list)
	r.Post("/admin/users/{id}/ban", ban)
	_, _ = http.Get("/not-a-route")
	return r
}

func list(w http.ResponseWriter, r *http.Request) {}
func ban(w http.ResponseWriter, r *http.Request)  {}
