package main

// SQL のレシピ（docs/17 §3.3・§7 #2 の table の行）: 関数の中の定数の SQL 文字列から、テーブル・読むカラム・書くカラム・
// WHERE のカラムを読む。関数の箱の meta.sql と、項目 `out/query_n`（WHERE のカラム）・`out/insert_n` / `out/update_n`
// （書くカラム）・`in/row`（SELECT / RETURNING の 1 行）を作る。`rows.Scan(&t.A, &t.B)` は引数の順 → カラム → フィールドの
// links にする。カラムの型（wireType）は TS の側がマイグレーションから埋める（ここでは名前と cast だけ）。
//
// プレースホルダ（$1・?）と値の対応: 定数の SQL を渡した呼び出し（`db.Query(ctx, q, a, b)`）か並び（`_, _ = q, a`）で、
// SQL の後ろに並ぶ式が $1, $2, … になる。数が合わないときは、struct の引数のフィールドとカラムを名前で照合する（crude）。

import (
	"go/ast"
	"regexp"
	"strings"
)

type sqlTok struct {
	kind       byte // i: 識別子、q: 引用符の識別子、s: 文字列、n: 数、p: プレースホルダ、o: 演算子・記号
	s, low     string
	start, end int
	param      int
}

type sqlCol struct {
	id     string
	name   string
	column string // 元のカラム（式のときは参照する唯一のカラム、無ければ ""）
	table  string // カラムのテーブル（修飾・別名・スキーマで解いたもの。決められなければ ""）
	cast   string
	expr   string
	star   bool
}

type sqlWhere struct {
	col    string
	qual   string // 修飾（`o.total` の o）
	table  string
	cast   string
	params []int
}

type sqlStmt struct {
	op    string
	table string
	// FROM・JOIN のテーブル（最初が table）と、別名（小文字）→ テーブル（副問い合わせの別名は ""）
	tables      []string
	aliases     map[string]string
	read        []sqlCol
	write       []string
	writeParams []int
	where       []sqlWhere
	nParams     int
	display     string
}

// sqlCatalog は SQL のスキーマ（TS の側がマイグレーションから渡す。-schema-stdin）。無ければ nil
type sqlCatalog struct {
	cols map[string][]string        // 小文字のテーブル → カラム（定義の順）
	has  map[string]map[string]bool // 小文字のテーブル → 小文字のカラム
}

func newCatalog(s sqlSchema) *sqlCatalog {
	if s == nil {
		return nil
	}
	c := &sqlCatalog{cols: map[string][]string{}, has: map[string]map[string]bool{}}
	for t, cols := range s {
		lt := strings.ToLower(t)
		c.cols[lt] = cols
		set := map[string]bool{}
		for _, col := range cols {
			set[strings.ToLower(col)] = true
		}
		c.has[lt] = set
	}
	return c
}

// columns: テーブルのカラム（スキーマに無ければ ok は false）
func (c *sqlCatalog) columns(table string) (map[string]bool, bool) {
	if c == nil {
		return nil, false
	}
	set, ok := c.has[strings.ToLower(table)]
	return set, ok
}

var sqlStart = regexp.MustCompile(`(?is)^\s*(select|insert|update|delete|with)\b`)

