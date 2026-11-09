package main

// 関数の本体を 1 回歩いて、呼び出し・レシピ・SQL・ルート・参照・代入（links の元）を集める（scan）。
// そのあと、レシピの項目（finishRecipes）、呼び出しの項目と線（buildCalls）、links（buildLinks）を作る。

import (
	"go/ast"
	"go/token"
	"go/types"
	"strings"
)

// walk: 親の並び付きの ast.Inspect
func walk(root ast.Node, visit func(n ast.Node, stack []ast.Node) bool) {
	var stack []ast.Node
	ast.Inspect(root, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return false
		}
		if !visit(n, stack) {
			return false
		}
		stack = append(stack, n)
		return true
	})
}

func parentOf(stack []ast.Node) ast.Node {
	if len(stack) == 0 {
		return nil
	}
	return stack[len(stack)-1]
}

func (a *analyzer) scan(b *Box) {
	info := b.info
	fws := frameworks(b.file)
	walk(b.decl.Body, func(n ast.Node, stack []ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			a.scanCall(b, x, fws)
		case *ast.AssignStmt:
			a.scanAssign(b, x, fws)
		case *ast.ValueSpec:
			for i, name := range x.Names {
				obj := info.Defs[name]
				if i < len(x.Values) && len(x.Names) == len(x.Values) {
					b.assigns = append(b.assigns, assign{obj: obj, expr: x.Values[i], index: -1})
					a.scanRouterAssign(b, obj, x.Values[i], fws)
				} else if len(x.Values) == 1 {
					b.assigns = append(b.assigns, assign{obj: obj, expr: x.Values[0], index: i})
				}
			}
		case *ast.ReturnStmt:
			a.scanReturn(b, x, stack)
		case *ast.RangeStmt:
			if x.Value != nil {
				if obj, sub := a.lhsPath(info, x.Value); obj != nil {
					b.assigns = append(b.assigns, assign{obj: obj, sub: sub, expr: x.X, index: -1})
				}
			}
		case *ast.TypeSwitchStmt:
			if as, ok := x.Assign.(*ast.AssignStmt); ok && len(as.Rhs) == 1 {
				if ta, ok := as.Rhs[0].(*ast.TypeAssertExpr); ok {
					for _, cl := range x.Body.List {
						if obj := info.Implicits[cl]; obj != nil {
							b.assigns = append(b.assigns, assign{obj: obj, expr: ta.X, index: -1})
						}
					}
				}
			}
		case *ast.SelectorExpr, *ast.Ident:
			e := x.(ast.Expr)
			// SQL・Authorization（定数の文字列。長すぎるものは読まない）
			if isConstString(info, e) {
				if s, ok := a.constString(info, e); ok {
					a.scanConst(b, e, s, stack)
				}
				return false
			}
			// 関数・メソッドの値の参照（呼び出しでない）
			if call, ok := parentOf(stack).(*ast.CallExpr); ok && unparen(call.Fun) == e {
				return true // 呼び出し（X の中は歩く。Sel は下の親の判定で飛ばす）
			}
			if sel, ok := parentOf(stack).(*ast.SelectorExpr); ok && sel.Sel == e {
				return true
			}
			if t := a.funcRef(info, e); t != nil && t != b {
				b.refs = append(b.refs, t)
			}
		case *ast.BasicLit, *ast.BinaryExpr:
			// 定数の文字列は 1 回だけ見る（中の `+` を見直さない）
			if isConstString(info, x.(ast.Expr)) {
				if s, ok := a.constString(info, x.(ast.Expr)); ok {
					a.scanConst(b, x.(ast.Expr), s, stack)
				}
				return false
			}
			if lit, ok := x.(*ast.BasicLit); ok && lit.Kind == token.STRING {
				if s, ok := a.constString(info, lit); ok {
					a.scanConst(b, lit, s, stack)
				}
				return false
			}
		}
		return true
	})
}

