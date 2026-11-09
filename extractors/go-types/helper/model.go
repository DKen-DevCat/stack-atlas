package main

// 型 → 項目（docs/17 §7 #9、docs/16 §5）。
//
// | Go の型 | wireType | 子 |
// |---|---|---|
// | bool / string / 整数 / 浮動小数 | boolean / string / integer / number | — |
// | time.Time | datetime（展開しない） | — |
// | []byte | bytes | — |
// | slice・array | array（nullable にしない。nil slice が JSON で null になる穴は既知として残す） | 要素の子 |
// | map | object（nullable にしない） | —（map のリテラルを Encode するときだけキーで展開） |
// | struct（モジュール・replace・vendor の型、無名の struct） | object | json タグの名前（`-` は除く、omitempty は optional） |
// | pointer | 指す先の型 ＋ nullable | 指す先の子 |
// | 標準ライブラリの名前付きの型（*http.Request など）・外部の型・interface | unknown | — |

import (
	"go/types"
	"reflect"
	"regexp"
	"strings"
)

// Item は v2 の項目（docs/16 §5）。
type Item struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Type     string         `json:"type"`
	WireType string         `json:"wireType,omitempty"`
	Nullable bool           `json:"nullable,omitempty"`
	Optional bool           `json:"optional,omitempty"`
	TypeRef  string         `json:"typeRef,omitempty"`
	Children []*Item        `json:"children,omitempty"`
	Meta     map[string]any `json:"meta,omitempty"`
}

// NamedType は types[] の 1 件。
type NamedType struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	File string `json:"file,omitempty"`
	Line int    `json:"line,omitempty"`
}

var badID = regexp.MustCompile(`[^A-Za-z0-9_$-]`)

// itemID: 項目 id の文字集合（docs/16 §3）。それ以外は _
func itemID(name string) string {
	s := badID.ReplaceAllString(name, "_")
	if s == "" {
		return "_"
	}
	return s
}

// idSet は口・親の中で使った id（値 1）と、重なった名前ごとに次に試す番号（キー "\x00"+id。id には出ない文字）
type idSet map[string]int

// uniqueID: 同じ口・同じ親の中で重ならない id（`a`・`a_2`・`a_3` …）。次に試す番号を覚えるので、同じ名前が n 回
// 重なっても O(n)（2026-11-09 8-2b レビュー: `SELECT a, a, a, …` で番号を 2 から数え直して O(n²) だった）
func uniqueID(base string, used idSet) string {
	id := itemID(base)
	if used[id] == 0 {
		used[id] = 1
		return id
	}
	k := used["\x00"+id]
	if k < 2 {
		k = 2
	}
	for used[id+"_"+itoa(k)] != 0 {
		k++
	}
	used["\x00"+id] = k + 1
	nid := id + "_" + itoa(k)
	used[nid] = 1
	return nid
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}

// budget は 1 箱の項目の残り
type budget struct {
	left      int
	truncated bool
}

func (b *budget) take() bool {
	if b.left <= 0 {
		b.truncated = true
		return false
	}
	b.left--
	return true
}

// typer は型 → 項目の環境（パッケージごとの表示と、名前付きの型の表）
type typer struct {
	a     *analyzer
	depth int
}

// typeString: 表示用の型（同じパッケージは修飾しない、他はパッケージ名で）。長い型（無名の struct の入れ子など）は
// 短くする（2026-11-09 8-2b レビュー S2a: `struct{ A, B struct{ A, B … } }` の入れ子は、同じ型を何度も書き出すので
// types.TypeString の結果が深さに対して倍々になる。深さ 20 で 89MB）
func typeString(t types.Type, here *types.Package) string {
	if b, ok := t.(*types.Basic); ok && b.Kind() == types.Invalid {
		return "unknown" // 解けない外部の型
	}
	qf := func(p *types.Package) string {
		if p == here {
			return ""
		}
		return p.Name()
	}
	return boundedTypeString(t, qf, 0)
}

// maxTypeString は表示用の型の文字数の上限（見積もり）。超える型は中を `…` にする
const maxTypeString = 256

// typeSizes: 型 → 書き出したときの文字数の見積もり（同じ型の値は 1 回だけ数える。上限で止める）
var typeSizes = map[types.Type]int{}

