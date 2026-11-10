// Command api は gin と chi のルートを登録する（外部のモジュールは解けないので AST と import パスで読む）。
package main

import (
	"net/http"

	"example.com/fw/internal/h"
	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := gin.Default()
	r.Use(h.Auth())
	api := r.Group("/api")
	api.GET("/items/:id", h.GetItem)
	api.POST("/items", h.CreateItem)

	c := chi.NewRouter()
	c.Route("/v2", func(r chi.Router) {
		r.Get("/things/{id}", h.Thing)
	})
	_ = http.ListenAndServe(":8081", c)
	_ = r.Run(":8080")
}
