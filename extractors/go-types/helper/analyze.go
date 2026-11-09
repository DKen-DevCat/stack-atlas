package main

// 箱・口・項目・線（docs/17 §3.3・§7 #2、docs/16 §5）。
//
// 箱: モジュールの中の関数とメソッド（本体のあるもの。init と _ を除く）。id は `fn:<パッケージ相対パス>.<名前>`、
// 同じパッケージで名前が衝突したメソッドだけ `.<型>.<名前>`。`cmd/*`（と -entry）の main は入口（meta.entry）。
//
// 口と項目:
//   - in: 引数（context.Context と http.ResponseWriter は項目にしない。レシーバも項目にしない）。引数の無い関数は `call`。
//     handler（`*http.Request` を受ける）は、レシピの項目（query / path / body）が無ければ `r` を残す。呼び出しの戻りは
//     `ret_<n>`、SELECT の結果は `row`
//   - out: 呼び出しは `call_<n>`（子は呼び先の引数名）、Encode は `out/<変数名>`（式なら `out/response`）、
//     WriteHeader は `out/status`、SQL は `query_<n>` / `insert_<n>` / `update_<n>`、値の戻りは `return`（error は項目に
//     しない。error だけを返すなら `return` は type error・nullable）。番号は出現位置の順
//
// 線（同じ言語の中。D49）: `call_n.<引数> → 呼び先#in/<引数>`（call）、`呼び先#out/return → ret_n`（return、reply）。
// 最も粗い単位で引く（D41）。言語をまたぐ線（HTTP・SQL）は引かない（core の join が meta.route / meta.sql から引く）

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"path/filepath"
	"sort"
	"strings"
)

type options struct {
	depth    int
	maxItems int
	entries  []string
}

// Port は v2 の口
type Port struct {
	ID    string  `json:"id"`
	Dir   string  `json:"dir"`
	Items []*Item `json:"items"`
}

// Link は箱の中の対応
type Link struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Confidence string `json:"confidence,omitempty"`
}

// Wire は同じ言語の中の線
type Wire struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Via   string `json:"via"`
	Reply bool   `json:"reply,omitempty"`
}

// Route は HTTP のルートの登録
type Route struct {
	Method    string `json:"method"`
	Path      string `json:"path"`
	Handler   string `json:"handler"`
	Framework string `json:"framework"`
	File      string `json:"file"`
	Line      int    `json:"line"`
	Auth      string `json:"auth,omitempty"`
}

// Box は関数の単位の箱
type Box struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	File      string         `json:"file"`
	Line      int            `json:"line"`
	Code      string         `json:"code,omitempty"`
	Pkg       string         `json:"pkg"`
	PkgName   string         `json:"pkgName"`
	Func      string         `json:"func"`
	Recv      string         `json:"recv,omitempty"`
	Entry     string         `json:"entry,omitempty"`
	Ports     []Port         `json:"ports"`
	Links     []Link         `json:"links,omitempty"`
	Meta      map[string]any `json:"meta,omitempty"`
	Reach     []string       `json:"reach,omitempty"`
	Truncated bool           `json:"truncated,omitempty"`

	fn      *types.Func
	decl    *ast.FuncDecl
	file    *ast.File
	pkg     *Pkg
	info    *types.Info
	sig     *types.Signature
	in      []*Item
	out     []*Item
	inIDs   map[string]bool
	outIDs  map[string]bool
	outPos  map[string]token.Pos
	budget  *budget
	params  []paramItem
	results []int // 値の戻り（error を除く）の添字
	errRet  bool
	reqObj  types.Object

	calls    []*callEvent
	recipes  map[ast.Expr]src
	assigns  []assign
	encodes  []*encodeEvent
	statuses []ast.Expr
	sqls     []*sqlUse
	scans    []*scanEvent
	reqItems map[string]*Item
	refs     []*Box
	dyn      []*Box
	handler  bool
	authHdr  bool
	auth401  bool
	fwCtx    map[types.Object]string
}

type paramItem struct {
	index int
	obj   *types.Var
	id    string
}

type callEvent struct {
	k      int
	call   *ast.CallExpr
	callee *Box
	slots  []slot
}

type slot struct {
	id     string
	item   *Item
	arg    ast.Expr
	target string
}

