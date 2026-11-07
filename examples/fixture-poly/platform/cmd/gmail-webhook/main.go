// Command gmail-webhook は Gmail の push 通知を受ける Lambda の入口。
package main

import (
	"log"
	"net/http"

	"example.com/expense-platform/internal/inbound"
	"example.com/expense-platform/internal/parser"
	"example.com/expense-platform/internal/store"
)

func main() {
	st := store.New("postgres://localhost/expenses")
	h := inbound.NewHandler(parser.New(), st)
	log.Fatal(http.ListenAndServe(":8080", h))
}
