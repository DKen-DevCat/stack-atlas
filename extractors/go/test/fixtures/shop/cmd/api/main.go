package main

import (
	"log"
	"net/http"

	"example.com/shop/internal/api"
	"example.com/shop/internal/store"
)

func main() {
	st := store.New()
	srv := api.NewServer(st)
	log.Fatal(http.ListenAndServe(":8080", srv))
}
