package main

// 読み込み器（docs/17 §3.3・§7 #8）: パッケージの場所を自分で解き、ファイルを build.Context{GOOS: "linux"}.MatchFile で
// 選び、go/parser で並列に読み、go/types で依存の順に検査する。types.ImporterFrom を実装し、メモと循環ガードを持つ。

import (
	"bufio"
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const (
	kindModule  = "module"
	kindReplace = "replace"
	kindVendor  = "vendor"
	kindStd     = "std"
)

type limits struct {
	maxFiles int
	maxBytes int64
	maxFile  int64
}

type replaceRule struct {
	old string
	dir string
}

// Pkg は読み込んだ 1 パッケージ。
type Pkg struct {
	Key  string // ディレクトリ（絶対パス）
	Path string // import パス
	Dir  string
	Kind string
	Name string

	Files     []*ast.File
	FileNames []string // 絶対パス（Files と同じ順）
	Src       map[string][]byte

	// import パス → 依存の Key（解けないものは unresolved に理由）
	deps       map[string]string
	unresolved map[string]string

	Types *types.Package
	Info  *types.Info
	state int // 0: 未検査、1: 検査中、2: 済み
	// 型の検査のエラー（モジュールの中だけ数える）
	TypeErrors int
	// 定数の名前 → 文字列の長さの見積もり（constlen.go。標準ライブラリは nil）
	consts map[string]int64
}

type loader struct {
	fset      *token.FileSet
	root      string // 実体のパス（シンボリックリンクを解いたもの）
	module    string
	goVersion string
	replaces  []replaceRule
	vendor    bool
	goroot    string
	// GOROOT/src の実体（シンボリックリンクを解いたもの）。標準ライブラリはこの中だけ読む
	gorootSrc string
	ctx       build.Context
	lim       limits

	mu       sync.Mutex
	pkgs     map[string]*Pkg
	wg       sync.WaitGroup
	sem      chan struct{}
	files    int
	bytes    int64
	warnings []Warning
	warned   map[string]bool
	external map[string]bool
	// モジュールの中のパッケージ（ディレクトリ順）
	modulePkgs []*Pkg
}

var moduleLine = regexp.MustCompile(`^\s*module\s+("?)([^\s"]+)`)
var goLine = regexp.MustCompile(`^\s*go\s+(\d+\.\d+(?:\.\d+)?)`)

func newLoader(root string, lim limits) (*loader, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	ctx := build.Default
	ctx.GOOS = "linux"
	ctx.GOARCH = "amd64"
	ctx.CgoEnabled = false
	ctx.BuildTags = nil
	l := &loader{
		fset:     token.NewFileSet(),
		root:     real,
		goroot:   filepath.Clean(ctx.GOROOT),
		ctx:      ctx,
		lim:      lim,
		pkgs:     map[string]*Pkg{},
		sem:      make(chan struct{}, runtime.NumCPU()),
		warned:   map[string]bool{},
		external: map[string]bool{},
	}
	if src, err := filepath.EvalSymlinks(filepath.Join(l.goroot, "src")); err == nil {
		l.gorootSrc = src
	}
	if err := l.readGoMod(); err != nil {
		return nil, err
	}
	if st, err := os.Stat(filepath.Join(real, "vendor")); err == nil && st.IsDir() {
		l.vendor = true
	}
	return l, nil
}

// Warning は helper の警告（TS の側が log に出す）
type Warning struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

func (l *loader) warn(key, msg string) { l.note(key, "warn", msg) }

func (l *loader) info(key, msg string) { l.note(key, "info", msg) }

func (l *loader) note(key, level, msg string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.warned[key] {
		return
	}
	l.warned[key] = true
	l.warnings = append(l.warnings, Warning{Level: level, Message: msg})
}

// go.mod の module・go・replace（ローカルのディレクトリへのものだけ）
func (l *loader) readGoMod() error {
	f, err := os.Open(filepath.Join(l.root, "go.mod"))
	if err != nil {
		return fmt.Errorf("go.mod が読めません: %w", err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	inReplace := false
	for sc.Scan() {
		line := sc.Text()
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		t := strings.TrimSpace(line)
		if m := moduleLine.FindStringSubmatch(line); m != nil && l.module == "" {
			l.module = m[2]
			continue
		}
		if m := goLine.FindStringSubmatch(line); m != nil && l.goVersion == "" {
			l.goVersion = "go" + m[1]
			continue
		}
		if t == "replace (" {
			inReplace = true
			continue
		}
		if inReplace && t == ")" {
			inReplace = false
			continue
		}
		var spec string
		if inReplace {
			spec = t
		} else if strings.HasPrefix(t, "replace ") {
			spec = strings.TrimSpace(strings.TrimPrefix(t, "replace "))
		} else {
			continue
		}
		parts := strings.SplitN(spec, "=>", 2)
		if len(parts) != 2 {
			continue
		}
		left := strings.Fields(parts[0])
		right := strings.Fields(parts[1])
		if len(left) == 0 || len(right) == 0 {
			continue
		}
		target := strings.Trim(right[0], `"`)
		if !(strings.HasPrefix(target, "./") || strings.HasPrefix(target, "../") || filepath.IsAbs(target)) {
			continue // モジュールへの置き換え（外部）は解かない
		}
		dir := target
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(l.root, target)
		}
		real, err := filepath.EvalSymlinks(dir)
		if err != nil || !l.inside(real) {
			l.warn("replace:"+target, fmt.Sprintf("go-types: replace の %s はモジュールの根の外（または無い）ので読みません", target))
			continue
		}
		l.replaces = append(l.replaces, replaceRule{old: strings.Trim(left[0], `"`), dir: real})
	}
	if l.module == "" {
		return errors.New("go.mod に module 行がありません")
	}
	sort.Slice(l.replaces, func(i, j int) bool { return len(l.replaces[i].old) > len(l.replaces[j].old) })
	return sc.Err()
}

func (l *loader) inside(real string) bool {
	return real == l.root || strings.HasPrefix(real, l.root+string(filepath.Separator))
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func hasPathPrefix(path, prefix string) (string, bool) {
	if path == prefix {
		return "", true
	}
	if strings.HasPrefix(path, prefix+"/") {
		return path[len(prefix)+1:], true
	}
	return "", false
}

// validImportPath: import パスとして読んでよいか（空の段・`.`・`..`・絶対パス・バックスラッシュ・NUL を断る。
// 2026-11-09 8-2b レビュー S5: `import "x/../../<絶対パス>"` が標準ライブラリの解決で GOROOT の外を読んでいた）
func validImportPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00") || filepath.IsAbs(path) {
		return false
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// stdDir: 標準ライブラリのディレクトリ（実体が GOROOT/src の中にあるものだけ）
func (l *loader) stdDir(d string) (string, bool) {
	if !isDir(d) {
		return "", false
	}
	real, err := filepath.EvalSymlinks(d)
	if err != nil || l.gorootSrc == "" || !strings.HasPrefix(real, l.gorootSrc+string(filepath.Separator)) {
		return "", false
	}
	return real, true
}

// resolve: import パス → (ディレクトリ, 種類)。from は import する側（標準ライブラリの vendor の解決に使う）
func (l *loader) resolve(path string, from *Pkg) (string, string, error) {
	if !validImportPath(path) {
		return "", "", fmt.Errorf("外部のモジュール %q は解析しません（import パスとして正しくない）", path)
	}
	if rest, ok := hasPathPrefix(path, l.module); ok {
		return l.safeDir(filepath.Join(l.root, filepath.FromSlash(rest)), path, kindModule)
	}
	for _, r := range l.replaces {
		if rest, ok := hasPathPrefix(path, r.old); ok {
			return l.safeDir(filepath.Join(r.dir, filepath.FromSlash(rest)), path, kindReplace)
		}
	}
	first := strings.SplitN(path, "/", 2)[0]
	if from != nil && from.Kind == kindStd {
		if d, ok := l.stdDir(filepath.Join(l.goroot, "src", "vendor", filepath.FromSlash(path))); ok {
			return d, kindStd, nil
		}
	}
	if !strings.Contains(first, ".") {
		if d, ok := l.stdDir(filepath.Join(l.goroot, "src", filepath.FromSlash(path))); ok {
			return d, kindStd, nil
		}
	}
	if l.vendor && (from == nil || from.Kind != kindStd) {
		if d := filepath.Join(l.root, "vendor", filepath.FromSlash(path)); isDir(d) {
			return l.safeDir(d, path, kindVendor)
		}
	}
	return "", "", fmt.Errorf("外部のモジュール %s は解析しません", path)
}

// モジュールの根の外を指すシンボリックリンクは辿らない
func (l *loader) safeDir(dir, path, kind string) (string, string, error) {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", "", fmt.Errorf("%s のディレクトリがありません", path)
	}
	if !l.inside(real) {
		return "", "", fmt.Errorf("%s はモジュールの根の外を指しています（シンボリックリンク）", path)
	}
	return real, kind, nil
}

// loadModule: モジュールの中のパッケージを全部読み、依存を辿って読み、型を検査する
func (l *loader) loadModule() error {
	var dirs []string
	err := filepath.WalkDir(l.root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if p != l.root {
			if name == "vendor" || name == "testdata" || name == "node_modules" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
				return filepath.SkipDir
			}
			// 入れ子のモジュールは別のモジュール
			if _, err := os.Stat(filepath.Join(p, "go.mod")); err == nil {
				return filepath.SkipDir
			}
		}
		dirs = append(dirs, p)
		return nil
	})
	if err != nil {
		return err
	}
	for _, d := range dirs {
		rel, _ := filepath.Rel(l.root, d)
		path := l.module
		if rel != "." {
			path = l.module + "/" + filepath.ToSlash(rel)
		}
		if p := l.ensure(path, d, kindModule); p != nil {
			l.mu.Lock()
			l.modulePkgs = append(l.modulePkgs, p)
			l.mu.Unlock()
		}
	}
	l.wg.Wait()
	// パッケージの無いディレクトリを除く
	var mods []*Pkg
	for _, p := range l.modulePkgs {
		if len(p.Files) > 0 {
			mods = append(mods, p)
		}
	}
	sort.Slice(mods, func(i, j int) bool { return mods[i].Dir < mods[j].Dir })
	l.modulePkgs = mods
	for _, p := range mods {
		l.check(p)
	}
	if len(l.external) > 0 {
		var names []string
		for k := range l.external {
			names = append(names, k)
		}
		sort.Strings(names)
		if len(names) > 8 {
			names = append(names[:8], "…")
		}
		l.info("external", fmt.Sprintf("go-types: 外部のモジュール %d 個は解析しません（その型の項目は wireType unknown）: %s", len(l.external), strings.Join(names, ", ")))
	}
	return nil
}

