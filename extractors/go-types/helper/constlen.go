package main

// 定数の文字列の長さ（2026-11-09 8-2b レビュー S2b）。
//
// go/constant は文字列の連結（`const A1 = A0 + A0`）を平らにせず木（rope）のまま持ち、constant.StringVal の時に
// 初めて平らにする。名前を挟んで倍々に重ねると、数行の宣言で数百 MB〜GB になる（A0 = 16 文字・24 段で 1.1GB）。
// go/types も `len(A)`・比較・添字で平らにするので、型の検査の前に AST で長さを見積もり（上から押さえる）、
// 上限（maxConstString）を超える連結は空の文字列に置き換えてから検査する（実行しないので値は使わない）。
// 解析の側（constString）も同じ見積もりで、上限を超える定数は「定数の文字列ではない」として扱う。
//
// 見積もり: 文字列のリテラルは書いた長さ、`+` は和、定数の名前は宣言の式（同じパッケージは名前で。スコープは見ないので
// 同じ名前のものの最大）、`pkg.Name` は import 先のパッケージの表（依存を先に検査する）、変換 `T(x)` と min / max は
// 引数の最大。標準ライブラリの定数は信頼して 0。それ以外（変数・呼び出しの結果）は文字列の定数ではない（0）

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"sort"
	"strings"
)

// maxConstString は定数の文字列の上限（見積もり）。超える連結は空にする。SQL として読む上限も同じ
const maxConstString = 64 << 10

// constOver は見積もりの打ち切り（これ以上は数えない）
const constOver = maxConstString + 1

func addLen(a, b int64) int64 {
	if a+b > constOver {
		return constOver
	}
	return a + b
}

// constDecl は定数の宣言の 1 つ（暗黙の繰り返し `const ( A = x; B )` は前の式を指す）
type constDecl struct {
	spec *ast.ValueSpec // 式を持つ宣言（暗黙の繰り返しなら前のもの）
	i    int
	file *ast.File
}

func (d constDecl) expr() ast.Expr {
	if d.i < len(d.spec.Values) {
		return d.spec.Values[d.i]
	}
	return nil
}

// constEstimator はパッケージ 1 つの見積もり（名前で解く）
type constEstimator struct {
	l     *loader
	p     *Pkg
	decls map[string][]constDecl
	memo  map[string]int64
	busy  map[string]bool
	// `+` の式ごとの見積もり（長い和 `a + b + … ` を外から順に見ても O(n) に）
	bins map[*ast.BinaryExpr][2]int64
	// ファイル → import の名前 → 依存のパッケージ（"." は dot import の並び）
	imports map[*ast.File]map[string]*Pkg
	dots    map[*ast.File][]*Pkg
}

func (l *loader) newConstEstimator(p *Pkg) *constEstimator {
	e := &constEstimator{l: l, p: p, decls: map[string][]constDecl{}, memo: map[string]int64{}, busy: map[string]bool{},
		bins: map[*ast.BinaryExpr][2]int64{}, imports: map[*ast.File]map[string]*Pkg{}, dots: map[*ast.File][]*Pkg{}}
	for _, f := range p.Files {
		names := map[string]*Pkg{}
		for _, s := range f.Imports {
			path := strings.Trim(s.Path.Value, "\"`")
			key, ok := p.deps[path]
			if !ok {
				continue
			}
			dep := l.pkgs[key]
			if dep == nil {
				continue
			}
			switch {
			case s.Name == nil:
				names[dep.Name] = dep
			case s.Name.Name == ".":
				e.dots[f] = append(e.dots[f], dep)
			case s.Name.Name != "_":
				names[s.Name.Name] = dep
			}
		}
		e.imports[f] = names
		ast.Inspect(f, func(n ast.Node) bool {
			g, ok := n.(*ast.GenDecl)
			if !ok || g.Tok != token.CONST {
				return true
			}
			var last *ast.ValueSpec
			for _, sp := range g.Specs {
				vs, ok := sp.(*ast.ValueSpec)
				if !ok {
					continue
				}
				owner := vs
				if len(vs.Values) == 0 && last != nil {
					owner = last
				} else {
					last = vs
				}
				for i, name := range vs.Names {
					e.decls[name.Name] = append(e.decls[name.Name], constDecl{spec: owner, i: i, file: f})
				}
			}
			return true
		})
	}
	return e
}

