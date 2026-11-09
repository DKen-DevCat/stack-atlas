package domain

// Charge はカード明細 1 行。
type Charge struct {
	Merchant string
	Amount   int64
}

// ToTransaction は Charge を Transaction に変換する。
func (c Charge) ToTransaction(id string) Transaction {
	return Transaction{ID: id, Merchant: c.Merchant, Amount: c.Amount}
}