// ensure: パッケージを登録して読み始める（読み終わりは wg で待つ）
func (l *loader) ensure(path, dir, kind string) *Pkg {
	l.mu.Lock()
	if p, ok := l.pkgs[dir]; ok {
		l.mu.Unlock()
		return p
	}
	p := &Pkg{Key: dir, Path: path, Dir: dir, Kind: kind, deps: map[string]string{}, unresolved: map[string]string{}}
	l.pkgs[dir] = p
	l.mu.Unlock()
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		l.sem <- struct{}{}
		imports := l.parsePkg(p)
		<-l.sem
		for _, imp := range imports {
			if imp == "unsafe" || imp == "C" {
				continue
			}
			d, k, err := l.resolve(imp, p)
			l.mu.Lock()
			if err != nil {
				p.unresolved[imp] = err.Error()
				if strings.HasPrefix(err.Error(), "外部のモジュール") {
					l.external[imp] = true
				}
				l.mu.Unlock()
				continue
			}
			p.deps[imp] = d
			l.mu.Unlock()
			l.ensure(imp, d, k)
		}
	}()
	return p
}

var parseMode = parser.SkipObjectResolution | parser.ParseComments

// parsePkg: ファイルを選んで読む。import パスの一覧を返す
func (l *loader) parsePkg(p *Pkg) []string {
	ents, err := os.ReadDir(p.Dir)
	if err != nil {
		return nil
	}
	trusted := p.Kind == kindStd
	byPkg := map[string][]int{}
	var files []*ast.File
	var names []string
	src := map[string][]byte{}
	for _, e := range ents {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
			continue
		}
		full := filepath.Join(p.Dir, name)
		info, err := os.Lstat(full)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			if trusted {
				continue
			}
			real, err := filepath.EvalSymlinks(full)
			if err != nil || !l.inside(real) {
				l.warn("symlink:"+full, fmt.Sprintf("go-types: %s はモジュールの根の外を指すシンボリックリンクなので読みません", l.rel(full)))
				continue
			}
			if info, err = os.Stat(real); err != nil {
				continue
			}
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if ok, err := l.ctx.MatchFile(p.Dir, name); err != nil || !ok {
			continue
		}
		if !trusted {
			if info.Size() > l.lim.maxFile {
				l.warn("big:"+full, fmt.Sprintf("go-types: %s は大きすぎるので読みません（%d バイト）", l.rel(full), info.Size()))
				continue
			}
			l.mu.Lock()
			over := l.files+1 > l.lim.maxFiles || l.bytes+info.Size() > l.lim.maxBytes
			if !over {
				l.files++
				l.bytes += info.Size()
			}
			l.mu.Unlock()
			if over {
				l.warn("limit", fmt.Sprintf("go-types: 読むファイルの上限（%d 個・%d バイト）に着いたので、残りは読みません", l.lim.maxFiles, l.lim.maxBytes))
				continue
			}
		}
		data, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		mode := parseMode
		if trusted {
			mode = parser.SkipObjectResolution
		}
		f, err := parser.ParseFile(l.fset, full, data, mode)
		if f == nil {
			continue
		}
		_ = err // 構文エラーのファイルも、読めた所まで使う
		if p.Kind == kindModule {
			src[full] = data
		}
		byPkg[f.Name.Name] = append(byPkg[f.Name.Name], len(files))
		files = append(files, f)
		names = append(names, full)
	}
	// 同じディレクトリに複数のパッケージ（main と xxx など）があれば多い方（go の抽出器と同じ）
	pick := ""
	for name, idx := range byPkg {
		if pick == "" || len(idx) > len(byPkg[pick]) || (len(idx) == len(byPkg[pick]) && name < pick) {
			pick = name
		}
	}
	seen := map[string]bool{}
	var imports []string
	for _, i := range byPkg[pick] {
		f := files[i]
		p.Files = append(p.Files, f)
		p.FileNames = append(p.FileNames, names[i])
		for _, s := range f.Imports {
			path := strings.Trim(s.Path.Value, "\"`")
			if !seen[path] {
				seen[path] = true
				imports = append(imports, path)
			}
		}
	}
	p.Name = pick
	p.Src = src
	return imports
}