// scanConst: 定数の文字列。SQL なら sqlUse、`Authorization` なら認証の印
func (a *analyzer) scanConst(b *Box, e ast.Expr, s string, stack []ast.Node) {
	if len(s) < 32 && strings.EqualFold(strings.TrimSpace(s), "authorization") {
		b.authHdr = true
		return
	}
	st := a.sqlOf(b.info, e, s)
	if st == nil {
		return
	}
	u := &sqlUse{pos: int(e.Pos()), stmt: st}
	switch x := e.(type) {
	case *ast.Ident:
		u.name = x.Name
	case *ast.SelectorExpr:
		u.name = x.Sel.Name
	}
	// プレースホルダの値: 呼び出しの引数か、並び（代入の右辺・var の値）で SQL の後ろにある式
	switch p := parentOf(stack).(type) {
	case *ast.CallExpr:
		for i, arg := range p.Args {
			if arg == e {
				u.params, u.known = p.Args[i+1:], !p.Ellipsis.IsValid()
				break
			}
		}
	case *ast.AssignStmt:
		for i, r := range p.Rhs {
			if r == e {
				u.params, u.known = p.Rhs[i+1:], true
			}
		}
	case *ast.ValueSpec:
		for i, r := range p.Values {
			if r == e {
				u.params, u.known = p.Values[i+1:], true
			}
		}
	}
	b.sqls = append(b.sqls, u)
}

func (a *analyzer) scanAssign(b *Box, x *ast.AssignStmt, fws map[string]string) {
	info := b.info
	if len(x.Lhs) == len(x.Rhs) {
		for i, l := range x.Lhs {
			obj, sub := a.lhsPath(info, l)
			if obj == nil {
				continue
			}
			b.assigns = append(b.assigns, assign{obj: obj, sub: sub, expr: x.Rhs[i], index: -1})
			if sub == "" {
				a.scanRouterAssign(b, obj, x.Rhs[i], fws)
			}
		}
		return
	}
	if len(x.Rhs) != 1 {
		return
	}
	_, isCall := unparen(x.Rhs[0]).(*ast.CallExpr)
	for i, l := range x.Lhs {
		obj, sub := a.lhsPath(info, l)
		if obj == nil {
			continue
		}
		if isCall {
			b.assigns = append(b.assigns, assign{obj: obj, sub: sub, expr: x.Rhs[0], index: i})
		} else if i == 0 {
			b.assigns = append(b.assigns, assign{obj: obj, sub: sub, expr: x.Rhs[0], index: -1})
		}
	}
}

func (a *analyzer) scanCall(b *Box, call *ast.CallExpr, fws map[string]string) {
	info := b.info
	// 401（http.StatusUnauthorized など）を引数に渡す
	for _, arg := range call.Args {
		if v, ok := constInt(info, arg); ok && v == 401 {
			b.auth401 = true
		}
	}
	a.scanConversions(b, call)
	if a.scanRoute(b, call, fws) {
		return
	}
	a.scanChiRoute(b, call, fws)
	if a.scanHTTP(b, call, fws) {
		return
	}
	// rows.Scan(&a, &t.B)
	if sel, ok := unparen(call.Fun).(*ast.SelectorExpr); ok && sel.Sel.Name == "Scan" && len(call.Args) > 0 {
		all := true
		for _, arg := range call.Args {
			if u, ok := unparen(arg).(*ast.UnaryExpr); !ok || u.Op != token.AND {
				all = false
			}
		}
		if all {
			b.scans = append(b.scans, &scanEvent{pos: int(call.Pos()), dests: call.Args})
		}
	}
	// 箱の呼び出し
	callee := a.boxOfFunc(calleeFunc(info, call))
	if callee != nil && callee != b {
		ev := &callEvent{k: len(b.calls) + 1, call: call, callee: callee}
		b.calls = append(b.calls, ev)
		// middleware で包む（M(mux)）: 引数の変数（入れ子の呼び出しの中も）
		var visit func(e ast.Expr, depth int)
		visit = func(e ast.Expr, depth int) {
			if depth > 3 {
				return
			}
			switch y := unparen(e).(type) {
			case *ast.Ident:
				if o := identObj(info, y); o != nil {
					a.wraps = append(a.wraps, wrapCall{mw: callee, arg: o})
				}
			case *ast.CallExpr:
				for _, arg := range y.Args {
					visit(arg, depth+1)
				}
			}
		}
		for _, arg := range call.Args {
			visit(arg, 0)
		}
	}
}

// scanConversions: interface への変換（閉包: 標準ライブラリが呼ぶメソッド。ListenAndServe(addr, h) の h.ServeHTTP）
func (a *analyzer) scanConversions(b *Box, call *ast.CallExpr) {
	info := b.info
	if tv, ok := info.Types[call.Fun]; ok && !tv.IsType() {
		if sig, ok := tv.Type.Underlying().(*types.Signature); ok {
			ps := sig.Params()
			for i, arg := range call.Args {
				var pt types.Type
				switch {
				case i < ps.Len()-1 || (!sig.Variadic() && i < ps.Len()):
					pt = ps.At(i).Type()
				case sig.Variadic() && ps.Len() > 0:
					pt = ps.At(ps.Len() - 1).Type()
					if s, ok := pt.(*types.Slice); ok && !call.Ellipsis.IsValid() {
						pt = s.Elem()
					}
				}
				a.convert(b, arg, pt)
			}
		}
	}
}

