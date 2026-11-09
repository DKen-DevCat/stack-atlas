package main

// HTTP のレシピ（docs/17 §3.3「レシピ」・§7 #2・#11）。型（go/types）で判定するもの:
//   - net/http: `mux.HandleFunc("GET /x", h)` / `Handle` / `http.HandleFunc` → 箱 h の meta.route（method の無いパターンは ANY）
//   - `r.URL.Query().Get("k")`（url.Values.Get）→ in/query.k、`r.PathValue("k")` → in/path.k、`r.FormValue("k")` → in/query.k
//   - `json.NewDecoder(r.Body).Decode(&v)` → in/body（v の型で展開）
//   - `json.NewEncoder(w).Encode(x)` → out/<変数名>（式なら out/response。map のリテラルはキーと値の式の型で展開）
//   - `w.WriteHeader(n)` → out/status
//   - 認証の middleware（Authorization を見て 401 を返す関数）で mux 全体を包む → その mux の全部のルートに meta.auth = "login"
//   - 接頭辞: `mux.Handle("/api/", http.StripPrefix("/api", sub))` の sub、chi の `r.Mount("/api", sub)`（sub は変数か、
//     ルーターを返す関数の呼び出し）、Group / Route。接頭辞はルーターの親子で持ち、全部を読んでから付ける（登録の順に
//     よらない）。定数でない接頭辞・決められないルーターは警告（2026-11-09 8-2b レビュー C8）
// chi / echo / gin / fiber は外部のモジュールなので型が無い。AST と import パスでルートの登録（とリクエストの struct・
// JSON の応答）だけを読む。gorilla/mux の PathPrefix は読まない。

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"regexp"
	"strings"
)

// 正規表現はパッケージで 1 回だけ作る（呼び出しごとに作らない。8-2b レビュー C10）
var (
	versionSeg  = regexp.MustCompile(`^v\d+$`)
	routeMethod = regexp.MustCompile(`^(` + methodWords + `|ANY|ALL)$`)
)

var frameworkPaths = []struct{ prefix, name string }{
	{"github.com/go-chi/chi", "chi"},
	{"github.com/labstack/echo", "echo"},
	{"github.com/gin-gonic/gin", "gin"},
	{"github.com/gofiber/fiber", "fiber"},
}

func frameworkOf(path string) string {
	for _, f := range frameworkPaths {
		if path == f.prefix || strings.HasPrefix(path, f.prefix+"/") {
			return f.name
		}
	}
	return ""
}

// frameworks: ファイルの import の名前 → フレームワーク
func frameworks(f *ast.File) map[string]string {
	out := map[string]string{}
	if f == nil {
		return out
	}
	for _, s := range f.Imports {
		path := strings.Trim(s.Path.Value, "\"`")
		fw := frameworkOf(path)
		if fw == "" {
			continue
		}
		name := ""
		if s.Name != nil {
			name = s.Name.Name
		} else {
			parts := strings.Split(path, "/")
			name = parts[len(parts)-1]
			if versionSeg.MatchString(name) && len(parts) > 1 {
				name = parts[len(parts)-2]
			}
		}
		out[name] = fw
	}
	return out
}

// fwParamObjs: 引数のうち、型が `*gin.Context` / `echo.Context` / `*fiber.Ctx` のもの
func (a *analyzer) fwParamObjs(f *ast.File, info *types.Info, ft *ast.FuncType) map[*types.Var]string {
	out := map[*types.Var]string{}
	fws := frameworks(f)
	if len(fws) == 0 || ft == nil || ft.Params == nil {
		return out
	}
	for _, field := range ft.Params.List {
		t := field.Type
		if st, ok := t.(*ast.StarExpr); ok {
			t = st.X
		}
		sel, ok := t.(*ast.SelectorExpr)
		if !ok {
			continue
		}
		pk, ok := sel.X.(*ast.Ident)
		if !ok {
			continue
		}
		fw := fws[pk.Name]
		if fw == "" || (sel.Sel.Name != "Context" && sel.Sel.Name != "Ctx") {
			continue
		}
		for _, n := range field.Names {
			if v, ok := info.Defs[n].(*types.Var); ok {
				out[v] = fw
			}
		}
	}
	return out
}

var methodWords = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE"
var servePattern = regexp.MustCompile(`^(?:(` + methodWords + `)\s+)?([^/\s]*)(/\S*)$`)

