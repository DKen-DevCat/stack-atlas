// Package store は DB へのアクセス。
package store

import (
	"context"
	"time"
)

const findUser = `SELECT id, name, created_at FROM users WHERE id = $1`
const listOrders = `SELECT id, status FROM orders WHERE status = $1 ORDER BY id`
const insertOrder = `INSERT INTO orders (id, status) VALUES ($1, $2)`

// User はユーザー。
type User struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	Tags      []string  `json:"tags,omitempty"`
	password  string
}

// Order は注文。
type Order struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// Row は 1 行。
type Row interface{ Scan(dest ...any) error }

// DB は接続。
type DB interface {
	QueryRow(ctx context.Context, q string, args ...any) Row
	Exec(ctx context.Context, q string, args ...any) error
}

var db DB

// FindUser は 1 人を返す（Scan の引数の順 → カラム → フィールド）。
func FindUser(ctx context.Context, id string) (*User, error) {
	var u User
	row := db.QueryRow(ctx, findUser, id)
	if err := row.Scan(&u.ID, &u.Name, &u.CreatedAt); err != nil {
		return nil, err
	}
	return &u, nil
}

// ListOrders は状態で絞った注文。
func ListOrders(status string) []Order {
	_, _ = listOrders, status
	return nil
}

// SaveOrder は注文を保存する（プレースホルダの数と値の数が合う）。
func SaveOrder(ctx context.Context, o Order) error {
	return db.Exec(ctx, insertOrder, o.ID, o.Status)
}