type encodeEvent struct {
	id   string
	expr ast.Expr
	// map のリテラルのキーと値（Encode する変数がリテラルで作られたものも）。order はキーの順
	keys  map[string]ast.Expr
	order []string
}

// src: links の元（in の項目のパス）と、行き先の中の相対パス（struct のフィールドごとの代入）
type src struct {
	from  string
	exact bool
	sub   string
}

type assign struct {
	obj   types.Object
	sub   string
	expr  ast.Expr
	fixed []src
	// 多値の右辺の何番目か（-1 は単一）
	index int
}

// Stats は数
type Stats struct {
	Packages   int   `json:"packages"`
	Files      int   `json:"files"`
	StdPkgs    int   `json:"stdPackages"`
	TypeErrors int   `json:"typeErrors"`
	LoadMs     int64 `json:"loadMs"`
	TotalMs    int64 `json:"totalMs"`
}

// Output は helper の出力
type Output struct {
	Module    string      `json:"module"`
	GoVersion string      `json:"goVersion,omitempty"`
	Boxes     []*Box      `json:"boxes"`
	Wires     []Wire      `json:"wires"`
	Types     []NamedType `json:"types"`
	Routes    []Route     `json:"routes"`
	Warnings  []Warning   `json:"warnings"`
	Stats     Stats       `json:"stats"`
}

type analyzer struct {
	l       *loader
	opt     options
	ty      *typer
	boxes   []*Box
	byFunc  map[*types.Func]*Box
	byID    map[string]*Box
	kindOf  map[string]string
	named   map[string]NamedType
	namedBy map[*types.Named]string
	wires   []Wire
	wireSet map[string]bool
	routes  []*routeReg
	// net/http の mux とフレームワークのルーター（変数 → 親・接頭辞・Use したもの）
	routerParent map[types.Object]types.Object
	routerPrefix map[types.Object]string
	routerUse    map[types.Object][]*Box
	routerFw     map[types.Object]string
	wraps        []wrapCall
	warnings     []Warning
}

type routeReg struct {
	method, path, framework string
	handler                 *Box
	router                  types.Object
	wrappers                []*Box
	file                    string
	line                    int
}

type wrapCall struct {
	mw  *Box
	arg types.Object
}

func newAnalyzer(l *loader, opt options) *analyzer {
	a := &analyzer{
		l: l, opt: opt,
		byFunc:       map[*types.Func]*Box{},
		byID:         map[string]*Box{},
		kindOf:       map[string]string{},
		named:        map[string]NamedType{},
		namedBy:      map[*types.Named]string{},
		wireSet:      map[string]bool{},
		routerParent: map[types.Object]types.Object{},
		routerPrefix: map[types.Object]string{},
		routerUse:    map[types.Object][]*Box{},
		routerFw:     map[types.Object]string{},
	}
	a.ty = &typer{a: a, depth: opt.depth}
	for _, p := range l.pkgs {
		a.kindOf[p.Path] = p.Kind
	}
	return a
}

func (a *analyzer) analyzablePkg(path string) bool {
	k := a.kindOf[path]
	return k == kindModule || k == kindReplace || k == kindVendor
}

func (a *analyzer) registerType(n *types.Named) string {
	if id, ok := a.namedBy[n]; ok {
		return id
	}
	id := "type:" + n.Obj().Name()
	a.namedBy[n] = id
	if _, ok := a.named[id]; !ok {
		pos := a.l.fset.Position(n.Obj().Pos())
		a.named[id] = NamedType{ID: id, Name: n.Obj().Name(), File: a.l.rel(pos.Filename), Line: pos.Line}
	}
	return id
}

func (a *analyzer) rel(dir string) string {
	r, err := filepath.Rel(a.l.root, dir)
	if err != nil {
		return dir
	}
	return filepath.ToSlash(r)
}

func (a *analyzer) addWire(w Wire) {
	k := w.From + "\x00" + w.To
	if a.wireSet[k] {
		return
	}
	a.wireSet[k] = true
	a.wires = append(a.wires, w)
}