// parsePattern: `"GET /x"` / `"/x"` / `"GET example.com/x"`（Go 1.22 の ServeMux）→ method と path
func parsePattern(p string) (string, string, bool) {
	m := servePattern.FindStringSubmatch(strings.TrimSpace(p))
	if m == nil {
		return "", "", false
	}
	method := m[1]
	if method == "" {
		method = "ANY"
	}
	return method, m[3], true
}

var colonParam = regexp.MustCompile(`/:(\w+)`)
var starRest = regexp.MustCompile(`/\*(\w*)$`)

// frameworkPath: `:id` → `{id}`、末尾の `*rest` → `{rest...}`（go の抽出器と同じ）
func frameworkPath(p string) string {
	p = colonParam.ReplaceAllString(p, "/{$1}")
	return starRest.ReplaceAllStringFunc(p, func(s string) string {
		name := strings.TrimPrefix(s, "/*")
		if name == "" {
			name = "rest"
		}
		return "/{" + name + "...}"
	})
}

func joinPath(prefix, p string) string {
	if prefix == "" {
		return p
	}
	return strings.TrimRight(prefix, "/") + "/" + strings.TrimLeft(p, "/")
}

// identObj: 式の根の識別子の変数
func identObj(info *types.Info, e ast.Expr) types.Object {
	for {
		switch x := e.(type) {
		case *ast.ParenExpr:
			e = x.X
			continue
		case *ast.StarExpr:
			e = x.X
			continue
		case *ast.UnaryExpr:
			e = x.X
			continue
		case *ast.Ident:
			if o := info.Uses[x]; o != nil {
				return o
			}
			return info.Defs[x]
		}
		return nil
	}
}

// resolveHandler: ルートに渡した式 → handler の箱と、それを包む関数（middleware）の箱
func (a *analyzer) resolveHandler(b *Box, e ast.Expr, depth int) (*Box, []*Box) {
	if depth > 4 || e == nil {
		return nil, nil
	}
	info := b.info
	e = unparen(e)
	if h := a.funcRef(info, e); h != nil {
		return h, nil
	}
	switch x := e.(type) {
	case *ast.CallExpr:
		if tv, ok := info.Types[x.Fun]; ok && tv.IsType() && len(x.Args) == 1 {
			return a.resolveHandler(b, x.Args[0], depth+1) // http.HandlerFunc(f)
		}
		mw := a.boxOfFunc(calleeFunc(info, x))
		for _, arg := range x.Args {
			if h, ws := a.resolveHandler(b, arg, depth+1); h != nil {
				if mw != nil {
					ws = append(ws, mw)
				}
				return h, ws
			}
		}
		return nil, nil
	}
	// ServeHTTP を持つ値（&T{}、T{}、変数）
	if tv, ok := info.Types[e]; ok && tv.Type != nil {
		obj, _, _ := types.LookupFieldOrMethod(tv.Type, true, b.pkg.Types, "ServeHTTP")
		if fn, ok := obj.(*types.Func); ok {
			if h := a.boxOfFunc(fn); h != nil {
				return h, nil
			}
		}
	}
	return nil, nil
}

// fromResponseWriter: `json.NewEncoder(w)` の w が http.ResponseWriter か（変数の encoder も）
func (a *analyzer) newCallArg(b *Box, e ast.Expr, ctor string) ast.Expr {
	info := b.info
	e = unparen(e)
	if id, ok := e.(*ast.Ident); ok {
		obj := info.Uses[id]
		for _, as := range b.assigns {
			if as.obj == obj && as.expr != nil && as.index < 0 {
				e = unparen(as.expr)
				break
			}
		}
	}
	call, ok := e.(*ast.CallExpr)
	if !ok || len(call.Args) != 1 || methodFull(info, call) != ctor {
		return nil
	}
	return call.Args[0]
}

func (a *analyzer) encoderToResponse(b *Box, recv ast.Expr) bool {
	w := a.newCallArg(b, recv, "encoding/json.NewEncoder")
	if w == nil {
		return false
	}
	tv, ok := b.info.Types[w]
	return ok && isResponseWriter(tv.Type)
}

func (a *analyzer) decoderFromRequest(b *Box, recv ast.Expr) bool {
	body := a.newCallArg(b, recv, "encoding/json.NewDecoder")
	sel, ok := unparen(body).(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Body" {
		return false
	}
	tv, ok := b.info.Types[sel.X]
	return ok && isRequestPtr(tv.Type)
}