// convert: 値を interface の型に渡す → その interface のメソッドの実装（モジュールの中）を閉包に足す
func (a *analyzer) convert(b *Box, e ast.Expr, to types.Type) {
	if to == nil || !types.IsInterface(to) {
		return
	}
	tv, ok := b.info.Types[e]
	if !ok || tv.Type == nil || types.IsInterface(tv.Type) {
		return
	}
	iface, ok := to.Underlying().(*types.Interface)
	if !ok {
		return
	}
	for i := 0; i < iface.NumMethods(); i++ {
		m := iface.Method(i)
		obj, _, _ := types.LookupFieldOrMethod(tv.Type, true, m.Pkg(), m.Name())
		if fn, ok := obj.(*types.Func); ok {
			if t := a.boxOfFunc(fn); t != nil && t != b {
				b.dyn = append(b.dyn, t)
			}
		}
	}
}

// --- レシピの項目 ---

func (a *analyzer) finishRecipes(b *Box) {
	here := b.pkg.Types
	// handler: レシピの項目（path / query / body）、無ければ r
	if b.handler {
		got := false
		for _, role := range []string{"path", "query", "body"} {
			if it := b.reqItems[role]; it != nil {
				b.addIn(it)
				got = true
			}
		}
		if !got && b.reqObj != nil {
			name := b.reqObj.Name()
			if name == "" || name == "_" {
				name = "r"
			}
			b.budget.take()
			it := &Item{ID: "r", Name: name, Type: typeString(b.reqObj.Type(), here), WireType: "unknown"}
			if _, ptr := deref(b.reqObj.Type()); ptr {
				it.Nullable = true
			}
			b.addIn(it)
		}
	}
	// Encode
	used := idSet{}
	for _, x := range b.out {
		used[x.ID] = 1
	}
	for _, ev := range b.encodes {
		ev.id = uniqueID(ev.id, used)
		t := b.info.Types[ev.expr].Type
		var keys map[string]ast.Expr
		var order []string
		keys, order = a.mapLiteralKeys(b.info, ev.expr)
		if keys == nil {
			if id, ok := unparen(ev.expr).(*ast.Ident); ok {
				obj := b.info.Uses[id]
				var defs []assign
				for _, as := range b.assigns {
					if as.obj == obj && as.sub == "" {
						defs = append(defs, as)
					}
				}
				if len(defs) == 1 && defs[0].expr != nil {
					keys, order = a.mapLiteralKeys(b.info, defs[0].expr)
				}
			}
		}
		name := ev.id
		if ev.id == "response" || strings.HasPrefix(ev.id, "response_") {
			name = "response"
		}
		b.budget.take()
		var it *Item
		if keys != nil {
			it = &Item{ID: ev.id, Name: name, Type: typeString(t, here), WireType: "object"}
			kused := idSet{}
			for _, k := range order {
				if !b.budget.take() {
					break
				}
				vt := b.info.Types[keys[k]].Type
				child := a.ty.makeItem(uniqueID(k, kused), k, vt, itemOpts{depth: a.opt.depth - 1, budget: b.budget, here: here})
				it.Children = append(it.Children, child)
			}
			ev.keys = keys
			ev.order = order
		} else {
			it = a.ty.makeItem(ev.id, name, t, itemOpts{depth: a.opt.depth, budget: b.budget, here: here})
		}
		it.Meta = map[string]any{"http": "response"}
		b.addOut(it, ev.expr.Pos())
	}
	// WriteHeader
	if len(b.statuses) > 0 {
		var texts []string
		seen := map[string]bool{}
		for _, e := range b.statuses {
			t := exprText(a.l.fset, b, e)
			if !seen[t] {
				seen[t] = true
				texts = append(texts, t)
			}
		}
		b.budget.take()
		b.addOut(&Item{ID: "status", Name: "status", Type: strings.Join(texts, " | "), WireType: "integer", Meta: map[string]any{"http": "status"}}, b.statuses[0].Pos())
	}
	// SQL
	var metas []any
	rows := 0
	for k, u := range b.sqls {
		st := u.stmt
		prefix := "query"
		switch st.op {
		case "insert":
			prefix = "insert"
		case "update":
			prefix = "update"
		}
		u.itemID = prefix + "_" + itoa(k+1)
		name := u.name
		if name == "" {
			name = "SQL"
		}
		b.budget.take()
		it := &Item{ID: u.itemID, Name: name, Type: st.display, WireType: "object"}
		cused := idSet{}
		if st.op == "insert" || st.op == "update" {
			for _, c := range st.write {
				if b.budget.take() {
					it.Children = append(it.Children, sqlColItem(uniqueID(c, cused), c, st.table, c, ""))
				}
			}
		} else {
			for _, w := range st.where {
				if b.budget.take() {
					it.Children = append(it.Children, sqlColItem(uniqueID(w.col, cused), w.col, w.table, w.col, w.cast))
				}
			}
		}
		m := st.meta(u.name, u.itemID)
		it.Meta = map[string]any{"sql": m}
		b.addOut(it, token.Pos(u.pos))
		if len(st.read) > 0 {
			rows++
			u.rowID = "row"
			if rows > 1 {
				u.rowID = "row_" + itoa(k+1)
			}
			rowSQL := map[string]any{"table": st.table, "query": u.itemID}
			if len(st.tables) > 1 {
				// JOIN した行: カラムごとのテーブル（typeRef）で、合流の照合はそのテーブルのカラムだけ（8-2b レビュー C2）
				rowSQL["tables"] = st.tables
			}
			row := &Item{ID: u.rowID, Name: strings.ToUpper(st.op) + " の 1 行", Type: "record", WireType: "object",
				Meta: map[string]any{"sql": rowSQL}}
			if st.op == "select" {
				row.Name = "SELECT の 1 行"
			} else {
				row.Name = "RETURNING の 1 行"
			}
			rused := idSet{}
			for _, c := range st.read {
				if c.star {
					// スキーマで広げられなかった `*`: 印と位置（TS の側がマイグレーションで広げる。Scan はここから先を
					// 位置で写さない。8-2b レビュー C5）
					if _, ok := rowSQL["star"]; !ok {
						rowSQL["star"] = true
						rowSQL["starAt"] = len(row.Children)
						if c.table != "" && c.table != st.table {
							rowSQL["starTable"] = c.table
						}
					}
					continue
				}
				if !b.budget.take() {
					break
				}
				ci := sqlColItem(uniqueID(c.id, rused), c.name, c.table, c.column, c.cast)
				if c.expr != "" {
					ci.Meta["_sql"].(map[string]any)["expr"] = c.expr
					if c.cast == "" && strings.HasPrefix(strings.ToLower(c.expr), "count(") {
						ci.Type, ci.WireType = "bigint", "integer"
					}
				}
				row.Children = append(row.Children, ci)
			}
			b.budget.take()
			b.addIn(row)
			m["row"] = u.rowID
		}
		metas = append(metas, m)
	}
	if len(metas) == 1 {
		b.Meta["sql"] = metas[0]
	} else if len(metas) > 1 {
		b.Meta["sql"] = metas
	}
	// Scan(&t.A, …) → SELECT の列の順に in/row.<列>
	for _, sc := range b.scans {
		var use *sqlUse
		for _, u := range b.sqls {
			if u.rowID == "" {
				continue
			}
			if u.pos < sc.pos || use == nil {
				use = u
			}
		}
		if use == nil {
			continue
		}
		row := b.inItem(use.rowID)
		if row == nil {
			continue
		}
		// 広げられなかった `*` から先は、引数の順とカラムの順が合わない: 行の全体から crude（8-2b レビュー C5）
		starAt := -1
		if m, ok := row.Meta["sql"].(map[string]any); ok {
			if at, ok := m["starAt"].(int); ok {
				starAt = at
			}
		}
		for i, d := range sc.dests {
			e := unparen(d).(*ast.UnaryExpr).X
			obj, sub := a.lhsPath(b.info, e)
			if obj == nil {
				continue
			}
			if starAt >= 0 && i >= starAt {
				b.assigns = append(b.assigns, assign{obj: obj, sub: sub, fixed: []src{{from: "in/" + use.rowID, exact: false}}, index: -1})
				continue
			}
			if i >= len(row.Children) {
				break
			}
			b.assigns = append(b.assigns, assign{obj: obj, sub: sub, fixed: []src{{from: "in/" + use.rowID + "." + row.Children[i].ID, exact: true}}, index: -1})
		}
	}
}