func (a *analyzer) run() Output {
	a.collect()
	for _, b := range a.boxes {
		a.ports(b)
	}
	for _, b := range a.boxes {
		a.scan(b)
	}
	a.resolveAuth()
	for _, b := range a.boxes {
		a.finishRecipes(b)
	}
	for _, b := range a.boxes {
		a.buildCalls(b)
	}
	for _, b := range a.boxes {
		a.buildLinks(b)
	}
	a.closure()
	out := Output{Module: a.l.module, GoVersion: a.l.goVersion, Wires: a.wires}
	if out.Wires == nil {
		out.Wires = []Wire{}
	}
	for _, b := range a.boxes {
		b.Ports = nil
		if len(b.in) > 0 {
			b.Ports = append(b.Ports, Port{ID: "in", Dir: "in", Items: b.in})
		}
		if len(b.out) > 0 {
			b.Ports = append(b.Ports, Port{ID: "out", Dir: "out", Items: a.outOrder(b)})
		}
		if b.Ports == nil {
			b.Ports = []Port{}
		}
		b.Truncated = b.budget.truncated || countItems(b.in)+countItems(b.out) > a.opt.maxItems
		out.Boxes = append(out.Boxes, b)
	}
	if out.Boxes == nil {
		out.Boxes = []*Box{}
	}
	ids := make([]string, 0, len(a.named))
	for id := range a.named {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		out.Types = append(out.Types, a.named[id])
	}
	if out.Types == nil {
		out.Types = []NamedType{}
	}
	for _, r := range a.routes {
		rt := Route{Method: r.method, Path: r.path, Handler: r.handler.ID, Framework: r.framework, File: r.file, Line: r.line}
		if auth, _ := r.handler.Meta["auth"].(string); auth != "" {
			rt.Auth = auth
		}
		out.Routes = append(out.Routes, rt)
	}
	if out.Routes == nil {
		out.Routes = []Route{}
	}
	// 読み込みは並列なので、警告の順は文で揃える（出力を決定的に）
	lw := append([]Warning{}, a.l.warnings...)
	sort.SliceStable(lw, func(i, j int) bool {
		if lw[i].Level != lw[j].Level {
			return lw[i].Level > lw[j].Level // warn を先に
		}
		return lw[i].Message < lw[j].Message
	})
	out.Warnings = append(lw, a.warnings...)
	for _, p := range a.l.pkgs {
		if p.Kind == kindStd {
			out.Stats.StdPkgs++
		} else {
			out.Stats.Files += len(p.Files)
		}
		if p.Kind == kindModule && len(p.Files) > 0 {
			out.Stats.Packages++
			out.Stats.TypeErrors += p.TypeErrors
		}
	}
	return out
}

// out の順: 出現位置の順、戻り値は最後
func (a *analyzer) outOrder(b *Box) []*Item {
	items := append([]*Item{}, b.out...)
	sort.SliceStable(items, func(i, j int) bool {
		ri, rj := items[i].ID == "return", items[j].ID == "return"
		if ri != rj {
			return rj
		}
		return b.outPos[items[i].ID] < b.outPos[items[j].ID]
	})
	return items
}

// --- 箱を集める ---

func recvName(sig *types.Signature) string {
	r := sig.Recv()
	if r == nil {
		return ""
	}
	t, _ := deref(r.Type())
	if n := namedOf(t); n != nil {
		return n.Obj().Name()
	}
	return ""
}