// queryFromURL: url.Values の受け手が `.URL.Query()`（か、それで作った変数）か
func (a *analyzer) queryFromURL(b *Box, recv ast.Expr) bool {
	info := b.info
	e := unparen(recv)
	if id, ok := e.(*ast.Ident); ok {
		obj := info.Uses[id]
		for _, as := range b.assigns {
			if as.obj == obj && as.expr != nil {
				e = unparen(as.expr)
				break
			}
		}
	}
	call, ok := e.(*ast.CallExpr)
	return ok && methodFull(info, call) == "(*net/url.URL).Query"
}

// reqItem: handler の in のレシピの項目（path / query / body）。子は key
func (b *Box) reqChild(role, key string, form bool) string {
	parent := b.reqItems[role]
	if parent == nil {
		parent = &Item{ID: role, Name: role, Meta: map[string]any{"http": role}}
		switch role {
		case "path":
			parent.Type, parent.WireType = "string", "string"
		default:
			parent.Type, parent.WireType = "url.Values", "object"
		}
		b.reqItems[role] = parent
	}
	id := itemID(key)
	for _, c := range parent.Children {
		if c.ID == id {
			return role + "." + id
		}
	}
	child := &Item{ID: id, Name: key, Type: "string", WireType: "string"}
	if role == "query" {
		child.Optional = true // Query().Get は無ければ ""（受ける側は必須にしない）
	}
	if form {
		child.Meta = map[string]any{"form": true}
	}
	b.budget.take()
	parent.Children = append(parent.Children, child)
	return role + "." + id
}

// scanHTTP: 呼び出し 1 つの HTTP のレシピ。扱ったら true
func (a *analyzer) scanHTTP(b *Box, call *ast.CallExpr, fws map[string]string) bool {
	info := b.info
	full := methodFull(info, call)
	sel, _ := unparen(call.Fun).(*ast.SelectorExpr)
	switch full {
	case "(net/url.Values).Get":
		if sel != nil && len(call.Args) == 1 && (b.handler || a.queryFromURL(b, sel.X)) {
			if k, ok := a.constString(info, call.Args[0]); ok {
				b.recipes[call] = src{from: "in/" + b.reqChild("query", k, false), exact: true}
				return true
			}
		}
	case "(*net/http.Request).PathValue":
		if len(call.Args) == 1 {
			if k, ok := a.constString(info, call.Args[0]); ok {
				b.recipes[call] = src{from: "in/" + b.reqChild("path", k, false), exact: true}
				return true
			}
		}
	case "(*net/http.Request).FormValue", "(*net/http.Request).PostFormValue":
		if len(call.Args) == 1 {
			if k, ok := a.constString(info, call.Args[0]); ok {
				b.recipes[call] = src{from: "in/" + b.reqChild("query", k, true), exact: true}
				return true
			}
		}
	case "(*encoding/json.Decoder).Decode":
		if sel != nil && len(call.Args) == 1 && a.decoderFromRequest(b, sel.X) {
			a.bodyTarget(b, call.Args[0])
			return true
		}
	case "(*encoding/json.Encoder).Encode":
		if sel != nil && len(call.Args) == 1 && a.encoderToResponse(b, sel.X) {
			a.addEncode(b, call.Args[0], call.Pos())
			return true
		}
	case "(net/http.ResponseWriter).WriteHeader":
		if len(call.Args) == 1 {
			a.addStatus(b, call.Args[0])
			return true
		}
	}
	if sel == nil {
		return false
	}
	// chi.URLParam(r, "id")
	if pk, ok := sel.X.(*ast.Ident); ok && fwPkg(info, pk, fws) == "chi" && sel.Sel.Name == "URLParam" && len(call.Args) == 2 {
		if k, ok := a.constString(info, call.Args[1]); ok {
			b.recipes[call] = src{from: "in/" + b.reqChild("path", k, false), exact: true}
			return true
		}
	}
	// gin / echo / fiber の Context のメソッド
	obj := identObj(info, sel.X)
	fw := ""
	if v, ok := obj.(*types.Var); ok {
		fw = b.fwCtx[v]
		if fw == "" {
			fw = a.fwVar(b, v, fws)
		}
	}
	if fw == "" {
		return false
	}
	name := sel.Sel.Name
	key := func(i int) (string, bool) {
		if len(call.Args) <= i {
			return "", false
		}
		return a.constString(info, call.Args[i])
	}
	switch {
	case name == "Param" || name == "Params":
		if k, ok := key(0); ok {
			b.recipes[call] = src{from: "in/" + b.reqChild("path", k, false), exact: true}
			return true
		}
	case name == "Query" || name == "QueryParam" || name == "DefaultQuery" || name == "GetQuery":
		if k, ok := key(0); ok {
			b.recipes[call] = src{from: "in/" + b.reqChild("query", k, false), exact: true}
			return true
		}
	case name == "Bind" || name == "BindJSON" || name == "ShouldBind" || name == "ShouldBindJSON" || name == "BodyParser":
		if len(call.Args) == 1 {
			a.bodyTarget(b, call.Args[0])
			return true
		}
	case name == "JSON" || name == "IndentedJSON" || name == "PureJSON":
		if len(call.Args) == 2 {
			if isErrorStatus(info, call.Args[0]) {
				return true // エラーの応答は契約の応答にしない（http.Error と同じ）
			}
			a.addStatus(b, call.Args[0])
			a.addEncode(b, call.Args[1], call.Pos())
			return true
		}
		if len(call.Args) == 1 && fw == "fiber" {
			a.addEncode(b, call.Args[0], call.Pos())
			return true
		}
	case name == "Status" || name == "NoContent" || name == "AbortWithStatus" || name == "SendStatus":
		if len(call.Args) == 1 {
			a.addStatus(b, call.Args[0])
			return true
		}
	}
	return false
}

