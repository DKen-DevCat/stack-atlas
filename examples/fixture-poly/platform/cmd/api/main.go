// Command api は HTTP API の Lambda（Function URL）の入口。
package main

import (
	"log"
	"net/http"

	"example.com/expense-platform/internal/api"
	"example.com/expense-platform/internal/auth"
	"example.com/expense-platform/internal/store"
)

func main() {
	st := store.New("postgres://localhost/expenses")
	verifier := auth.NewVerifier("https://cognito-idp.example.com/pool")
	srv := api.NewServer(st, verifier)
	log.Fatal(http.ListenAndServe(":8080", srv.Handler()))
}
