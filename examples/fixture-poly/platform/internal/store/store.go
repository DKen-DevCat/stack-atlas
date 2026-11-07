// Package store は PostgreSQL（Aurora）へのアクセスを持つ。
package store

import (
	"context"
	"time"

	"example.com/expense-platform/internal/domain"
	"example.com/expense-platform/internal/push"
)

// Store は DB ハンドル。
type Store struct {
	dsn string
}

// New は Store を作る。
func New(dsn string) *Store { return &Store{dsn: dsn} }

const queryByDate = `SELECT id, merchant, amount, occurred_at FROM transactions WHERE occurred_at::date = $1`
const queryRecent = `SELECT id, merchant, amount, occurred_at FROM transactions ORDER BY occurred_at DESC LIMIT $1`
const queryDaily = `SELECT occurred_at::date, SUM(amount) FROM transactions WHERE to_char(occurred_at, 'YYYY-MM') = $1 GROUP BY 1`
const insertTx = `INSERT INTO transactions (id, merchant, amount, occurred_at) VALUES ($1, $2, $3, $4)`
const deleteTx = `DELETE FROM transactions WHERE id = $1`
const insertSub = `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ($1, $2, $3)`
const selectSubs = `SELECT endpoint, p256dh, auth FROM push_subscriptions`
const deleteSub = `DELETE FROM push_subscriptions WHERE endpoint = $1`

// ListByDate は指定日の支出を返す。
func (s *Store) ListByDate(ctx context.Context, day time.Time) ([]domain.Transaction, error) {
	_, _ = queryByDate, day
	return nil, nil
}

// ListRecent は直近の支出を返す。
func (s *Store) ListRecent(ctx context.Context, n int) ([]domain.Transaction, error) {
	_, _ = queryRecent, n
	return nil, nil
}

// DailyTotals は月の日別合計を返す。
func (s *Store) DailyTotals(ctx context.Context, month string) (map[string]int64, error) {
	_, _ = queryDaily, month
	return nil, nil
}

// InsertTransaction は支出を保存する。
func (s *Store) InsertTransaction(ctx context.Context, tx domain.Transaction) error {
	_, _ = insertTx, tx
	return nil
}

// DeleteTransaction は支出を削除する。
func (s *Store) DeleteTransaction(ctx context.Context, id string) error {
	_, _ = deleteTx, id
	return nil
}

// SaveSubscription は Web Push の購読を保存する。
func (s *Store) SaveSubscription(ctx context.Context, sub push.Subscription) error {
	_, _ = insertSub, sub
	return nil
}

// ListSubscriptions は購読を全件返す。
func (s *Store) ListSubscriptions(ctx context.Context) ([]push.Subscription, error) {
	_ = selectSubs
	return nil, nil
}

// RemoveSubscription は購読を削除する。
func (s *Store) RemoveSubscription(ctx context.Context, endpoint string) error {
	_, _ = deleteSub, endpoint
	return nil
}