// fwVar: クロージャの引数（func(c *gin.Context) { … }）もフレームワークの Context として扱う
func (a *analyzer) fwVar(b *Box, v *types.Var, fws map[string]string) string {
	if len(fws) == 0 {
		return ""
	}
	found := ""
	ast.Inspect(b.decl, func(n ast.Node) bool {
		if found != "" {
			return false
		}
		fl, ok := n.(*ast.FuncLit)
		if !ok {
			return true
		}
		for obj, fw := range a.fwParamObjs(b.file, b.info, fl.Type) {
			if obj == v {
				found = fw
			}
		}
		return true
	})
	if found != "" {
		b.fwCtx[v] = found
	}
	return found
}

// bodyTarget: Decode(&v) / Bind(&v) の v ← in/body
func (a *analyzer) bodyTarget(b *Box, arg ast.Expr) {
	e := unparen(arg)
	addr := false
	if u, ok := e.(*ast.UnaryExpr); ok && u.Op == token.AND {
		e = u.X
		addr = true
	}
	obj, sub := a.lhsPath(b.info, e)
	if obj == nil {
		return
	}
	t := b.info.Types[e].Type
	if t != nil && !addr {
		t, _ = deref(t) // Decode(p)（p はポインタの変数）
	}
	if b.reqItems["body"] == nil {
		b.budget.take()
		it := a.ty.makeItem("body", "body", t, itemOpts{depth: a.opt.depth, budget: b.budget, here: b.pkg.Types})
		it.Meta = map[string]any{"http": "body"}
		b.reqItems["body"] = it
	}
	b.assigns = append(b.assigns, assign{obj: obj, sub: sub, fixed: []src{{from: "in/body", exact: true}}, index: -1})
}

// isErrorStatus: 400 以上の定数（エラーの応答。401 の middleware など）
func isErrorStatus(info *types.Info, e ast.Expr) bool {
	v, ok := constInt(info, e)
	return ok && v >= 400
}

// addStatus: WriteHeader(n) などの状態コード（エラーの応答は除く）
func (a *analyzer) addStatus(b *Box, e ast.Expr) {
	if isErrorStatus(b.info, e) {
		return
	}
	b.statuses = append(b.statuses, e)
}

// addEncode: Encode(x) の項目（変数なら名前、式なら response。nil は除く）
func (a *analyzer) addEncode(b *Box, x ast.Expr, pos token.Pos) {
	if id, ok := unparen(x).(*ast.Ident); ok && id.Name == "nil" {
		if _, isNil := b.info.Uses[id].(*types.Nil); isNil {
			return
		}
	}
	id := "response"
	if ident, ok := unparen(x).(*ast.Ident); ok {
		if _, isVar := b.info.Uses[ident].(*types.Var); isVar {
			id = ident.Name
		}
	}
	b.encodes = append(b.encodes, &encodeEvent{id: id, expr: x})
	_ = pos
}