func (a *analyzer) collect() {
	entries := map[string]bool{}
	for _, e := range a.opt.entries {
		entries[strings.Trim(filepath.ToSlash(e), "/")] = true
	}
	type cand struct {
		fd  *ast.FuncDecl
		fn  *types.Func
		p   *Pkg
		rcv string
	}
	for _, p := range a.l.modulePkgs {
		if p.Info == nil {
			continue
		}
		rel := a.rel(p.Dir)
		idBase := rel
		if rel == "." {
			parts := strings.Split(a.l.module, "/")
			idBase = parts[len(parts)-1]
		}
		var cands []cand
		count := map[string]int{}
		fileOf := map[*ast.FuncDecl]*ast.File{}
		for _, f := range p.Files {
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil || fd.Name.Name == "_" || (fd.Recv == nil && fd.Name.Name == "init") {
					continue
				}
				fn, ok := p.Info.Defs[fd.Name].(*types.Func)
				if !ok {
					continue
				}
				sig := fn.Type().(*types.Signature)
				fileOf[fd] = f
				cands = append(cands, cand{fd, fn, p, recvName(sig)})
				count[fd.Name.Name]++
			}
		}
		for _, c := range cands {
			name := c.fd.Name.Name
			id := "fn:" + idBase + "." + name
			display := p.Name + "." + name
			if count[name] > 1 && c.rcv != "" {
				id = "fn:" + idBase + "." + c.rcv + "." + name
				display = p.Name + "." + c.rcv + "." + name
			}
			for k := 2; a.byID[id] != nil; k++ {
				id = "fn:" + idBase + "." + name + "_" + itoa(k)
			}
			pos := a.l.fset.Position(c.fd.Pos())
			b := &Box{
				ID: id, Name: display, File: a.l.rel(pos.Filename), Line: pos.Line,
				Pkg: rel, PkgName: p.Name, Func: name, Recv: c.rcv,
				Meta: map[string]any{},
				fn:   c.fn, decl: c.fd, file: fileOf[c.fd], pkg: p, info: p.Info, sig: c.fn.Type().(*types.Signature),
				inIDs: map[string]bool{}, outIDs: map[string]bool{}, outPos: map[string]token.Pos{},
				budget:   &budget{left: a.opt.maxItems},
				recipes:  map[ast.Expr]src{},
				fwCtx:    map[types.Object]string{},
				reqItems: map[string]*Item{},
			}
			b.Code = a.snippet(p, c.fd)
			if entries[rel] && name == "main" && c.rcv == "" {
				b.Entry = rel
			} else if p.Name == "main" && name == "main" && c.rcv == "" {
				b.Entry = rel
			}
			a.boxes = append(a.boxes, b)
			a.byFunc[c.fn] = b
			a.byID[id] = b
		}
	}
}

const maxCodeLines = 30

func (a *analyzer) snippet(p *Pkg, fd *ast.FuncDecl) string {
	start := a.l.fset.Position(fd.Pos())
	end := a.l.fset.Position(fd.End())
	data := p.Src[start.Filename]
	if data == nil || end.Offset > len(data) || start.Offset > end.Offset {
		return ""
	}
	lines := strings.Split(string(data[start.Offset:end.Offset]), "\n")
	if len(lines) > maxCodeLines {
		lines = append(lines[:maxCodeLines], "// …")
	}
	return strings.Join(lines, "\n")
}

func (b *Box) addIn(it *Item) *Item {
	if b.inIDs[it.ID] {
		for _, x := range b.in {
			if x.ID == it.ID {
				return x
			}
		}
	}
	b.inIDs[it.ID] = true
	b.in = append(b.in, it)
	return it
}

func (b *Box) addOut(it *Item, pos token.Pos) *Item {
	if b.outIDs[it.ID] {
		for _, x := range b.out {
			if x.ID == it.ID {
				return x
			}
		}
	}
	b.outIDs[it.ID] = true
	b.outPos[it.ID] = pos
	b.out = append(b.out, it)
	return it
}

func (b *Box) inItem(id string) *Item {
	for _, x := range b.in {
		if x.ID == id {
			return x
		}
	}
	return nil
}

func (b *Box) outItem(id string) *Item {
	for _, x := range b.out {
		if x.ID == id {
			return x
		}
	}
	return nil
}

var callItem = func() *Item { return &Item{ID: "call", Name: "()", Type: "void"} }

// --- 口（引数と戻り値） ---

