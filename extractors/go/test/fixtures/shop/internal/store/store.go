package store

import (
	"database/sql"

	"example.com/shop/internal/domain"
)

type Store struct{ db *sql.DB }

func New() *Store { return &Store{} }

func (s *Store) List() []domain.Order {
	_, _ = s.db.Query(`SELECT id, total FROM orders ORDER BY id`)
	return nil
}

func (s *Store) Sweep() {
	_, _ = s.db.Exec(`DELETE FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)`)
}