// mapLiteralKeys: map のリテラル（文字列のキー）のキー → 値の式
func (a *analyzer) mapLiteralKeys(info *types.Info, e ast.Expr) (map[string]ast.Expr, []string) {
	cl, ok := unparen(e).(*ast.CompositeLit)
	if !ok {
		return nil, nil
	}
	tv, ok := info.Types[cl]
	if !ok || tv.Type == nil {
		return nil, nil
	}
	if _, isMap := tv.Type.Underlying().(*types.Map); !isMap {
		return nil, nil
	}
	keys := map[string]ast.Expr{}
	var order []string
	for _, el := range cl.Elts {
		kv, ok := el.(*ast.KeyValueExpr)
		if !ok {
			return nil, nil
		}
		k, ok := a.constString(info, kv.Key)
		if !ok {
			return nil, nil
		}
		if _, dup := keys[k]; !dup {
			order = append(order, k)
		}
		keys[k] = kv.Value
	}
	return keys, order
}

// isAuthMiddleware: Authorization を見て 401 を返す関数（クロージャの中も）
func (b *Box) isAuthMiddleware() bool { return b.authHdr && b.auth401 }

// resolveAuth: 認証の middleware で包んだ mux・ルーター・ルートに meta.auth
func (a *analyzer) resolveAuth() {
	authRouters := map[types.Object]*Box{}
	for _, w := range a.wraps {
		if w.mw.isAuthMiddleware() && w.arg != nil {
			authRouters[w.arg] = w.mw
		}
	}
	for obj, mws := range a.routerUse {
		for _, mw := range mws {
			if mw.isAuthMiddleware() {
				authRouters[obj] = mw
			}
		}
	}
	for _, r := range a.routes {
		var by *Box
		for _, w := range r.wrappers {
			if w.isAuthMiddleware() {
				by = w
			}
		}
		for o, i := r.router, 0; by == nil && i < 8; i++ {
			if mw, ok := authRouters[o]; ok {
				by = mw
				break
			}
			p, ok := a.routerParent[o]
			if !ok {
				break
			}
			o = p
		}
		if by != nil {
			r.handler.Meta["auth"] = "login"
			r.handler.Meta["authBy"] = map[string]any{"fn": by.ID, "header": "Authorization", "status": 401}
		}
	}
	// ルート（meta.route。複数あれば meta.routes にも）
	for _, r := range a.routes {
		rt := map[string]any{"method": r.method, "path": r.path}
		if r.framework != "net/http" {
			rt["framework"] = r.framework
		}
		if _, ok := r.handler.Meta["route"]; !ok {
			r.handler.Meta["route"] = rt
		}
		list, _ := r.handler.Meta["routes"].([]any)
		r.handler.Meta["routes"] = append(list, rt)
	}
	for _, b := range a.boxes {
		if list, _ := b.Meta["routes"].([]any); len(list) < 2 {
			delete(b.Meta, "routes")
		}
	}
}

