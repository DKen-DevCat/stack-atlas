package main

// links（箱の中の対応。docs/16 §6、docs/17 §7 #3、D58）:
//   - exact: 引数・呼び出しの戻り（ret_n）・レシピ（query / path / body / row）を、そのまま（1 回だけ代入された変数を経由
//     しても）参照する式
//   - crude: 2 回以上代入される変数を経由するもの、SQL の値を struct のフィールドとカラムの名前で照合したもの、
//     SELECT の 1 行から戻り値へ（Scan が無いとき）
//   - 起動の links: データ由来の link が無い out の項目へ、起動の項目（call / r、無ければ引数の全部）から crude。
//     status は、その前に戻った呼び出し（ret_n）からも crude（状態は呼び出しの結果で決まる）
// 行き先は out の項目の木に合わせて、無い段は粗くする（親に付ける）。

import (
	"go/ast"
	"go/token"
	"go/types"
	"regexp"
	"strings"
)

var retRe = regexp.MustCompile(`^ret_\d+$`)
var rowRe = regexp.MustCompile(`^row(_\d+)?$`)

func joinSub(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	}
	return a + "." + b
}

// project: 値 x の sources → x.<path> の sources
func project(srcs []src, path string) []src {
	if path == "" {
		return srcs
	}
	var out []src
	for _, s := range srcs {
		switch {
		case s.sub == "":
			out = append(out, src{from: s.from + "." + path, exact: s.exact})
		case s.sub == path:
			out = append(out, src{from: s.from, exact: s.exact})
		case strings.HasPrefix(s.sub, path+"."):
			out = append(out, src{from: s.from, exact: s.exact, sub: s.sub[len(path)+1:]})
		case strings.HasPrefix(path, s.sub+"."):
			out = append(out, src{from: s.from + "." + path[len(s.sub)+1:], exact: s.exact})
		}
	}
	return out
}

// resolveRef: `in/a.b.c` を口の項目の木で、ある所まで（無い段で止める）
func resolveRef(items []*Item, ref string) string {
	slash := strings.Index(ref, "/")
	if slash < 0 {
		return ""
	}
	port := ref[:slash]
	list := items
	var kept []string
	for _, seg := range strings.Split(ref[slash+1:], ".") {
		var hit *Item
		for _, x := range list {
			if x.ID == seg {
				hit = x
			}
		}
		if hit == nil {
			break
		}
		kept = append(kept, seg)
		list = hit.Children
	}
	if len(kept) == 0 {
		return ""
	}
	return port + "/" + strings.Join(kept, ".")
}

func itemAt(items []*Item, path string) *Item {
	list := items
	var cur *Item
	for _, seg := range strings.Split(path, ".") {
		cur = nil
		for _, x := range list {
			if x.ID == seg {
				cur = x
			}
		}
		if cur == nil {
			return nil
		}
		list = cur.Children
	}
	return cur
}

type linkSet struct {
	list []Link
	at   map[string]int
}

func (ls *linkSet) add(from, to string, exact bool) {
	if from == "" || to == "" {
		return
	}
	k := from + "\x00" + to
	conf := "crude"
	if exact {
		conf = "exact"
	}
	if i, ok := ls.at[k]; ok {
		if exact {
			ls.list[i].Confidence = "exact"
		}
		return
	}
	ls.at[k] = len(ls.list)
	ls.list = append(ls.list, Link{From: from, To: to, Confidence: conf})
}

func (ls *linkSet) targets(out string) bool {
	for _, l := range ls.list {
		if l.To == out || strings.HasPrefix(l.To, out+".") {
			return true
		}
	}
	return false
}

func (ls *linkSet) fromAny(in string) bool {
	for _, l := range ls.list {
		if l.From == in || strings.HasPrefix(l.From, in+".") {
			return true
		}
	}
	return false
}

