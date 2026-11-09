// Command server は HTTP サーバーの入口。
package main

import (
	"log"
	"net/http"

	"example.com/shop/internal/web"
)

func main() {
	log.Fatal(http.ListenAndServe(":8080", web.Routes()))
}