// scanRoute: ルートの登録（net/http は型で、フレームワークは AST で）。扱ったら true
func (a *analyzer) scanRoute(b *Box, call *ast.CallExpr, fws map[string]string) bool {
	info := b.info
	sel, _ := unparen(call.Fun).(*ast.SelectorExpr)
	full := methodFull(info, call)
	pos := a.l.fset.Position(call.Pos())
	add := func(method, path, fw string, h ast.Expr, router types.Object) bool {
		hb, ws := a.resolveHandler(b, h, 0)
		if hb == nil {
			return false
		}
		a.routes = append(a.routes, &routeReg{
			method: method, raw: path, fw: fw != "net/http", framework: fw, handler: hb, router: router, wrappers: ws,
			file: a.l.rel(pos.Filename), line: pos.Line,
		})
		return true
	}
	where := fmt.Sprintf("%s:%d", a.l.rel(pos.Filename), pos.Line)
	switch full {
	case "(*net/http.ServeMux).HandleFunc", "(*net/http.ServeMux).Handle", "net/http.HandleFunc", "net/http.Handle":
		if len(call.Args) != 2 {
			return false
		}
		pat, ok := a.constString(info, call.Args[0])
		if !ok {
			return false
		}
		method, path, ok := parsePattern(pat)
		if !ok {
			return false
		}
		var router types.Object
		if sel != nil && strings.HasPrefix(full, "(") {
			router = identObj(info, sel.X)
		}
		if add(method, path, "net/http", call.Args[1], router) {
			return true
		}
		// handler でなければ、サブの mux（`http.StripPrefix("/api", sub)` か mux そのもの）
		return a.mountHTTP(b, call.Args[1], router, where)
	}
	if sel == nil || len(fws) == 0 {
		return false
	}
	// フレームワーク（受け手は外部の型なので AST で）
	if pk, ok := sel.X.(*ast.Ident); ok {
		if _, isPkg := info.Uses[pk].(*types.PkgName); isPkg || fwPkg(info, pk, fws) != "" {
			return false
		}
	}
	router := identObj(info, sel.X)
	fw := a.routerFw[router]
	if fw == "" {
		for _, v := range fws {
			fw = v
			break
		}
		if len(fws) > 1 {
			fw = "router"
		}
	}
	name := sel.Sel.Name
	upper := strings.ToUpper(name)
	str := func(i int) (string, bool) {
		if len(call.Args) <= i {
			return "", false
		}
		return a.constString(info, call.Args[i])
	}
	switch {
	case name == "Group" || name == "Route":
		return false // 接頭辞は代入（scanAssign）とクロージャの引数で読む
	case name == "Mount" && len(call.Args) == 2:
		// chi / fiber: `r.Mount("/api", sub)`。sub はルーターの変数か、ルーターを返す関数の呼び出し。handler なら
		// その下の全部（`/api/*`）
		p, ok := str(0)
		if !ok {
			a.warn(fmt.Sprintf("go-types: %s の Mount の接頭辞が定数でないので、そのルートに接頭辞を付けられません", where))
		}
		if add("ANY", joinPath(p, "/*"), fw, call.Args[1], router) {
			return true
		}
		subs := a.routerVars(b, call.Args[1], 0)
		if len(subs) == 0 {
			a.warn(fmt.Sprintf("go-types: %s の Mount したルーターを決められないので、その中のルートに接頭辞 %s を付けられません", where, p))
			return true
		}
		for _, sub := range subs {
			a.mount(sub, router, p)
		}
		return true
	case name == "Use":
		for _, arg := range call.Args {
			if mw := a.funcRef(info, arg); mw != nil {
				a.routerUse[router] = append(a.routerUse[router], mw)
			} else if c, ok := unparen(arg).(*ast.CallExpr); ok {
				if mw := a.boxOfFunc(calleeFunc(info, c)); mw != nil {
					a.routerUse[router] = append(a.routerUse[router], mw)
				}
			}
		}
		return true
	case routeMethod.MatchString(upper):
		p, ok := str(0)
		if !ok || !strings.HasPrefix(p, "/") || len(call.Args) < 2 {
			return false
		}
		method := upper
		if method == "ALL" {
			method = "ANY"
		}
		path := p
		// handler: echo は 2 番目（後ろは middleware）、gin / fiber は最後、それ以外（chi・混在）は 2 番目か最後
		switch fw {
		case "echo":
			return add(method, path, fw, call.Args[1], router)
		case "gin", "fiber":
			return add(method, path, fw, call.Args[len(call.Args)-1], router)
		}
		return add(method, path, fw, call.Args[1], router) || add(method, path, fw, call.Args[len(call.Args)-1], router)
	case name == "Handle" || name == "HandleFunc" || name == "Method" || name == "MethodFunc" || name == "Add":
		if m, ok := str(0); ok && !strings.HasPrefix(m, "/") && len(call.Args) >= 3 {
			p, ok := str(1)
			if !ok {
				return false
			}
			h := call.Args[2]
			if fw == "gin" {
				h = call.Args[len(call.Args)-1]
			}
			return add(strings.ToUpper(m), p, fw, h, router)
		}
		if p, ok := str(0); ok && strings.HasPrefix(p, "/") && len(call.Args) >= 2 {
			return add("ANY", p, fw, call.Args[1], router)
		}
	}
	return false
}