// typeSize: types.TypeString の長さの見積もり（上から押さえる。上限 maxTypeString+1 で打ち切る）
func typeSize(t types.Type, depth int) int {
	const over = maxTypeString + 1
	if t == nil {
		return 0
	}
	if depth > 32 {
		return over
	}
	if n, ok := typeSizes[t]; ok {
		return n
	}
	add := func(n, m int) int {
		if n+m > over {
			return over
		}
		return n + m
	}
	n := 0
	switch u := t.(type) {
	case *types.Basic:
		n = len(u.Name())
	case *types.Named:
		n = len(u.Obj().Name()) + 1
		if p := u.Obj().Pkg(); p != nil {
			n += len(p.Name())
		}
		if args := u.TypeArgs(); args != nil {
			for i := 0; i < args.Len(); i++ {
				n = add(n, typeSize(args.At(i), depth+1)+2)
			}
		}
	case *types.TypeParam:
		n = len(u.Obj().Name())
	case *types.Pointer:
		n = add(1, typeSize(u.Elem(), depth+1))
	case *types.Slice:
		n = add(2, typeSize(u.Elem(), depth+1))
	case *types.Array:
		n = add(22, typeSize(u.Elem(), depth+1))
	case *types.Chan:
		n = add(7, typeSize(u.Elem(), depth+1))
	case *types.Map:
		n = add(add(5, typeSize(u.Key(), depth+1)), typeSize(u.Elem(), depth+1))
	case *types.Struct:
		n = 8
		for i := 0; i < u.NumFields() && n < over; i++ {
			f := u.Field(i)
			n = add(n, len(f.Name())+len(u.Tag(i))+5)
			n = add(n, typeSize(f.Type(), depth+1))
		}
	case *types.Tuple:
		n = 2
		for i := 0; i < u.Len() && n < over; i++ {
			n = add(n, len(u.At(i).Name())+2)
			n = add(n, typeSize(u.At(i).Type(), depth+1))
		}
	case *types.Signature:
		n = add(add(6, typeSize(u.Params(), depth+1)), typeSize(u.Results(), depth+1))
		if tp := u.TypeParams(); tp != nil {
			for i := 0; i < tp.Len(); i++ {
				n = add(n, typeSize(tp.At(i).Constraint(), depth+1)+len(tp.At(i).Obj().Name())+2)
			}
		}
	case *types.Interface:
		n = 11
		for i := 0; i < u.NumExplicitMethods() && n < over; i++ {
			m := u.ExplicitMethod(i)
			n = add(n, len(m.Name())+2)
			n = add(n, typeSize(m.Type(), depth+1))
		}
		for i := 0; i < u.NumEmbeddeds() && n < over; i++ {
			n = add(n, typeSize(u.EmbeddedType(i), depth+1)+2)
		}
	case *types.Union:
		for i := 0; i < u.Len() && n < over; i++ {
			n = add(n, typeSize(u.Term(i).Type(), depth+1)+4)
		}
	default:
		n = 64 // 別名など（名前で書く）
	}
	typeSizes[t] = n
	return n
}

// boundedTypeString: 見積もりが上限を超えなければ types.TypeString、超えれば外側の形だけ書いて中を `…` にする
func boundedTypeString(t types.Type, qf types.Qualifier, depth int) string {
	if typeSize(t, 0) <= maxTypeString {
		return types.TypeString(t, qf)
	}
	if depth > 4 {
		return "…"
	}
	switch u := t.(type) {
	case *types.Pointer:
		return "*" + boundedTypeString(u.Elem(), qf, depth+1)
	case *types.Slice:
		return "[]" + boundedTypeString(u.Elem(), qf, depth+1)
	case *types.Array:
		return "[" + itoa(int(u.Len())) + "]" + boundedTypeString(u.Elem(), qf, depth+1)
	case *types.Chan:
		return "chan " + boundedTypeString(u.Elem(), qf, depth+1)
	case *types.Map:
		return "map[" + boundedTypeString(u.Key(), qf, depth+1) + "]" + boundedTypeString(u.Elem(), qf, depth+1)
	case *types.Struct:
		return "struct{…}"
	case *types.Signature:
		return "func(…)"
	case *types.Interface:
		return "interface{…}"
	case *types.Tuple:
		return "(…)"
	case *types.Named:
		name := u.Obj().Name()
		if p := u.Obj().Pkg(); p != nil {
			if q := qf(p); q != "" {
				name = q + "." + name
			}
		}
		return name + "[…]"
	}
	return "…"
}