func exprText(fset *token.FileSet, b *Box, e ast.Expr) string {
	start := fset.Position(e.Pos())
	end := fset.Position(e.End())
	data := b.pkg.Src[start.Filename]
	if data != nil && end.Offset <= len(data) && start.Offset <= end.Offset {
		return compact(string(data[start.Offset:end.Offset]))
	}
	return "status"
}

// --- 呼び出し（call_n / ret_n）と線 ---

func (a *analyzer) buildCalls(b *Box) {
	here := b.pkg.Types
	info := b.info
	for _, ev := range b.calls {
		callee := ev.callee
		used := idSet{}
		for _, p := range callee.params {
			if p.index >= len(ev.call.Args) {
				continue
			}
			arg := ev.call.Args[p.index]
			t := info.Types[arg].Type
			id := uniqueID(p.id, used)
			b.budget.take()
			ev.slots = append(ev.slots, slot{
				id: id, arg: arg, target: p.id,
				item: a.ty.makeItem(id, p.obj.Name(), t, itemOpts{depth: a.opt.depth, budget: b.budget, here: here}),
			})
		}
		// 受け手が handler の r（項目 in/r）なら、r の実引数も渡す
		if callee.reqObj != nil && callee.inItem("r") != nil {
			sig := callee.sig
			for i := 0; i < sig.Params().Len() && i < len(ev.call.Args); i++ {
				if sig.Params().At(i) == callee.reqObj {
					arg := ev.call.Args[i]
					b.budget.take()
					ev.slots = append(ev.slots, slot{id: uniqueID("r", used), arg: arg, target: "r",
						item: &Item{ID: "r", Name: callee.reqObj.Name(), Type: typeString(info.Types[arg].Type, here), WireType: "unknown"}})
				}
			}
		}
		res := a.resultItem(callee.sig, here, b.budget, "ret_"+itoa(ev.k), callee.Name+"() の戻り")
		ci := &Item{ID: "call_" + itoa(ev.k), Name: callee.Name + "()", Type: "void"}
		if res != nil {
			ci.Type = res.Type
			ci.WireType = res.WireType
		}
		for _, s := range ev.slots {
			ci.Children = append(ci.Children, s.item)
		}
		b.addOut(ci, ev.call.Pos())
		if res != nil {
			b.addIn(res)
		}
		wired := false
		for _, s := range ev.slots {
			r := callee.inItem(s.target)
			if r == nil {
				continue
			}
			a.wireBetween(b.ID+"#out/"+ci.ID+"."+s.id, s.item, callee.ID+"#in/"+r.ID, r)
			wired = true
		}
		if !wired {
			callee.addIn(callItem())
			a.addWire(Wire{From: b.ID + "#out/" + ci.ID, To: callee.ID + "#in/call", Via: "call"})
		}
		if res != nil && callee.outItem("return") != nil {
			a.addWire(Wire{From: callee.ID + "#out/return", To: b.ID + "#in/" + res.ID, Via: "return", Reply: true})
		}
	}
	if b.budget.truncated || countItems(b.in)+countItems(b.out) > a.opt.maxItems {
		b.Truncated = true
	}
}

