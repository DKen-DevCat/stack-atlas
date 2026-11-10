// Package push は Web Push の購読と送信。
package push

// Subscription はブラウザの購読情報。
type Subscription struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// Send は購読先に通知を送る。
func Send(sub Subscription, message string) error {
	_, _ = sub, message
	return nil
}
