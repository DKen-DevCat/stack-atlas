package web

import (
	"encoding/json"
	"net/http"

	"example.com/local"
	"example.com/shop/internal/store"
	ext "github.com/ext/unknown"
	"github.com/vend/lib"
)

// Get はユーザーを返す（Encode する変数は out/<変数名>）。
func (Users) Get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	u, err := store.FindUser(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	_ = json.NewEncoder(w).Encode(u)
}

// Get は注文の一覧（map のリテラルの Encode はキーで展開）。
func (Orders) Get(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list := store.ListOrders(q.Get("status"))
	_ = json.NewEncoder(w).Encode(map[string]any{"orders": list, "count": len(list)})
}

func createItem(w http.ResponseWriter, r *http.Request) {
	var in local.Thing
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	item := lib.Item{Name: in.ID}
	ext.Do(item) // 解けない外部の import（解析は止まらない）
	if err := store.SaveOrder(r.Context(), store.Order{ID: in.ID, Status: "new"}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(item)
}

func health(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
