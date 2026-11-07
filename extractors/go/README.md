# @stack-atlas/extractor-go

Go のソースを **toolchain なし**で読む抽出器（docs/12 §3.4）。1 パッケージ = 1 ノード、module 内 import → `uses`、HTTP ルート登録 → `meta.apiRoutes`。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `go.repo` | — | この repo でだけ動かす（`sectionFor`）。無ければ `go.mod` のある repo |
| `go.module` | `go.mod` の `module` | module path（module 内 import の判定に使う） |
| `go.entries` | `["cmd/*"]` | 入口パッケージの glob（kind `handler`。`package main` も入口） |
| `classify` | — | `{ glob, kind, layer, repo }`。repo 相対のディレクトリかファイルに合う最初のルール |
| `deploy.<lambda>.go` | — | その Lambda に載っている入口パッケージ（`cmd/api`）。deploy エッジを張る |

`*.go`（`_test.go` を除く）を読む。`vendor/` `testdata/` と `.` `_` で始まるディレクトリは飛ばす。

## ノード

- ID `<kind>:<module 相対ディレクトリ>`（`handler:cmd/api`、`lib:internal/store`）、`name` は相対ディレクトリ。
- `file` はパッケージの先頭ファイル（`main.go` → `<dir>.go` → `<pkg>.go` → `doc.go` → 名前順）、`line: 1`、`code` は先頭 25 行。
- `meta.go: { pkg, name, imports }`（imports は標準ライブラリも含むすべて）。
- kind（上から順）: 入口（entries / `package main`）→ `handler` / ルート登録がある → `handler` / `classify` / ディレクトリ名
  （`domain` `model(s)` `types` `entity` `entities` → `type`、`store` `db` `repo` `repository` `repositories` `dao` → `schema`）/ それ以外 `lib`。
  ID の接頭辞は kind（`component` だけ `comp`）。

## ルート登録（`meta.apiRoutes: [{ method, path }]`、`meta.api` は先頭）

- net/http（Go 1.22）: `mux.HandleFunc("GET /x/{id}", h)` / `Handle("POST /", h)`。メソッドの無いパターンは `ANY`。ホスト付きはホストを落とす
- chi / echo / gin / fiber: `r.Get("/x"` / `e.GET("/x"` / `app.Post("/x"`。`:id` → `{id}`、末尾の `*` → `{rest...}`
- `router.Handle("GET", "/x"` / `r.Method(http.MethodGet, "/x"`
- コメント内は無視。`http.Get(` やレシーバ名に `client` を含む呼び出しは除く。`r.Route("/prefix", …)` の入れ子は未対応

## deploy

- `config.deploy[<lambda>].go` を deploy エッジにする（core と同じ。重複はマージで消える）。
- 明示の無い Lambda（`meta.infra.type` / `meta.cdktf.type` が `aws_lambda_function`）は推定する: `image_config.command`（`/var/task/gmail-auth`）、
  次に `function_name` / `image_uri` / `handler`（`meta.infra.attrs`、無ければ `code` の HCL）・ID・name が
  入口名（`cmd/<name>` の `<name>`）と一致、`-<name>` で終わる、または `/<name>` を含む → deploy ＋ warn `推定: <lambda> → <pkg>（deploy で明示できます）`。
  `_` と `-` は同一視する。
