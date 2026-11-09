# @stack-atlas/extractor-go-types

Go の**言語アダプタ**（Phase 8-2b。設計は `docs/17-design-adapters.md` §3.3・§7）。リポジトリに置いた標準ライブラリだけの Go プログラム
（`helper/`、`go.mod` は `go 1.21`・外部依存なし）を `go run .` で動かし、`go/parser` と `go/types` で読んだ関数の単位の箱・口・項目・links と、
同じ言語の中の線（呼び出し・戻り）を `PartialGraph.v2` に出す。v1 の nodes / edges は出さない（`go` 抽出器が出す）。npm も Go も依存を足さない。

## 動かし方と安全の約束

- `go run . -root <モジュールの根> -entry <入口> -depth <n> -max-items <n>` を helper のディレクトリで、シェルを通さずに（引数の配列で）動かす。
  環境は `GOFLAGS=-mod=readonly GOPROXY=off GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0`（解析対象の go.mod / go.sum を書き換えず、
  ネットワークもツールチェーンの取得もしない。D48）。GOOS / GOARCH は外す。HOME も GOCACHE も無いときは GOCACHE を OS の一時ディレクトリに
- 解析対象のコードは実行しない。対象に `go build` / `go test` / `go generate` / `go list` を走らせない（モジュールの中のパッケージに
  `go/build` の Import も使わない）
- import は自前の `types.ImporterFrom`: モジュールの中・`replace => ./dir`（モジュールの根の中だけ）・`vendor/` は go/parser と go/types で
  再帰的に読む（メモと循環ガード。ファイルは `build.Context{GOOS: "linux", GOARCH: "amd64"}.MatchFile`、`_test.go` は除く）。標準ライブラリは
  GOROOT のソースから同じ読み込み器で読む（宣言だけ。全体で 1 つを共有）。それ以外の外部モジュールは即エラーを返し、go/types に偽の
  パッケージとして扱わせて検査を続ける（その型の項目は `wireType: unknown`。info で一覧を出す）
- シンボリックリンクでモジュールの根の外へは出ない（ファイルもディレクトリも）。読むファイルは数 5000・合計 64 MiB・1 ファイル 2 MiB まで
- 時間の上限は既定 120 秒（`STACK_ATLAS_GO_TIMEOUT_MS`）、標準出力は 64 MiB まで
- `go` が無い（か helper の go 行より古い）ときは警告して何も出さない（Go はパッケージの箱の単位のまま。D51）。`STACK_ATLAS_REQUIRE_GO=1` なら失敗にする

## 箱と id

| 箱 | id | 備考 |
|---|---|---|
| 関数・メソッド（本体のあるもの。`init` と `_` は除く） | `fn:<パッケージ相対パス>.<名前>` | 同じパッケージで名前が衝突したメソッドだけ `fn:<path>.<型>.<名前>`。モジュールの根のパッケージは module の最後の要素 |

kind は `fn`、runtime は `server`。`meta.go = { pkg, name, func, recv?, entries? }`（`pkg` は go 抽出器のパッケージの箱と同じ。mergeV2 が
v1 のパッケージの箱を group にする。D53）。入口（`go.entries` の glob と `package main`、config の `deploy.*.go`）の `main` は `meta.entry`。

host: 入口から、呼び出し・関数の値の参照（`HandleFunc` に渡した handler など）・interface への変換（`ListenAndServe(addr, h)` の `h.ServeHTTP`）を
辿った閉包。届く入口が 1 つで、その入口のインフラの箱（`deploy.*.go`、無ければ go 抽出器と同じ Lambda の名前の推定）があれば `host`。
2 つ以上なら host を空にして `meta.hosts` にインフラの箱を並べる（docs/17 §7 #11）。

## 口と項目