func (a *analyzer) buildLinks(b *Box) {
	info := b.info
	byObj := map[types.Object][]assign{}
	for _, as := range b.assigns {
		if as.obj != nil {
			byObj[as.obj] = append(byObj[as.obj], as)
		}
	}
	paramSrc := map[types.Object]string{}
	for _, p := range b.params {
		paramSrc[p.obj] = "in/" + p.id
	}
	if b.reqObj != nil && b.inItem("r") != nil {
		paramSrc[b.reqObj] = "in/r"
	}
	callOf := map[*ast.CallExpr]*callEvent{}
	for _, ev := range b.calls {
		callOf[ev.call] = ev
	}
	memo := map[types.Object][]src{}
	busy := map[types.Object]bool{}

	var sourcesOf func(e ast.Expr) []src
	retSources := func(ev *callEvent, i int) []src {
		res := ev.callee.sig.Results()
		ret := b.inItem("ret_" + itoa(ev.k))
		if ret == nil || i >= res.Len() {
			return nil
		}
		if isErrorType(res.At(i).Type()) {
			if len(ev.callee.results) == 0 {
				return []src{{from: "in/" + ret.ID, exact: true}}
			}
			return nil
		}
		j := 0
		for _, idx := range ev.callee.results {
			if idx == i {
				break
			}
			j++
		}
		if len(ev.callee.results) == 1 {
			return []src{{from: "in/" + ret.ID, exact: true}}
		}
		if c := valueChild(ret, j); c != "" {
			return []src{{from: "in/" + ret.ID + "." + c, exact: true}}
		}
		return []src{{from: "in/" + ret.ID, exact: true}}
	}
	ofAssign := func(as assign) []src {
		var xs []src
		switch {
		case as.fixed != nil:
			xs = as.fixed
		case as.index >= 0:
			if call, ok := unparen(as.expr).(*ast.CallExpr); ok {
				if ev := callOf[call]; ev != nil {
					xs = retSources(ev, as.index)
				} else if as.index == 0 {
					xs = sourcesOf(as.expr)
				}
			}
		default:
			xs = sourcesOf(as.expr)
		}
		if as.sub == "" {
			return xs
		}
		out := make([]src, 0, len(xs))
		for _, s := range xs {
			out = append(out, src{from: s.from, exact: s.exact, sub: joinSub(as.sub, s.sub)})
		}
		return out
	}
	var ofObj func(o types.Object) []src
	ofObj = func(o types.Object) []src {
		if o == nil {
			return nil
		}
		if p, ok := paramSrc[o]; ok {
			return []src{{from: p, exact: true}}
		}
		list := byObj[o]
		if len(list) == 0 {
			return nil
		}
		if m, ok := memo[o]; ok {
			return m
		}
		if busy[o] {
			return nil
		}
		busy[o] = true
		var out []src
		for _, as := range list {
			out = append(out, ofAssign(as)...)
		}
		if reassigned(list) {
			for i := range out {
				out[i].exact = false
			}
		}
		busy[o] = false
		memo[o] = out
		return out
	}
	sourcesOf = func(e ast.Expr) []src {
		if e == nil {
			return nil
		}
		if s, ok := b.recipes[e]; ok {
			return []src{s}
		}
		switch x := e.(type) {
		case *ast.ParenExpr:
			return sourcesOf(x.X)
		case *ast.StarExpr:
			return sourcesOf(x.X)
		case *ast.UnaryExpr:
			return sourcesOf(x.X)
		case *ast.Ident:
			return ofObj(info.Uses[x])
		case *ast.SelectorExpr:
			if sel, ok := info.Selections[x]; ok {
				if sel.Kind() == types.FieldVal {
					return project(sourcesOf(x.X), strings.Join(selectionPath(sel), "."))
				}
				return nil
			}
			return ofObj(info.Uses[x.Sel])
		case *ast.CallExpr:
			if ev := callOf[x]; ev != nil {
				return retSources(ev, 0)
			}
			if tv, ok := info.Types[x.Fun]; ok && tv.IsType() && len(x.Args) == 1 {
				return sourcesOf(x.Args[0])
			}
			// 箱でない関数（標準ライブラリ・外部・組み込み）: 引数と受け手から作った値（crude）
			var out []src
			if sel, ok := unparen(x.Fun).(*ast.SelectorExpr); ok {
				if s, ok := info.Selections[sel]; ok && s.Kind() == types.MethodVal {
					out = append(out, sourcesOf(sel.X)...)
				}
			}
			for _, arg := range x.Args {
				out = append(out, sourcesOf(arg)...)
			}
			for i := range out {
				out[i].exact = false
			}
			return out
		case *ast.CompositeLit:
			var out []src
			tv := info.Types[x]
			var st *types.Struct
			isMap := false
			if tv.Type != nil {
				base, _ := deref(tv.Type)
				st, _ = base.Underlying().(*types.Struct)
				_, isMap = base.Underlying().(*types.Map)
			}
			for i, el := range x.Elts {
				if kv, ok := el.(*ast.KeyValueExpr); ok {
					sub := ""
					if st != nil {
						if id, ok := kv.Key.(*ast.Ident); ok {
							if f, ok := info.Uses[id].(*types.Var); ok {
								sub = fieldJSONID(f, tv.Type)
							}
						}
					} else if isMap {
						if k, ok := a.constString(info, kv.Key); ok {
							sub = itemID(k)
						}
					}
					for _, s := range sourcesOf(kv.Value) {
						out = append(out, src{from: s.from, exact: s.exact, sub: joinSub(sub, s.sub)})
					}
					continue
				}
				sub := ""
				if st != nil && i < st.NumFields() {
					sub = fieldJSONID(st.Field(i), tv.Type)
				}
				for _, s := range sourcesOf(el) {
					out = append(out, src{from: s.from, exact: s.exact, sub: joinSub(sub, s.sub)})
				}
			}
			return out
		case *ast.BinaryExpr:
			return append(sourcesOf(x.X), sourcesOf(x.Y)...)
		case *ast.IndexExpr:
			return sourcesOf(x.X)
		case *ast.SliceExpr:
			return sourcesOf(x.X)
		case *ast.TypeAssertExpr:
			return sourcesOf(x.X)
		}
		return nil
	}

	ls := &linkSet{at: map[string]int{}}
	add := func(s src, to string) {
		from := resolveRef(b.in, s.from)
		dest := resolveRef(b.out, joinSub(to, s.sub))
		if dest == "" {
			dest = resolveRef(b.out, to)
		}
		ls.add(from, dest, s.exact)
	}
	// 呼び出しの引数
	for _, ev := range b.calls {
		for _, s := range ev.slots {
			for _, x := range sourcesOf(s.arg) {
				add(x, "out/call_"+itoa(ev.k)+"."+s.id)
			}
		}
	}
	// Encode
	for _, ev := range b.encodes {
		if ev.keys != nil {
			it := b.outItem(ev.id)
			for _, k := range ev.order {
				v := ev.keys[k]
				cid := itemID(k)
				if it != nil {
					for _, c := range it.Children {
						if c.Name == k {
							cid = c.ID
						}
					}
				}
				for _, x := range sourcesOf(v) {
					add(x, "out/"+ev.id+"."+cid)
				}
			}
			continue
		}
		for _, x := range sourcesOf(ev.expr) {
			add(x, "out/"+ev.id)
		}
	}
	// 戻り値
	if ret := b.outItem("return"); ret != nil {
		res := b.sig.Results()
		errOnly := len(b.results) == 0
		walkReturns(b.decl.Body, func(r *ast.ReturnStmt) {
			if len(r.Results) == 1 && res.Len() > 1 {
				for _, x := range sourcesOf(r.Results[0]) {
					add(x, "out/return")
				}
				return
			}
			if len(r.Results) != res.Len() {
				return
			}
			j := 0
			for i, e := range r.Results {
				if isErrorType(res.At(i).Type()) && !errOnly {
					continue
				}
				target := "out/return"
				if len(b.results) > 1 {
					if c := valueChild(ret, j); c != "" {
						target += "." + c
					}
				}
				j++
				for _, x := range sourcesOf(e) {
					add(x, target)
				}
			}
		})
	}
	// SQL（プレースホルダ → カラム）
	for _, u := range b.sqls {
		st := u.stmt
		item := "out/" + u.itemID
		for _, w := range st.where {
			for _, p := range w.params {
				if u.known && p >= 1 && p <= len(u.params) {
					for _, x := range sourcesOf(u.params[p-1]) {
						add(x, item+"."+itemID(w.col))
					}
				}
			}
		}
		if len(st.write) == 0 || !u.known || len(u.params) == 0 {
			continue
		}
		if len(u.params) == st.nParams {
			for i, col := range st.write {
				if i < len(st.writeParams) && st.writeParams[i] >= 1 && st.writeParams[i] <= len(u.params) {
					for _, x := range sourcesOf(u.params[st.writeParams[i]-1]) {
						add(x, item+"."+itemID(col))
					}
				}
			}
			continue
		}
		// 数が合わない: struct の引数のフィールドとカラムを名前で照合（crude）
		for _, p := range u.params {
			for _, x := range sourcesOf(p) {
				from := resolveRef(b.in, x.from)
				if from == "" {
					continue
				}
				ls.add(from, item, false)
				fi := itemAt(b.in, strings.TrimPrefix(from, "in/"))
				if fi == nil {
					continue
				}
				for _, c := range fi.Children {
					for _, col := range st.write {
						if normName(c.ID) == normName(col) || normName(c.Name) == normName(col) {
							ls.add(from+"."+c.ID, item+"."+itemID(col), false)
						}
					}
				}
			}
		}
	}
	// SELECT の 1 行 → 戻り値（Scan が無く、行から links が出ていないとき）
	if ret := b.outItem("return"); ret != nil && len(b.results) > 0 {
		for _, it := range b.in {
			if !rowRe.MatchString(it.ID) || ls.fromAny("in/"+it.ID) {
				continue
			}
			ls.add("in/"+it.ID, "out/return", false)
			for _, rc := range it.Children {
				for _, oc := range ret.Children {
					if rc.ID != oc.ID && normName(rc.ID) == normName(oc.ID) {
						ls.add("in/"+it.ID+"."+rc.ID, "out/return."+oc.ID, false)
					}
				}
			}
		}
	}
	// 起動の links
	var starts []*Item
	for _, it := range b.in {
		if it.ID == "call" || it.ID == "r" {
			starts = append(starts, it)
		}
	}
	if len(starts) == 0 {
		for _, it := range b.in {
			if !retRe.MatchString(it.ID) && !rowRe.MatchString(it.ID) {
				starts = append(starts, it)
			}
		}
	}
	var firstStatus token.Pos
	if len(b.statuses) > 0 {
		firstStatus = b.statuses[0].Pos()
	}
	for _, o := range a.outOrder(b) {
		if ls.targets("out/" + o.ID) {
			continue
		}
		for _, s := range starts {
			ls.add("in/"+s.ID, "out/"+o.ID, false)
		}
		if o.ID == "status" {
			for _, ev := range b.calls {
				if ev.call.Pos() < firstStatus && b.inItem("ret_"+itoa(ev.k)) != nil {
					ls.add("in/ret_"+itoa(ev.k), "out/status", false)
				}
			}
		}
	}
	b.Links = ls.list
}

// walkReturns: 関数の本体の return（クロージャの中は除く）
func walkReturns(body *ast.BlockStmt, visit func(*ast.ReturnStmt)) {
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.FuncLit:
			return false
		case *ast.ReturnStmt:
			visit(x)
		}
		return true
	})
}

// reassigned: 同じ所（変数・フィールド）に 2 回以上代入するか（フィールドごとの代入 1 回ずつは代入し直しではない）
func reassigned(list []assign) bool {
	seen := map[string]bool{}
	whole := false
	for _, as := range list {
		if as.sub == "" {
			if whole || len(seen) > 0 {
				return true
			}
			whole = true
		} else if whole {
			return true
		}
		for k := range seen {
			if k == as.sub || strings.HasPrefix(k, as.sub+".") || strings.HasPrefix(as.sub, k+".") {
				return true
			}
		}
		seen[as.sub] = true
	}
	return false
}