func sqlTokens(text string) []sqlTok {
	var out []sqlTok
	named := map[string]int{}
	seq := 0
	i := 0
	n := len(text)
	isIdent := func(c byte) bool {
		return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
	}
	for i < n {
		c := text[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '-' && i+1 < n && text[i+1] == '-':
			for i < n && text[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && text[i+1] == '*':
			end := strings.Index(text[i+2:], "*/")
			if end < 0 {
				i = n
			} else {
				i += end + 4
			}
		case c == '\'':
			j := i + 1
			for j < n {
				if text[j] == '\'' {
					if j+1 < n && text[j+1] == '\'' {
						j += 2
						continue
					}
					break
				}
				j++
			}
			out = append(out, sqlTok{kind: 's', s: text[i:min(j+1, n)], start: i, end: min(j+1, n)})
			i = j + 1
		case c == '"' || c == '`':
			j := strings.IndexByte(text[i+1:], c)
			if j < 0 {
				j = n - i - 1
			}
			s := text[i+1 : i+1+j]
			out = append(out, sqlTok{kind: 'q', s: s, low: strings.ToLower(s), start: i, end: i + j + 2})
			i += j + 2
		case c == '$' && i+1 < n && text[i+1] >= '0' && text[i+1] <= '9':
			j := i + 1
			for j < n && text[j] >= '0' && text[j] <= '9' {
				j++
			}
			num := 0
			for _, d := range text[i+1 : j] {
				num = num*10 + int(d-'0')
			}
			out = append(out, sqlTok{kind: 'p', s: text[i:j], start: i, end: j, param: num})
			i = j
		case c == '?':
			seq++
			out = append(out, sqlTok{kind: 'p', s: "?", start: i, end: i + 1, param: seq})
			i++
		case (c == ':' || c == '@') && i+1 < n && (text[i+1] == '_' || (text[i+1]|0x20 >= 'a' && text[i+1]|0x20 <= 'z')) && !(c == ':' && i > 0 && text[i-1] == ':'):
			j := i + 1
			for j < n && isIdent(text[j]) {
				j++
			}
			name := text[i+1 : j]
			if _, ok := named[name]; !ok {
				seq++
				named[name] = seq
			}
			out = append(out, sqlTok{kind: 'p', s: text[i:j], start: i, end: j, param: named[name]})
			i = j
		case c == ':' && i+1 < n && text[i+1] == ':':
			out = append(out, sqlTok{kind: 'o', s: "::", low: "::", start: i, end: i + 2})
			i += 2
		case c >= '0' && c <= '9':
			j := i
			for j < n && (text[j] >= '0' && text[j] <= '9' || text[j] == '.') {
				j++
			}
			out = append(out, sqlTok{kind: 'n', s: text[i:j], start: i, end: j})
			i = j
		case isIdent(c):
			j := i
			for j < n && isIdent(text[j]) {
				j++
			}
			s := text[i:j]
			out = append(out, sqlTok{kind: 'i', s: s, low: strings.ToLower(s), start: i, end: j})
			i = j
		default:
			two := ""
			if i+1 < n {
				two = text[i : i+2]
			}
			if two == "<=" || two == ">=" || two == "<>" || two == "!=" || two == "||" {
				out = append(out, sqlTok{kind: 'o', s: two, low: two, start: i, end: i + 2})
				i += 2
			} else {
				out = append(out, sqlTok{kind: 'o', s: string(c), low: string(c), start: i, end: i + 1})
				i++
			}
		}
	}
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var sqlKeywords = map[string]bool{
	"and": true, "or": true, "not": true, "null": true, "is": true, "in": true, "like": true, "ilike": true,
	"between": true, "exists": true, "any": true, "all": true, "some": true, "true": true, "false": true,
	"case": true, "when": true, "then": true, "else": true, "end": true, "as": true, "on": true, "using": true,
	"distinct": true, "select": true, "from": true, "where": true, "interval": true, "similar": true, "escape": true,
	// 関数の形をとらない値・修飾の語（WHERE のカラムの候補にしない。8-2b レビュー C4）
	"current_date": true, "current_time": true, "current_timestamp": true, "localtime": true, "localtimestamp": true,
	"current_user": true, "session_user": true, "array": true, "row": true, "at": true, "zone": true, "asc": true,
	"desc": true, "nulls": true, "unknown": true,
}

// 結合の語（FROM の別名にしない）
var joinWords = map[string]bool{
	"join": true, "inner": true, "left": true, "right": true, "full": true, "outer": true, "cross": true,
	"natural": true, "lateral": true, "on": true, "using": true, "where": true, "set": true, "values": true,
	"default": true, "select": true,
}

var whereEnd = map[string]bool{
	"group": true, "order": true, "limit": true, "offset": true, "having": true, "returning": true,
	"for": true, "union": true, "window": true, "fetch": true, "intersect": true, "except": true,
}

// depth0: 括弧の外の i 番目のトークンか
func depths(ts []sqlTok) []int {
	d := make([]int, len(ts))
	cur := 0
	for i, t := range ts {
		if t.kind == 'o' && t.s == ")" {
			cur--
		}
		d[i] = cur
		if t.kind == 'o' && t.s == "(" {
			cur++
		}
	}
	return d
}

func findKw(ts []sqlTok, d []int, from int, kws ...string) int {
	for i := from; i < len(ts); i++ {
		if d[i] != 0 || ts[i].kind != 'i' {
			continue
		}
		for _, k := range kws {
			if ts[i].low == k {
				return i
			}
		}
	}
	return -1
}

func splitComma(ts []sqlTok) [][]sqlTok {
	var out [][]sqlTok
	depth := 0
	start := 0
	for i, t := range ts {
		if t.kind == 'o' {
			switch t.s {
			case "(":
				depth++
			case ")":
				depth--
			case ",":
				if depth == 0 {
					out = append(out, ts[start:i])
					start = i + 1
				}
			}
		}
	}
	if start < len(ts) {
		out = append(out, ts[start:])
	}
	return out
}

func identText(t sqlTok) string {
	if t.kind == 'q' {
		return t.s
	}
	return t.s
}

// tableAt: i から `[schema.]name`
func tableAt(ts []sqlTok, i int) (string, int) {
	if i >= len(ts) || (ts[i].kind != 'i' && ts[i].kind != 'q') {
		return "", i
	}
	if ts[i].low == "only" || ts[i].low == "lateral" {
		i++
	}
	if i >= len(ts) || (ts[i].kind != 'i' && ts[i].kind != 'q') {
		return "", i
	}
	name := identText(ts[i])
	if i+2 < len(ts) && ts[i+1].s == "." && (ts[i+2].kind == 'i' || ts[i+2].kind == 'q') {
		name = identText(ts[i+2])
		i += 2
	}
	return name, i + 1
}

func castOf(ts []sqlTok, i int) string {
	// ts[i] は "::"。型は次の識別子（double precision などは 2 語、配列の [] も）
	var parts []string
	for j := i + 1; j < len(ts); j++ {
		t := ts[j]
		if t.kind == 'i' && (len(parts) == 0 || (parts[len(parts)-1] == "double" && t.low == "precision") || (strings.HasPrefix(parts[0], "timestamp") && (t.low == "with" || t.low == "without" || t.low == "time" || t.low == "zone"))) {
			parts = append(parts, t.low)
			continue
		}
		if t.kind == 'o' && (t.s == "[" || t.s == "]") {
			parts = append(parts, t.s)
			continue
		}
		break
	}
	return strings.Replace(strings.Join(parts, " "), " [ ]", "[]", -1)
}

// isSubquery: ts[i] が副問い合わせの始まり（`(` の次が SELECT / WITH）か
func isSubquery(ts []sqlTok, i int) bool {
	return ts[i].kind == 'o' && ts[i].s == "(" && i+1 < len(ts) && ts[i+1].kind == 'i' &&
		(ts[i+1].low == "select" || ts[i+1].low == "with")
}

// closeAt: ts[i] の "(" と対の ")" の位置（無ければ最後）
func closeAt(ts []sqlTok, i int) int {
	depth := 0
	for j := i; j < len(ts); j++ {
		if ts[j].kind != 'o' {
			continue
		}
		switch ts[j].s {
		case "(":
			depth++
		case ")":
			depth--
			if depth == 0 {
				return j
			}
		}
	}
	return len(ts) - 1
}

// columnsIn: 式の中のカラムの候補と、その cast・修飾。除くもの: 関数名・キーワード・cast の型・修飾の接頭辞、
// 型付きのリテラル（`interval '1 day'`・`date '2024-01-01'`）・`CAST(x AS 型)` の型・`extract(epoch FROM x)` の欄、
// 副問い合わせ（`(SELECT …)` の中は別のテーブルの話。2026-11-09 8-2b レビュー C4）
func columnsIn(ts []sqlTok) []sqlWhere {
	var out []sqlWhere
	seen := map[string]int{}
	for i := 0; i < len(ts); i++ {
		t := ts[i]
		if isSubquery(ts, i) {
			i = closeAt(ts, i)
			continue
		}
		if t.kind != 'i' && t.kind != 'q' {
			continue
		}
		if t.kind == 'i' && sqlKeywords[t.low] {
			continue
		}
		if i > 0 && ts[i-1].s == "::" {
			continue
		}
		if i > 0 && ts[i-1].kind == 'i' && (ts[i-1].low == "double" || ts[i-1].low == "as") {
			continue
		}
		if i+1 < len(ts) && (ts[i+1].s == "(" || ts[i+1].s == "." || ts[i+1].kind == 's') {
			continue
		}
		if t.kind == 'i' && i+1 < len(ts) && ts[i+1].kind == 'i' && ts[i+1].low == "from" {
			continue
		}
		qual := ""
		if i >= 2 && ts[i-1].s == "." && (ts[i-2].kind == 'i' || ts[i-2].kind == 'q') {
			qual = identText(ts[i-2])
		}
		cast := ""
		if i+1 < len(ts) && ts[i+1].s == "::" {
			cast = castOf(ts, i+1)
		}
		name := identText(t)
		if j, ok := seen[name]; ok {
			if out[j].cast == "" {
				out[j].cast = cast
			}
			continue
		}
		seen[name] = len(out)
		out = append(out, sqlWhere{col: name, qual: qual, cast: cast})
	}
	return out
}

// paramsIn: プレースホルダ（副問い合わせの中のものは外の述語の値にしない）
func paramsIn(ts []sqlTok) []int {
	var out []int
	for i := 0; i < len(ts); i++ {
		if isSubquery(ts, i) {
			i = closeAt(ts, i)
			continue
		}
		if ts[i].kind == 'p' {
			out = append(out, ts[i].param)
		}
	}
	return out
}

// resolveCol: カラムのテーブル（修飾は別名で、無ければ 1 つだけのテーブル、複数ならスキーマでカラムを持つ 1 つ）と、
// カラムとして残すか（スキーマがそのテーブルを知っていて、カラムが無ければ残さない。C4）
func (st *sqlStmt) resolveCol(qual, col string, cat *sqlCatalog) (string, bool) {
	lc := strings.ToLower(col)
	known := func(t string) (bool, bool) {
		set, ok := cat.columns(t)
		return ok, ok && set[lc]
	}
	if qual != "" {
		t, ok := st.aliases[strings.ToLower(qual)]
		if !ok || t == "" {
			return "", true // 知らない修飾・副問い合わせの別名: 比べない（残す）
		}
		if k, has := known(t); k {
			return t, has
		}
		return t, true
	}
	if len(st.tables) == 1 {
		t := st.tables[0]
		if k, has := known(t); k {
			return t, has
		}
		return t, true
	}
	hit, n, unknown := "", 0, false
	for _, t := range st.tables {
		k, has := known(t)
		if !k {
			unknown = true
			continue
		}
		if has && !strings.EqualFold(hit, t) {
			hit = t
			n++
		}
	}
	switch {
	case n == 1:
		return hit, true
	case n > 1:
		return "", true // 曖昧（どのテーブルか決められない）。比べない
	}
	return "", unknown
}

func parseWhere(ts []sqlTok, st *sqlStmt, cat *sqlCatalog) []sqlWhere {
	var preds [][]sqlTok
	depth := 0
	start := 0
	between := false
	for i, t := range ts {
		if t.kind == 'o' && t.s == "(" {
			depth++
		} else if t.kind == 'o' && t.s == ")" {
			depth--
		}
		if depth != 0 || t.kind != 'i' {
			continue
		}
		if t.low == "between" {
			between = true
			continue
		}
		if t.low == "and" && between {
			between = false
			continue
		}
		if t.low == "and" || t.low == "or" {
			preds = append(preds, ts[start:i])
			start = i + 1
		}
	}
	preds = append(preds, ts[start:])
	var out []sqlWhere
	idx := map[string]int{}
	for _, p := range preds {
		ps := paramsIn(p)
		for _, c := range columnsIn(p) {
			table, keep := st.resolveCol(c.qual, c.col, cat)
			if !keep {
				continue
			}
			c.table = table
			if j, ok := idx[c.col]; ok {
				out[j].params = append(out[j].params, ps...)
				continue
			}
			c.params = ps
			idx[c.col] = len(out)
			out = append(out, c)
		}
	}
	return out
}

// starColumns: `*` / `t.*` をスキーマのカラムに広げる（テーブルを全部知っているときだけ。8-2b レビュー C5: Scan の引数の
// 順をカラムに合わせるため）。広げられなければ nil
func (st *sqlStmt) starColumns(body []sqlTok, cat *sqlCatalog) []sqlCol {
	tables := st.tables
	if len(body) == 3 {
		t, ok := st.aliases[strings.ToLower(identText(body[0]))]
		if !ok || t == "" {
			return nil
		}
		tables = []string{t}
	}
	if len(tables) == 0 || cat == nil {
		return nil
	}
	var out []sqlCol
	for _, t := range tables {
		cols, ok := cat.cols[strings.ToLower(t)]
		if !ok {
			return nil
		}
		for _, c := range cols {
			out = append(out, sqlCol{name: c, column: c, table: t})
		}
	}
	return out
}

func selectItems(ts []sqlTok, st *sqlStmt, cat *sqlCatalog) []sqlCol {
	var out []sqlCol
	used := idSet{}
	for k, item := range splitComma(ts) {
		if len(item) == 0 {
			continue
		}
		alias := ""
		body := item
		if len(item) >= 2 && item[len(item)-2].kind == 'i' && item[len(item)-2].low == "as" {
			alias = identText(item[len(item)-1])
			body = item[:len(item)-2]
		} else if len(item) >= 2 && (item[len(item)-1].kind == 'i' || item[len(item)-1].kind == 'q') {
			prev := item[len(item)-2]
			if prev.s == ")" || (prev.kind == 'i' && !sqlKeywords[prev.low]) || prev.kind == 'q' {
				alias = identText(item[len(item)-1])
				body = item[:len(item)-1]
			}
		}
		if len(body) == 0 {
			continue
		}
		col := sqlCol{}
		// `*` / `t.*`: スキーマで広げる。広げられなければ印だけ（TS の側が広げる）
		if last := body[len(body)-1]; last.s == "*" && (len(body) == 1 || (len(body) == 3 && body[1].s == ".")) {
			if cols := st.starColumns(body, cat); cols != nil {
				for _, c := range cols {
					c.id = uniqueID(c.name, used)
					out = append(out, c)
				}
				continue
			}
			star := sqlCol{star: true}
			if len(body) == 3 {
				star.table = st.aliases[strings.ToLower(identText(body[0]))]
			} else if len(st.tables) == 1 {
				star.table = st.table
			}
			out = append(out, star)
			continue
		}
		// カラム（t.col も）と cast
		j := 0
		qual := ""
		if len(body) >= 3 && (body[0].kind == 'i' || body[0].kind == 'q') && body[1].s == "." {
			j = 2
			qual = identText(body[0])
		}
		simple := j < len(body) && (body[j].kind == 'i' || body[j].kind == 'q') && !sqlKeywords[body[j].low]
		if simple {
			rest := body[j+1:]
			if len(rest) == 0 {
				col.column = identText(body[j])
			} else if rest[0].s == "::" {
				col.column = identText(body[j])
				col.cast = castOf(body, j+1)
				// cast の後に何も無いときだけカラム
				n := 1 + len(strings.Fields(strings.Replace(col.cast, "[]", "", -1)))
				if len(rest) > n+strings.Count(col.cast, "[]")*2 {
					col.column = ""
					col.cast = ""
				}
			}
		}
		if col.column == "" {
			qual = ""
			var refs []sqlWhere
			for _, r := range columnsIn(body) {
				if _, keep := st.resolveCol(r.qual, r.col, cat); keep {
					refs = append(refs, r)
				}
			}
			if len(refs) == 1 {
				col.column = refs[0].col
				qual = refs[0].qual
			}
			// 字句をつなぐ（strings.Builder。+= は式が長いと O(n²)。8-2b レビュー S2c）
			var sb strings.Builder
			for _, t := range body {
				sb.WriteString(t.s)
			}
			col.expr = sb.String()
			// 最後が cast なら型が分かる
			for x := len(body) - 1; x > 0; x-- {
				if body[x].s == "::" {
					col.cast = castOf(body, x)
					break
				}
				if body[x].s == ")" || body[x].kind == 'i' {
					continue
				}
				break
			}
		}
		if col.column != "" {
			col.table, _ = st.resolveCol(qual, col.column, cat)
		} else if len(st.tables) == 1 {
			col.table = st.table
		}
		name := alias
		if name == "" {
			switch {
			case col.expr == "" && col.column != "":
				name = col.column
			case len(body) >= 2 && body[0].kind == 'i' && body[1].s == "(":
				name = body[0].low
			default:
				name = "expr" + itoa(k+1)
			}
		}
		col.name = name
		col.id = uniqueID(name, used)
		out = append(out, col)
	}
	return out
}

// fromList: FROM 句（と DELETE の USING）のテーブルと別名。`[schema.]table [AS] alias` がカンマと JOIN で並ぶ。
// 副問い合わせ（`(SELECT …) x`）は別名だけ（テーブルは ""）。ON / USING の条件は読み飛ばす
func fromList(ts []sqlTok, d []int, from int) ([]string, map[string]string) {
	var tables []string
	aliases := map[string]string{}
	aliasAt := func(j int, table string) int {
		if j < len(ts) && ts[j].kind == 'i' && ts[j].low == "as" {
			j++
		}
		if j < len(ts) && ((ts[j].kind == 'i' && !sqlKeywords[ts[j].low] && !joinWords[ts[j].low] && !whereEnd[ts[j].low]) || ts[j].kind == 'q') {
			aliases[strings.ToLower(identText(ts[j]))] = table
			j++
		}
		return j
	}
	expect := true
	for k := from + 1; k < len(ts); k++ {
		if d[k] != 0 {
			continue
		}
		t := ts[k]
		if t.kind == 'i' && (t.low == "where" || whereEnd[t.low]) {
			break
		}
		switch {
		case t.kind == 'o' && t.s == ",", t.kind == 'i' && (t.low == "join" || t.low == "using"):
			expect = true
			continue
		case t.kind == 'i' && t.low == "on":
			expect = false
			continue
		}
		if !expect {
			continue
		}
		expect = false
		if t.kind == 'o' && t.s == "(" {
			// 副問い合わせ・USING (列): 対の ")" の後の別名
			k = aliasAt(closeAt(ts, k)+1, "") - 1
			continue
		}
		name, next := tableAt(ts, k)
		if name == "" {
			continue
		}
		tables = append(tables, name)
		aliases[strings.ToLower(name)] = name
		k = aliasAt(next, name) - 1
	}
	return tables, aliases
}

func identList(ts []sqlTok) []string {
	var out []string
	for _, part := range splitComma(ts) {
		for _, t := range part {
			if t.kind == 'i' || t.kind == 'q' {
				out = append(out, identText(t))
				break
			}
		}
	}
	return out
}

func compact(s string) string { return strings.Join(strings.Fields(s), " ") }

// maxSQLText は SQL として読む文字列の上限（それより長い定数は SQL にしない）
const maxSQLText = maxConstString

// parseSQL: 定数の SQL 文字列 → 文（読めなければ nil）。cat（スキーマ）があれば `*` を広げ、カラムの候補を絞る
func parseSQL(text string, cat *sqlCatalog) *sqlStmt {
	if len(text) > maxSQLText || !sqlStart.MatchString(text) {
		return nil
	}
	ts := sqlTokens(text)
	if len(ts) == 0 {
		return nil
	}
	d := depths(ts)
	i0 := findKw(ts, d, 0, "select", "insert", "update", "delete")
	if i0 < 0 {
		return nil
	}
	st := &sqlStmt{op: ts[i0].low, aliases: map[string]string{}}
	for _, t := range ts {
		if t.kind == 'p' && t.param > st.nParams {
			st.nParams = t.param
		}
	}
	whereText := func(w int) (string, []sqlTok) {
		if w < 0 {
			return "", nil
		}
		end := len(ts)
		for k := w + 1; k < len(ts); k++ {
			if d[k] == 0 && ts[k].kind == 'i' && whereEnd[ts[k].low] {
				end = k
				break
			}
		}
		body := ts[w+1 : end]
		if len(body) == 0 {
			return "", nil
		}
		return compact(text[body[0].start:body[len(body)-1].end]), body
	}
	returning := func() {
		r := findKw(ts, d, i0+1, "returning")
		if r >= 0 {
			st.read = selectItems(ts[r+1:], st, cat)
		}
	}
	// 書き換える表（INSERT / UPDATE / DELETE）とその別名
	target := func(name string, next int) {
		st.table = name
		if name == "" {
			return
		}
		st.tables = []string{name}
		st.aliases[strings.ToLower(name)] = name
		j := next
		if j < len(ts) && ts[j].kind == 'i' && ts[j].low == "as" {
			j++
		}
		if j < len(ts) && ts[j].kind == 'i' && !sqlKeywords[ts[j].low] && !joinWords[ts[j].low] && !whereEnd[ts[j].low] {
			st.aliases[ts[j].low] = name
		}
	}
	switch st.op {
	case "select":
		from := findKw(ts, d, i0+1, "from")
		if from < 0 {
			return nil
		}
		s := i0 + 1
		if s < len(ts) && (ts[s].low == "distinct" || ts[s].low == "all") {
			s++
			if s < len(ts) && ts[s].low == "on" && s+1 < len(ts) && ts[s+1].s == "(" {
				for s < from && ts[s].s != ")" {
					s++
				}
				s++
			}
		}
		st.tables, st.aliases = fromList(ts, d, from)
		if len(st.tables) == 0 {
			return nil
		}
		if first, _ := tableAt(ts, from+1); first != st.tables[0] {
			return nil // FROM の最初が副問い合わせ（表が決まらない）
		}
		st.table = st.tables[0]
		st.read = selectItems(ts[s:from], st, cat)
		w := findKw(ts, d, from+1, "where")
		wt, wts := whereText(w)
		st.where = parseWhere(wts, st, cat)
		st.display = "SELECT … FROM " + st.table
		if wt != "" {
			st.display = "SELECT … WHERE " + wt
		}
	case "insert":
		into := findKw(ts, d, i0+1, "into")
		if into < 0 {
			return nil
		}
		name, next := tableAt(ts, into+1)
		target(name, next)
		if next < len(ts) && ts[next].s == "(" {
			end := next
			for end < len(ts) && ts[end].s != ")" {
				end++
			}
			st.write = identList(ts[next+1 : end])
			next = end + 1
		}
		if v := findKw(ts, d, next, "values"); v >= 0 && v+1 < len(ts) && ts[v+1].s == "(" {
			end := v + 2
			depth := 1
			for end < len(ts) && depth > 0 {
				if ts[end].s == "(" {
					depth++
				} else if ts[end].s == ")" {
					depth--
				}
				end++
			}
			for _, part := range splitComma(ts[v+2 : end-1]) {
				p := 0
				if len(part) == 1 && part[0].kind == 'p' {
					p = part[0].param
				}
				st.writeParams = append(st.writeParams, p)
			}
		}
		st.display = "INSERT INTO " + st.table
		if len(st.write) > 0 {
			st.display += " (" + strings.Join(st.write, ", ") + ")"
		}
		returning()
	case "update":
		name, next := tableAt(ts, i0+1)
		target(name, next)
		set := findKw(ts, d, next, "set")
		if set < 0 {
			return nil
		}
		end := len(ts)
		for k := set + 1; k < len(ts); k++ {
			if d[k] == 0 && ts[k].kind == 'i' && (ts[k].low == "where" || ts[k].low == "from" || ts[k].low == "returning") {
				end = k
				break
			}
		}
		for _, part := range splitComma(ts[set+1 : end]) {
			if len(part) >= 3 && (part[0].kind == 'i' || part[0].kind == 'q') && part[1].s == "=" {
				st.write = append(st.write, identText(part[0]))
				p := 0
				if len(part) == 3 && part[2].kind == 'p' {
					p = part[2].param
				}
				st.writeParams = append(st.writeParams, p)
			}
		}
		// UPDATE … FROM other（Postgres）: 別のテーブルも WHERE のカラムの解決に使う
		if f := findKw(ts, d, set+1, "from"); f >= 0 {
			more, al := fromList(ts, d, f)
			st.tables = append(st.tables, more...)
			for k, v := range al {
				st.aliases[k] = v
			}
		}
		w := findKw(ts, d, set+1, "where")
		wt, wts := whereText(w)
		st.where = parseWhere(wts, st, cat)
		st.display = "UPDATE " + st.table + " SET " + strings.Join(st.write, ", ")
		if wt != "" {
			st.display += " WHERE " + wt
		}
		returning()
	case "delete":
		from := findKw(ts, d, i0+1, "from")
		if from < 0 {
			return nil
		}
		tables, al := fromList(ts, d, from)
		if len(tables) == 0 {
			return nil
		}
		st.table, st.tables, st.aliases = tables[0], tables, al
		w := findKw(ts, d, from+1, "where")
		wt, wts := whereText(w)
		st.where = parseWhere(wts, st, cat)
		st.display = "DELETE FROM " + st.table
		if wt != "" {
			st.display += " WHERE " + wt
		}
		returning()
	}
	if st.table == "" {
		return nil
	}
	if st.tables == nil {
		st.tables = []string{st.table}
	}
	return st
}

// sqlUse: 関数の中の定数の SQL 1 つ
type sqlUse struct {
	pos    int
	name   string
	stmt   *sqlStmt
	params []ast.Expr
	// params の数が分かる（呼び出しか並びの中）
	known  bool
	itemID string
	rowID  string
}

type scanEvent struct {
	pos   int
	dests []ast.Expr
}

// sqlColItem: カラムの項目（型は TS の側がマイグレーションで埋める。_sql はその印）
func sqlColItem(id, name, table, column, cast string) *Item {
	it := &Item{ID: itemID(id), Name: name, Type: "column"}
	if cast != "" {
		it.Type = cast
	}
	m := map[string]any{"table": table}
	if column != "" {
		m["column"] = column
	}
	if cast != "" {
		m["cast"] = cast
	}
	it.Meta = map[string]any{"_sql": m}
	return it
}

func (s *sqlStmt) meta(constName, itemID string) map[string]any {
	read := []string{}
	for _, c := range s.read {
		if c.star {
			read = append(read, "*")
		} else if c.column != "" {
			read = append(read, c.column)
		} else {
			read = append(read, c.name)
		}
	}
	where := []string{}
	for _, w := range s.where {
		where = append(where, w.col)
	}
	write := append([]string{}, s.write...)
	m := map[string]any{"table": s.table, "op": s.op, "read": read, "write": write, "where": where, "item": itemID}
	if len(s.tables) > 1 {
		m["tables"] = s.tables
	}
	if constName != "" {
		m["const"] = constName
	}
	return m
}

func normName(s string) string {
	return strings.ToLower(strings.Replace(s, "_", "", -1))
}
