// Package parser はカード利用通知メールを Charge に変換する。
package parser

import (
	"regexp"
	"strconv"

	"example.com/expense-platform/internal/domain"
)

var amountRe = regexp.MustCompile(`([0-9,]+)円`)

// Parser はメール本文のパーサ。
type Parser struct{}

// New は Parser を作る。
func New() *Parser { return &Parser{} }

// Parse は本文から Charge を取り出す。
func (p *Parser) Parse(merchant, body string) (domain.Charge, bool) {
	m := amountRe.FindStringSubmatch(body)
	if m == nil {
		return domain.Charge{}, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return domain.Charge{}, false
	}
	return domain.Charge{Merchant: merchant, Amount: n}, true
}
