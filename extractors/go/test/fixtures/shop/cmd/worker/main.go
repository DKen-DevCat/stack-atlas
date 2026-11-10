package main

import "example.com/shop/internal/store"

func main() {
	store.New().Sweep()
}