func namedOf(t types.Type) *types.Named {
	n, _ := t.(*types.Named)
	return n
}

func pkgPath(o types.Object) string {
	if o == nil || o.Pkg() == nil {
		return ""
	}
	return o.Pkg().Path()
}

func isNamed(t types.Type, path, name string) bool {
	n := namedOf(t)
	return n != nil && n.Obj().Name() == name && pkgPath(n.Obj()) == path
}

func deref(t types.Type) (types.Type, bool) {
	if p, ok := t.(*types.Pointer); ok {
		return p.Elem(), true
	}
	return t, false
}

func isErrorType(t types.Type) bool {
	return types.Identical(t, types.Universe.Lookup("error").Type())
}

func isContext(t types.Type) bool { return isNamed(t, "context", "Context") }

func isResponseWriter(t types.Type) bool { return isNamed(t, "net/http", "ResponseWriter") }

func isRequestPtr(t types.Type) bool {
	e, ok := deref(t)
	return ok && isNamed(e, "net/http", "Request")
}

// ownPkg: 展開してよいパッケージ（モジュール・replace・vendor。標準ライブラリと外部は不透明）
func (ty *typer) ownPkg(o types.Object) bool {
	if o == nil || o.Pkg() == nil {
		return false
	}
	return ty.a.analyzablePkg(o.Pkg().Path())
}

// wireType: 線の上の形
func (ty *typer) wireType(t types.Type) string {
	if t == nil {
		return "unknown"
	}
	if n := namedOf(t); n != nil {
		switch {
		case isNamed(t, "time", "Time"):
			return "datetime"
		case isNamed(t, "encoding/json", "RawMessage"):
			return "unknown"
		}
		if !ty.ownPkg(n.Obj()) {
			// 標準ライブラリ・外部の名前付きの型は、基本型（time.Duration など）だけ形が分かる
			if b, ok := n.Underlying().(*types.Basic); ok {
				return basicWire(b)
			}
			return "unknown"
		}
	}
	switch u := t.Underlying().(type) {
	case *types.Basic:
		return basicWire(u)
	case *types.Pointer:
		return ty.wireType(u.Elem())
	case *types.Slice:
		if b, ok := u.Elem().Underlying().(*types.Basic); ok && b.Kind() == types.Byte {
			return "bytes"
		}
		return "array"
	case *types.Array:
		return "array"
	case *types.Map:
		return "object"
	case *types.Struct:
		return "object"
	}
	return "unknown"
}

func basicWire(b *types.Basic) string {
	info := b.Info()
	switch {
	case info&types.IsBoolean != 0:
		return "boolean"
	case info&types.IsString != 0:
		return "string"
	case info&types.IsInteger != 0:
		return "integer"
	case info&types.IsFloat != 0:
		return "number"
	}
	return "unknown"
}

// typeRef: 名前付きの struct の型（モジュール・replace・vendor）→ type:<名前>。slice / array / pointer は要素
func (ty *typer) typeRef(t types.Type) string {
	for i := 0; i < 4; i++ {
		switch u := t.(type) {
		case *types.Pointer:
			t = u.Elem()
			continue
		case *types.Slice:
			t = u.Elem()
			continue
		case *types.Array:
			t = u.Elem()
			continue
		}
		break
	}
	n := namedOf(t)
	if n == nil || !ty.ownPkg(n.Obj()) {
		return ""
	}
	if _, ok := n.Underlying().(*types.Struct); !ok {
		return ""
	}
	return ty.a.registerType(n)
}

type itemOpts struct {
	owner    string // 所属する名前付きの型（プロパティの項目）
	optional bool
	depth    int
	budget   *budget
	display  string
	here     *types.Package
}