// scanRouterAssign: `g := e.Group("/api")`（echo / gin / fiber）→ g の接頭辞
func (a *analyzer) scanRouterAssign(b *Box, lhs types.Object, rhs ast.Expr, fws map[string]string) {
	if lhs == nil || len(fws) == 0 {
		return
	}
	a.scanRouterCtor(b, lhs, rhs, fws)
	call, ok := unparen(rhs).(*ast.CallExpr)
	if !ok {
		return
	}
	sel, ok := unparen(call.Fun).(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Group" || len(call.Args) == 0 {
		return
	}
	p, ok := a.constString(b.info, call.Args[0])
	if !ok {
		pos := a.l.fset.Position(call.Pos())
		a.warn(fmt.Sprintf("go-types: %s:%d の Group の接頭辞が定数でないので、そのルートに接頭辞を付けられません", a.l.rel(pos.Filename), pos.Line))
	}
	parent := identObj(b.info, sel.X)
	a.routerParent[lhs] = parent
	a.routerPrefix[lhs] = p
	if fw := a.routerFw[parent]; fw != "" {
		a.routerFw[lhs] = fw
	}
}

// fwPkg: 識別子がフレームワークの import の名前なら、そのフレームワーク（解けない import は Uses に PkgName が無い）
func fwPkg(info *types.Info, id *ast.Ident, fws map[string]string) string {
	fw := fws[id.Name]
	if fw == "" {
		return ""
	}
	switch info.Uses[id].(type) {
	case nil, *types.PkgName:
		return fw
	}
	return ""
}

// scanRouterCtor: `r := gin.Default()` / `e := echo.New()` / `c := chi.NewRouter()` → r のフレームワーク
func (a *analyzer) scanRouterCtor(b *Box, lhs types.Object, rhs ast.Expr, fws map[string]string) {
	call, ok := unparen(rhs).(*ast.CallExpr)
	if !ok || lhs == nil {
		return
	}
	sel, ok := unparen(call.Fun).(*ast.SelectorExpr)
	if !ok {
		return
	}
	if pk, ok := sel.X.(*ast.Ident); ok {
		if fw := fwPkg(b.info, pk, fws); fw != "" {
			a.routerFw[lhs] = fw
		}
	}
}

// scanChiRoute: `r.Route("/api", func(r chi.Router) { … })` / `r.Group(func(r chi.Router) { … })` → 引数 r の接頭辞
func (a *analyzer) scanChiRoute(b *Box, call *ast.CallExpr, fws map[string]string) {
	sel, ok := unparen(call.Fun).(*ast.SelectorExpr)
	if !ok || len(call.Args) == 0 {
		return
	}
	hasChi := false
	for _, fw := range fws {
		if fw == "chi" {
			hasChi = true
		}
	}
	if !hasChi {
		return
	}
	parent := identObj(b.info, sel.X)
	prefix := ""
	var fl *ast.FuncLit
	switch sel.Sel.Name {
	case "Route":
		if len(call.Args) != 2 {
			return
		}
		p, ok := a.constString(b.info, call.Args[0])
		if !ok {
			pos := a.l.fset.Position(call.Pos())
			a.warn(fmt.Sprintf("go-types: %s:%d の Route の接頭辞が定数でないので、そのルートに接頭辞を付けられません", a.l.rel(pos.Filename), pos.Line))
		}
		prefix = p
		fl, _ = call.Args[1].(*ast.FuncLit)
	case "Group":
		fl, _ = call.Args[0].(*ast.FuncLit)
	default:
		return
	}
	if fl == nil || fl.Type.Params == nil || len(fl.Type.Params.List) == 0 || len(fl.Type.Params.List[0].Names) == 0 {
		return
	}
	obj := b.info.Defs[fl.Type.Params.List[0].Names[0]]
	if obj == nil {
		return
	}
	a.routerParent[obj] = parent
	a.routerPrefix[obj] = prefix
	a.routerFw[obj] = "chi"
}

// mount: サブのルーター sub を parent の下の接頭辞 prefix に置く（先に置いたものを残す）
func (a *analyzer) mount(sub, parent types.Object, prefix string) {
	if sub == nil || sub == parent {
		return
	}
	if _, done := a.routerParent[sub]; done {
		return
	}
	a.routerParent[sub] = parent
	a.routerPrefix[sub] = prefix
}

