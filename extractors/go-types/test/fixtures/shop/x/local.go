// Package local は replace => ./x で置き換えたモジュール。
package local

// Thing はリクエストの body。
type Thing struct {
	ID     string  `json:"id"`
	Secret string  `json:"-"`
	Note   *string `json:"note,omitempty"`
	Tags   []string
}