// makeItem: 型 → 項目（子は再帰）
func (ty *typer) makeItem(id, name string, t types.Type, o itemOpts) *Item {
	it := &Item{ID: itemID(id), Name: name}
	if o.display != "" {
		it.Type = o.display
	} else if t != nil {
		it.Type = typeString(t, o.here)
	} else {
		it.Type = "unknown"
	}
	if t == nil {
		it.WireType = "unknown"
		return it
	}
	base, ptr := deref(t)
	if ptr {
		it.Nullable = true
	}
	if isErrorType(base) {
		it.Nullable = true
		return it
	}
	it.WireType = ty.wireType(base)
	if o.optional {
		it.Optional = true
	}
	own := ty.typeRef(base)
	if own != "" {
		it.TypeRef = own
	} else if o.owner != "" {
		it.TypeRef = o.owner
	}
	if o.depth > 0 {
		owner := own
		if owner == "" {
			owner = o.owner
		}
		it.Children = ty.children(base, o.depth, owner, o.budget, o.here)
	}
	return it
}

// structOf: 展開できる struct（slice / array は要素、pointer は指す先）
func (ty *typer) structOf(t types.Type) *types.Struct {
	for i := 0; i < 4; i++ {
		t, _ = deref(t)
		switch u := t.Underlying().(type) {
		case *types.Slice:
			t = u.Elem()
			continue
		case *types.Array:
			t = u.Elem()
			continue
		}
		break
	}
	t, _ = deref(t)
	if n := namedOf(t); n != nil {
		if isNamed(t, "time", "Time") || !ty.ownPkg(n.Obj()) {
			return nil
		}
	}
	s, _ := t.Underlying().(*types.Struct)
	return s
}

// jsonField: struct のフィールドの JSON の名前（"" は出さない）と omitempty
type jsonField struct {
	v        *types.Var
	json     string
	tagged   bool
	optional bool
}

func jsonFields(s *types.Struct, seen map[*types.Struct]bool) []jsonField {
	if seen[s] {
		return nil
	}
	seen[s] = true
	var out []jsonField
	for i := 0; i < s.NumFields(); i++ {
		f := s.Field(i)
		tag := reflect.StructTag(s.Tag(i)).Get("json")
		name, opts, _ := strings.Cut(tag, ",")
		if name == "-" && opts == "" {
			continue
		}
		// 埋め込み（タグ無し）の struct はフィールドを上げる（encoding/json と同じ）
		if f.Embedded() && name == "" {
			et, _ := deref(f.Type())
			if es, ok := et.Underlying().(*types.Struct); ok {
				out = append(out, jsonFields(es, seen)...)
				continue
			}
		}
		if !f.Exported() {
			continue
		}
		jf := jsonField{v: f, json: f.Name()}
		if name != "" {
			jf.json = name
			jf.tagged = true
		}
		jf.optional = strings.Contains(","+opts+",", ",omitempty,") || strings.Contains(","+opts+",", ",omitzero,")
		out = append(out, jf)
	}
	return out
}

func (ty *typer) children(t types.Type, depth int, owner string, b *budget, here *types.Package) []*Item {
	s := ty.structOf(t)
	if s == nil {
		return nil
	}
	var out []*Item
	used := idSet{}
	for _, jf := range jsonFields(s, map[*types.Struct]bool{}) {
		if !b.take() {
			break
		}
		it := ty.makeItem(uniqueID(jf.json, used), jf.v.Name(), jf.v.Type(), itemOpts{
			owner: owner, optional: jf.optional, depth: depth - 1, budget: b, here: here,
		})
		if jf.tagged {
			it.Meta = map[string]any{"json": jf.json}
		}
		out = append(out, it)
	}
	return out
}

// fieldJSONID: フィールド（selection の先）の項目 id（json の名前）
func fieldJSONID(v *types.Var, owner types.Type) string {
	s, _ := deref(owner)
	if st, ok := s.Underlying().(*types.Struct); ok {
		for _, jf := range jsonFields(st, map[*types.Struct]bool{}) {
			if jf.v == v {
				return itemID(jf.json)
			}
		}
	}
	return itemID(v.Name())
}

// countItems: 入れ子を含む項目の数
func countItems(items []*Item) int {
	n := 0
	for _, it := range items {
		n += 1 + countItems(it.Children)
	}
	return n
}