func (l *loader) rel(full string) string {
	if r, err := filepath.Rel(l.root, full); err == nil && !strings.HasPrefix(r, "..") {
		return filepath.ToSlash(r)
	}
	return full
}

type pkgImporter struct {
	l *loader
	p *Pkg
}

func (i pkgImporter) Import(path string) (*types.Package, error) {
	return i.ImportFrom(path, i.p.Dir, 0)
}

func (i pkgImporter) ImportFrom(path, _ string, _ types.ImportMode) (*types.Package, error) {
	if path == "unsafe" {
		return types.Unsafe, nil
	}
	if why, ok := i.p.unresolved[path]; ok {
		return nil, errors.New(why)
	}
	key, ok := i.p.deps[path]
	if !ok {
		return nil, fmt.Errorf("%s は読み込んでいません", path)
	}
	dep := i.l.pkgs[key]
	if dep == nil {
		return nil, fmt.Errorf("%s は読み込んでいません", path)
	}
	return i.l.check(dep)
}

var goVersionRe = regexp.MustCompile(`^go1\.\d+(\.\d+)?$`)

// check: 型の検査（メモと循環ガード）。モジュールの中は関数の本体まで、それ以外は宣言だけ
func (l *loader) check(p *Pkg) (*types.Package, error) {
	switch p.state {
	case 2:
		return p.Types, nil
	case 1:
		return nil, fmt.Errorf("import の循環: %s", p.Path)
	}
	p.state = 1
	full := p.Kind == kindModule
	if p.Kind != kindStd {
		// 依存を先に検査する（定数の文字列の見積もりに import 先の表が要る。constlen.go）。結果は go/types が
		// import の順に検査するのと同じ（1 パッケージ 1 回、メモ）
		keys := make([]string, 0, len(p.deps))
		for _, k := range p.deps {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if dep := l.pkgs[k]; dep != nil && dep.state == 0 {
				l.check(dep)
			}
		}
		l.boundConsts(p)
	}
	conf := types.Config{
		Importer:         pkgImporter{l, p},
		FakeImportC:      true,
		IgnoreFuncBodies: !full,
		Sizes:            types.SizesFor("gc", "amd64"),
		Error: func(error) {
			if full {
				p.TypeErrors++
			}
		},
	}
	if full && goVersionRe.MatchString(l.goVersion) {
		conf.GoVersion = l.goVersion
	}
	var info *types.Info
	if full {
		info = &types.Info{
			Types:      map[ast.Expr]types.TypeAndValue{},
			Defs:       map[*ast.Ident]types.Object{},
			Uses:       map[*ast.Ident]types.Object{},
			Selections: map[*ast.SelectorExpr]*types.Selection{},
			Implicits:  map[ast.Node]types.Object{},
		}
	}
	tp, _ := conf.Check(p.Path, l.fset, p.Files, info)
	p.Types = tp
	p.Info = info
	p.state = 2
	return tp, nil
}