// mapsAll: 受ける側の子が送る側の子に名前で全部写るか（子を再帰。子の無い側は写るとみなす。D41）
func mapsAll(s, r *Item) bool {
	if len(s.Children) == 0 || len(r.Children) == 0 {
		return true
	}
	for _, rc := range r.Children {
		var sc *Item
		for _, x := range s.Children {
			if x.ID == rc.ID {
				sc = x
			}
		}
		if sc == nil || !mapsAll(sc, rc) {
			return false
		}
	}
	return true
}

func (a *analyzer) wireBetween(sRef string, s *Item, rRef string, r *Item) {
	if mapsAll(s, r) {
		a.addWire(Wire{From: sRef, To: rRef, Via: "call"})
		return
	}
	for _, rc := range r.Children {
		for _, sc := range s.Children {
			if sc.ID == rc.ID {
				a.wireBetween(sRef+"."+sc.ID, sc, rRef+"."+rc.ID, rc)
			}
		}
	}
}

// scanReturn: return で interface の戻り値に渡す値（閉包）
func (a *analyzer) scanReturn(b *Box, r *ast.ReturnStmt, stack []ast.Node) {
	sig := b.sig
	for i := len(stack) - 1; i >= 0; i-- {
		if fl, ok := stack[i].(*ast.FuncLit); ok {
			s, _ := b.info.Types[fl].Type.(*types.Signature)
			sig = s
			break
		}
	}
	if sig == nil || len(r.Results) != sig.Results().Len() {
		return
	}
	for i, e := range r.Results {
		a.convert(b, e, sig.Results().At(i).Type())
	}
}