- in: 引数（`context.Context` と `http.ResponseWriter` とレシーバは項目にしない）。引数の無い関数は `call`。handler（`*http.Request`・
  gin / echo / fiber の Context を受ける）はレシピの項目（`path` / `query` / `body`）、無ければ `r`。呼び出しの戻りは `ret_<n>`、SELECT の 1 行は `row`
- out: 呼び出しは `call_<n>`（子は呼び先の引数名）、`json.NewEncoder(w).Encode(x)` は `out/<変数名>`（式なら `out/response`。map のリテラルは
  キーと値の式の型で展開）、`WriteHeader(n)` は `out/status`（400 以上は数えない）、SQL は `query_<n>` / `insert_<n>` / `update_<n>`、値の戻りは
  `return`（error は項目にしない。error だけを返すなら type error・nullable）
- 型の表（§7 #9）: bool / string / 整数 / 浮動小数、`time.Time` → datetime（展開しない）、`[]byte` → bytes、slice / array → array（nullable に
  しない）、map → object、struct（モジュール・replace・vendor）→ object（json タグの名前。`-` は除く、omitempty は optional、タグ無しは Go の名前、
  小文字のフィールドは除く）、pointer → nullable、標準ライブラリ・外部の名前付きの型と interface → unknown。子は既定 2 段・1 箱 200 項目まで
  （`adapters.depth` / `adapters.maxItems`）。名前付きの struct は `typeRef: type:<名前>`（`types[]` に source `go`）

## レシピ

- net/http: `mux.HandleFunc("GET /x", h)` / `Handle` / `http.HandleFunc` → 箱 h の `meta.route = { method, path }`（method の無いパターンは ANY。
  複数なら `meta.routes`）。`r.URL.Query().Get("k")` / `r.FormValue("k")` → `in/query.k`（optional）、`r.PathValue("k")` → `in/path.k`、
  `json.NewDecoder(r.Body).Decode(&v)` → `in/body`（v の型）
- 認証: `Authorization` を見て 401 を返す関数で mux 全体を包む（`M(mux)`）か、ルーターに `Use(M)` する → その mux・ルーターの全部のルートの
  handler に `meta.auth = "login"`・`meta.authBy = { fn, header, status }`。endpoint の `login` の分岐は合流の段が作る
- SQL: 関数の中の定数の SQL（SELECT / INSERT / UPDATE / DELETE）→ `meta.sql = { table, op, read, write, where, item, row?, const? }`（複数なら配列）。
  プレースホルダの値は、SQL を渡した呼び出し（`db.Query(ctx, q, a, b)`）か並び（`_, _ = q, a`）で SQL の後ろに並ぶ式。数が合えば
  `$n` ← 式（exact）、合わなければ struct のフィールドとカラムを名前で照合（crude）。`rows.Scan(&t.A, &t.B)` は引数の順 → カラム → フィールド。
  カラムの型は sql 抽出器と同じマイグレーション（`readTables`）で埋める（`typeRef: table:<名前>`）
- chi / echo / gin / fiber: 外部のモジュールなので型が無い。AST と import パスでルートの登録（Group / Route の接頭辞、`:id` → `{id}`）と、
  `c.Param` / `c.Query` / `Bind` 系 → in、`c.JSON(code, v)` → out だけを読む

## links と線

- links: 引数・`ret_n`・レシピの項目をそのまま（1 回だけ代入した変数を経由しても）参照するものは exact。2 回以上代入する変数、箱でない関数で
  作り直した値、名前の照合は crude。データ由来の link が無い out の項目へは起動の項目（`call` / `r`、無ければ引数の全部）から crude
  （`status` はその前に戻った呼び出しの `ret_n` からも）
- 線（同じ言語の中。D49）: `call_n.<引数> → 呼び先#in/<引数>`（call）、`呼び先#out/return → ret_n`（return、reply）。最も粗い単位（D41）。
  HTTP・SQL の線（endpoint・table）は合流の段（core の join）が `meta.route` / `meta.auth` / `meta.sql` と項目から引く
