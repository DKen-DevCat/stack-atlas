// Package domain は支出の型と純粋なロジック。
package domain

import "time"

// Transaction は 1 件の支出。
type Transaction struct {
	ID         string    `json:"id"`
	Merchant   string    `json:"merchant"`
	Amount     int64     `json:"amount"`
	OccurredAt time.Time `json:"occurredAt"`
}

// Sum は合計金額を返す。
func Sum(txs []Transaction) int64 {
	var total int64
	for _, t := range txs {
		total += t.Amount
	}
	return total
}