// routerVars: ルーターを指す式 → ルーターの変数。変数そのもの、ルーターを返す（モジュールの中の）関数の呼び出し
// （その関数の return の変数）、それを包む呼び出し（middleware）の引数
func (a *analyzer) routerVars(b *Box, e ast.Expr, depth int) []types.Object {
	if depth > 3 || e == nil {
		return nil
	}
	switch x := unparen(e).(type) {
	case *ast.Ident:
		if o := identObj(b.info, x); o != nil {
			if _, isVar := o.(*types.Var); isVar {
				return []types.Object{o}
			}
		}
	case *ast.UnaryExpr:
		return a.routerVars(b, x.X, depth+1)
	case *ast.CallExpr:
		if callee := a.boxOfFunc(calleeFunc(b.info, x)); callee != nil && callee != b {
			var out []types.Object
			walkReturns(callee.decl.Body, func(r *ast.ReturnStmt) {
				if len(r.Results) == 1 {
					out = append(out, a.routerVars(callee, r.Results[0], depth+1)...)
				}
			})
			if len(out) > 0 {
				return out
			}
		}
		for _, arg := range x.Args {
			if out := a.routerVars(b, arg, depth+1); len(out) > 0 {
				return out
			}
		}
	}
	return nil
}

// mountHTTP: net/http の Handle に渡したものが handler でないとき。`http.StripPrefix("/api", sub)` は sub の
// ルートに接頭辞 /api、mux そのもの（`mux.Handle("/api/", sub)`）は接頭辞無しで親子にする（認証の middleware を
// 受け継ぐ）。扱ったら true
func (a *analyzer) mountHTTP(b *Box, e ast.Expr, router types.Object, where string) bool {
	info := b.info
	prefix := ""
	inner := unparen(e)
	if call, ok := inner.(*ast.CallExpr); ok && methodFull(info, call) == "net/http.StripPrefix" && len(call.Args) == 2 {
		p, ok := a.constString(info, call.Args[0])
		if !ok {
			a.warn(fmt.Sprintf("go-types: %s の StripPrefix の接頭辞が定数でないので、その中のルートに接頭辞を付けられません", where))
		}
		prefix = p
		inner = unparen(call.Args[1])
	} else if !a.isMux(info, inner) {
		return false
	}
	subs := a.routerVars(b, inner, 0)
	var muxes []types.Object
	for _, o := range subs {
		if a.isMuxObj(o) {
			muxes = append(muxes, o)
		}
	}
	if len(muxes) == 0 {
		if prefix != "" {
			a.warn(fmt.Sprintf("go-types: %s の StripPrefix の中の mux を決められないので、その中のルートに接頭辞 %s を付けられません", where, prefix))
		}
		return false
	}
	for _, o := range muxes {
		a.mount(o, router, prefix)
	}
	return true
}

// isMux / isMuxObj: *http.ServeMux か、フレームワークのルーターの変数
func (a *analyzer) isMux(info *types.Info, e ast.Expr) bool {
	tv, ok := info.Types[e]
	if ok && tv.Type != nil {
		if t, _ := deref(tv.Type); isNamed(t, "net/http", "ServeMux") {
			return true
		}
	}
	if o := identObj(info, e); o != nil {
		return a.routerFw[o] != ""
	}
	return false
}

func (a *analyzer) isMuxObj(o types.Object) bool {
	if a.routerFw[o] != "" {
		return true
	}
	if v, ok := o.(*types.Var); ok {
		t, _ := deref(v.Type())
		return isNamed(t, "net/http", "ServeMux")
	}
	return false
}

// fullPrefix: ルーターの接頭辞（親を辿って連ねる。循環と深さに上限）
func (a *analyzer) fullPrefix(o types.Object) string {
	var segs []string
	seen := map[types.Object]bool{}
	for i := 0; o != nil && i < 16 && !seen[o]; i++ {
		seen[o] = true
		if p := a.routerPrefix[o]; p != "" {
			segs = append(segs, p)
		}
		next, ok := a.routerParent[o]
		if !ok {
			break
		}
		o = next
	}
	prefix := ""
	for i := len(segs) - 1; i >= 0; i-- {
		prefix = joinPath(prefix, segs[i])
	}
	return prefix
}

// finishRoutes: ルートのパス = ルーターの接頭辞 + 登録したパス（全部の関数を読んでから。Mount が後でも付く）
func (a *analyzer) finishRoutes() {
	for _, r := range a.routes {
		path := joinPath(a.fullPrefix(r.router), r.raw)
		if r.fw {
			path = frameworkPath(path)
		}
		r.path = path
	}
}