func (a *analyzer) ports(b *Box) {
	here := b.pkg.Types
	params := b.sig.Params()
	used := map[string]bool{}
	fwParams := a.fwParamObjs(b.file, b.info, b.decl.Type)
	for i := 0; i < params.Len(); i++ {
		v := params.At(i)
		t := v.Type()
		if isContext(t) || isResponseWriter(t) {
			continue
		}
		if fw, ok := fwParams[v]; ok && b.reqObj == nil {
			b.handler = true
			b.reqObj = v
			b.fwCtx[v] = fw
			continue // gin / echo / fiber の Context は r と同じ扱い
		}
		if isRequestPtr(t) && b.reqObj == nil {
			b.handler = true
			b.reqObj = v
			continue // r はレシピの後で決める（項目が無ければ残す）
		}
		name := v.Name()
		if name == "_" {
			continue
		}
		if name == "" {
			name = "arg" + itoa(i)
		}
		id := uniqueID(name, used)
		b.params = append(b.params, paramItem{index: i, obj: v, id: id})
		b.budget.take()
		b.addIn(a.ty.makeItem(id, name, t, itemOpts{depth: a.opt.depth, budget: b.budget, here: here}))
	}
	// 戻り値（error は項目にしない。error だけなら type error の return）
	res := b.sig.Results()
	for i := 0; i < res.Len(); i++ {
		if isErrorType(res.At(i).Type()) {
			b.errRet = true
		} else {
			b.results = append(b.results, i)
		}
	}
	if it := a.resultItem(b.sig, here, b.budget, "return", "return"); it != nil {
		b.addOut(it, token.Pos(1<<30))
	}
	if !b.handler && len(b.params) == 0 {
		b.addIn(callItem())
	}
}

// resultItem: 戻り値（error を除く）の項目。値が無く error だけなら type error・nullable、何も返さなければ nil
func (a *analyzer) resultItem(sig *types.Signature, here *types.Package, bud *budget, id, name string) *Item {
	res := sig.Results()
	var vals []*types.Var
	hasErr := false
	for i := 0; i < res.Len(); i++ {
		if isErrorType(res.At(i).Type()) {
			hasErr = true
		} else {
			vals = append(vals, res.At(i))
		}
	}
	bud.take()
	switch {
	case len(vals) == 1:
		return a.ty.makeItem(id, name, vals[0].Type(), itemOpts{depth: a.opt.depth, budget: bud, here: here})
	case len(vals) > 1:
		var parts []string
		var kids []*Item
		used := map[string]bool{}
		for j, v := range vals {
			parts = append(parts, typeString(v.Type(), here))
			n := v.Name()
			if n == "" || n == "_" {
				n = "r" + itoa(j)
			}
			if !bud.take() {
				break
			}
			kids = append(kids, a.ty.makeItem(uniqueID(n, used), n, v.Type(), itemOpts{depth: a.opt.depth - 1, budget: bud, here: here}))
		}
		return &Item{ID: id, Name: name, Type: "(" + strings.Join(parts, ", ") + ")", WireType: "object", Children: kids}
	case hasErr:
		return &Item{ID: id, Name: name, Type: "error", Nullable: true}
	}
	return nil
}

// valueChild: 多値の戻りの j 番目（error を除いた添字）の項目 id
func valueChild(it *Item, j int) string {
	if it == nil || len(it.Children) == 0 || it.WireType != "object" || !strings.HasPrefix(it.Type, "(") {
		return ""
	}
	if j < len(it.Children) {
		return it.Children[j].ID
	}
	return ""
}

// --- 呼び先 ---

// calleeFunc: 呼び出しの静的な呼び先（interface のメソッド・関数値は nil）
func calleeFunc(info *types.Info, call *ast.CallExpr) *types.Func {
	fun := unparen(call.Fun)
	switch f := fun.(type) {
	case *ast.IndexExpr:
		fun = f.X
	case *ast.IndexListExpr:
		fun = f.X
	}
	switch f := fun.(type) {
	case *ast.Ident:
		fn, _ := info.Uses[f].(*types.Func)
		return fn
	case *ast.SelectorExpr:
		if sel, ok := info.Selections[f]; ok {
			if sel.Kind() == types.MethodVal || sel.Kind() == types.MethodExpr {
				fn, _ := sel.Obj().(*types.Func)
				if fn != nil {
					if recv := fn.Type().(*types.Signature).Recv(); recv != nil && types.IsInterface(recv.Type()) {
						return nil
					}
				}
				return fn
			}
			return nil
		}
		fn, _ := info.Uses[f.Sel].(*types.Func)
		return fn
	}
	return nil
}

func (a *analyzer) boxOfFunc(fn *types.Func) *Box {
	if fn == nil {
		return nil
	}
	return a.byFunc[fn.Origin()]
}