// name: パッケージの中の定数の名前の見積もり（同じ名前の宣言の最大）
func (e *constEstimator) name(n string, f *ast.File) (int64, bool) {
	if v, ok := e.memo[n]; ok {
		return v, true
	}
	ds, ok := e.decls[n]
	if !ok {
		for _, dep := range e.dots[f] {
			if v, ok := dep.consts[n]; ok {
				return v, true
			}
		}
		return 0, false
	}
	if e.busy[n] {
		return 0, true // 循環（型の検査のエラーになる）
	}
	e.busy[n] = true
	var best int64
	for _, d := range ds {
		if x := d.expr(); x != nil {
			if v, _ := e.expr(x, d.file); v > best {
				best = v
			}
		}
	}
	e.busy[n] = false
	e.memo[n] = best
	return best, true
}

// expr: 式の文字列の長さの見積もり（文字列らしいか）
func (e *constEstimator) expr(x ast.Expr, f *ast.File) (int64, bool) {
	switch v := x.(type) {
	case *ast.BasicLit:
		if v.Kind == token.STRING {
			return int64(len(v.Value)), true
		}
	case *ast.ParenExpr:
		return e.expr(v.X, f)
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			if r, ok := e.bins[v]; ok {
				return r[0], r[1] != 0
			}
			a, sa := e.expr(v.X, f)
			b, sb := e.expr(v.Y, f)
			n, str := addLen(a, b), sa || sb
			r := [2]int64{n, 0}
			if str {
				r[1] = 1
			}
			e.bins[v] = r
			return n, str
		}
	case *ast.Ident:
		return e.name(v.Name, f)
	case *ast.SelectorExpr:
		if pk, ok := v.X.(*ast.Ident); ok {
			if dep := e.imports[f][pk.Name]; dep != nil {
				n, ok := dep.consts[v.Sel.Name]
				return n, ok
			}
		}
	case *ast.CallExpr:
		if id, ok := v.Fun.(*ast.Ident); ok && (id.Name == "len" || id.Name == "cap") {
			return 0, false
		}
		var best int64
		str := false
		for _, arg := range v.Args {
			n, s := e.expr(arg, f)
			if n > best {
				best = n
			}
			str = str || s
		}
		return best, str
	}
	return 0, false
}

func emptyString(pos token.Pos) *ast.BasicLit {
	return &ast.BasicLit{ValuePos: pos, Kind: token.STRING, Value: `""`}
}

// boundConsts: 型の検査の前に、上限を超える文字列の連結（`+`）を空の文字列にする（式はその場で書き換える）。
// 依存は先に検査してあり、import 先の定数の見積もりは dep.consts にある。p.consts（このパッケージの表）を作る
func (l *loader) boundConsts(p *Pkg) {
	e := l.newConstEstimator(p)
	cut := 0
	for _, f := range p.Files {
		ast.Inspect(f, func(n ast.Node) bool {
			bin, ok := n.(*ast.BinaryExpr)
			if !ok || bin.Op != token.ADD {
				return true
			}
			if v, str := e.expr(bin, f); str && v > maxConstString {
				bin.X = emptyString(bin.X.Pos())
				bin.Y = emptyString(bin.Y.Pos())
				cut++
				return false
			}
			return true
		})
	}
	// 書き換えた後の表（import する側が使う）
	e2 := l.newConstEstimator(p)
	p.consts = map[string]int64{}
	names := make([]string, 0, len(e2.decls))
	for n := range e2.decls {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if v, ok := e2.name(n, nil); ok {
			p.consts[n] = v
		}
	}
	if cut > 0 {
		l.warn("bigconst:"+p.Path, fmt.Sprintf("go-types: %s の長すぎる文字列の定数（%d バイトを超える連結）%d 個は空として読みます", l.rel(p.Dir), maxConstString, cut))
	}
}

// constLen: 解析の側の見積もり（型の情報で名前を解く）。標準ライブラリの定数は 0、表に無いモジュールの定数は上限を超える扱い
func (a *analyzer) constLen(info *types.Info, x ast.Expr) int64 {
	switch v := unparen(x).(type) {
	case *ast.BasicLit:
		return int64(len(v.Value))
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			return addLen(a.constLen(info, v.X), a.constLen(info, v.Y))
		}
		return 0
	case *ast.Ident:
		return a.objLen(info.Uses[v])
	case *ast.SelectorExpr:
		return a.objLen(info.Uses[v.Sel])
	case *ast.CallExpr:
		var best int64
		for _, arg := range v.Args {
			if n := a.constLen(info, arg); n > best {
				best = n
			}
		}
		return best
	}
	return 0
}

func (a *analyzer) objLen(o types.Object) int64 {
	c, ok := o.(*types.Const)
	if !ok || c.Pkg() == nil {
		return 0
	}
	if a.kindOf[c.Pkg().Path()] == kindStd {
		return 0
	}
	if t, ok := a.constsByPath[c.Pkg().Path()]; ok {
		if n, ok := t[c.Name()]; ok {
			return n
		}
	}
	return constOver // 見積もれない定数は平らにしない
}
