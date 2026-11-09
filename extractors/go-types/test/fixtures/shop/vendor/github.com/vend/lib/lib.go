// Package lib は vendor に置いた外部モジュール（型は読める）。
package lib

// Item は vendor の型。
type Item struct {
	Name  string `json:"name"`
	Count int    `json:"count,omitempty"`
}