// funcRef: 関数・メソッドの値の参照（呼び出しではない）→ 箱
func (a *analyzer) funcRef(info *types.Info, e ast.Expr) *Box {
	switch x := unparen(e).(type) {
	case *ast.Ident:
		fn, _ := info.Uses[x].(*types.Func)
		return a.boxOfFunc(fn)
	case *ast.SelectorExpr:
		if sel, ok := info.Selections[x]; ok {
			if sel.Kind() == types.MethodVal || sel.Kind() == types.MethodExpr {
				fn, _ := sel.Obj().(*types.Func)
				return a.boxOfFunc(fn)
			}
			return nil
		}
		fn, _ := info.Uses[x.Sel].(*types.Func)
		return a.boxOfFunc(fn)
	}
	return nil
}

func fullName(fn *types.Func) string {
	if fn == nil {
		return ""
	}
	return fn.FullName()
}

// methodFull: 呼び出しの呼び先の FullName（interface のメソッドも）
func methodFull(info *types.Info, call *ast.CallExpr) string {
	sel, ok := unparen(call.Fun).(*ast.SelectorExpr)
	if !ok {
		if id, ok := unparen(call.Fun).(*ast.Ident); ok {
			fn, _ := info.Uses[id].(*types.Func)
			return fullName(fn)
		}
		return ""
	}
	if s, ok := info.Selections[sel]; ok {
		fn, _ := s.Obj().(*types.Func)
		return fullName(fn)
	}
	fn, _ := info.Uses[sel.Sel].(*types.Func)
	return fullName(fn)
}

func constString(info *types.Info, e ast.Expr) (string, bool) {
	tv, ok := info.Types[e]
	if !ok || tv.Value == nil || tv.Value.Kind() != constant.String {
		if lit, ok := e.(*ast.BasicLit); ok && lit.Kind == token.STRING {
			s := strings.Trim(lit.Value, "\"`")
			return s, true
		}
		return "", false
	}
	return constant.StringVal(tv.Value), true
}

func constInt(info *types.Info, e ast.Expr) (int64, bool) {
	tv, ok := info.Types[e]
	if !ok || tv.Value == nil || tv.Value.Kind() != constant.Int {
		return 0, false
	}
	return constant.Int64Val(tv.Value)
}

// rootObj: 式の根の変数（`t.A.B` の t、`x[i]` の x、`*p` の p）と、フィールドのパス（json の名前）
func (a *analyzer) lhsPath(info *types.Info, e ast.Expr) (types.Object, string) {
	var segs []string
	for {
		switch x := e.(type) {
		case *ast.ParenExpr:
			e = x.X
			continue
		case *ast.StarExpr:
			e = x.X
			continue
		case *ast.IndexExpr:
			e = x.X
			segs = nil
			continue
		case *ast.SelectorExpr:
			sel, ok := info.Selections[x]
			if !ok || sel.Kind() != types.FieldVal {
				return nil, ""
			}
			segs = append(selectionPath(sel), segs...)
			e = x.X
			continue
		case *ast.Ident:
			o := info.Uses[x]
			if o == nil {
				o = info.Defs[x]
			}
			return o, strings.Join(segs, ".")
		}
		return nil, ""
	}
}

// selectionPath: フィールドの選択（埋め込みを辿る）の項目 id の並び。埋め込み（タグ無し）の段は json では上がるので飛ばす
func selectionPath(sel *types.Selection) []string {
	t := sel.Recv()
	var out []string
	for _, idx := range sel.Index() {
		st, _ := deref(t)
		s, ok := st.Underlying().(*types.Struct)
		if !ok || idx >= s.NumFields() {
			break
		}
		f := s.Field(idx)
		if !(f.Embedded() && strings.Split(reflectTag(s.Tag(idx)), ",")[0] == "") {
			out = append(out, fieldJSONID(f, st))
		}
		t = f.Type()
	}
	return out
}

func reflectTag(tag string) string {
	const key = `json:"`
	i := strings.Index(tag, key)
	if i < 0 {
		return ""
	}
	rest := tag[i+len(key):]
	j := strings.Index(rest, `"`)
	if j < 0 {
		return ""
	}
	return rest[:j]
}

// unparen: 括弧を外す（ast.Unparen は Go 1.22 から。helper は go 1.21 で動くようにする）
func unparen(e ast.Expr) ast.Expr {
	for {
		p, ok := e.(*ast.ParenExpr)
		if !ok {
			return e
		}
		e = p.X
	}
}
