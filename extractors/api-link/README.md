# @stack-atlas/extractor-api-link

**フロント → API の結線**を作る抽出器: api client の呼び出し ⇔ URL パス ⇔（API Gateway の `route_key` ⇔ integration ⇔ Lambda ⇔ ハンドラ ／ OpenAPI の `endpoint:` ／ Go・Next の `meta.apiRoutes`）。一般化は docs/12 §3.6。

## 入力・設定

| キー | 意味 |
|---|---|
| `api.repo` | この repo でだけ動かす（`sectionFor`） |
| `api.client` | api client のファイル（従来。`clients` と併用可） |
| `api.clients` | client ファイルの glob（`*.test.*` / `*.spec.*` / `*.stories.*` は除く） |
| `api.callers` | 第 1 引数がパスのラッパー関数名（自動検出に足す） |
| `api.targets` | client の呼び先のインフラノード ID（省略時は推定、下記） |
| `cdktf.out` / `cdktf.stack` | `aws_apigatewayv2_route` / `aws_apigatewayv2_integration` を読むため cdk.tf.json を自分で読み直す |
| `deploy.<lambda>.handlers` | Lambda に載っているハンドラファイルの glob（`**` / `*` / `?` / `{a,b}`） |

上流（cdktf / tf-graph / ts-imports）のノードがあれば ID をそこから引く（`meta.cdktf`、`meta.infra`、`file`）。`file` は `<repo>/<path>` 修飾でもよい。
無ければ自分で `handler:<basename>` / `lib:<camelCase basename>`（client ファイルどうしで衝突したら `lib:<path>`）のノードを作る。

## client 側

- 読む呼び出し: `fetch` / `request` / `get` / `post` / `put` / `patch` / `delete` / `del` / `head`、`api.callers`、**自動検出したラッパー**。
  ラッパー = 引数を前にリテラルを置かずにパスとして渡す関数（`fetch(\`${API_DOMAIN}${url}\`)`、`fetch(getFullUrl(endpoint))`、`BASE + path`、
  既知のラッパーへの `request(url, …)`）。推移的にたどり（fetcher → request → fetch）、client ファイルどうしで名前で共有する。
  本体に `{ method: 'POST' }` があればそのメソッドを持つ。ラッパーの中の中継呼び出しは呼び出しに数えない。
- パス: 文字列・テンプレート・`"a" + b`（`${id}` / `encodeURIComponent(id)` → `{id}`）。同じファイルと import 先（相対 / `@/` `~/` は `src/` か root）の
  文字列定数（`const DAYS = "/days"`）は展開する。先頭のベース URL（`${BASE}` や `https://host`）とクエリは落とす。読めないものは debug ログ。
- メソッドは `{ method: 'POST' }` → ラッパーのメソッド → 関数名（`get` → GET、`postX` → POST…）→ GET。
- 呼び出し元ノード: 上流で `file` が一致するノード（comp / hook / lib / page / layout / handler）のうち、呼び出しを含む export 名（`meta.ts.exportName` / `exports`）
  のもの → lib → 先頭。`meta.apiCalls: [{ method, path }]`。`next: { revalidate, tags }` / `cache: 'no-store'` があれば `cache`（`info`、`fetch cache`）。

## 照合（上から順）

1. API Gateway の route（cdk.tf.json を読み直す ＋ tf-graph の `meta.infra.apiRoutes: [{ routeKey, lambdaId }]`）。合う route が複数なら最も具体的なもの
2. `endpoint:` ノード（OpenAPI）。メソッドと `{x}` のパスで照合、末尾スラッシュ・Go の `{x...}`・Express の `:x` を許す
3. `meta.apiRoutes` を持つノード（Go のルート登録、Next の route.ts / pages/api）
4. handler の `// @route GET /x` コメント

client のパスパラメータ（`{id}`）は route のパラメータにだけ合う（リテラルには合わない）。

## route ↔ ハンドラ（上から優先）

1. ハンドラファイルの `// @route GET /races/{id}` コメント
2. glob の親ディレクトリにあるルーティング表（`"GET /races": getRaces`）
3. 名前の規約: 動詞の接頭辞（get/list/fetch → GET、post/create/add → POST、put/update → PUT、patch → PATCH、delete/remove → DELETE）＋ 残り（単数形）がパスの静的セグメントと一致（`getRaces` ↔ `GET /races`, `GET /races/{id}`）
4. Lambda のハンドラが 1 つだけなら全 route

ハンドラには `meta.api: { method, path }`（最初の route）と `meta.apiRoutes`（すべて）を付ける。

## エッジ

- `deploy`: Lambda → ハンドラ
- `http`: 呼び出し元 → endpoint（`label` は `GET /today`）。endpoint が無ければ 呼び出し元 → ハンドラ（`label` は route_key。複数あればカンマ区切り）。
  route / endpoint と結べない呼び出しは warn（overrides で補う）
- `http`: endpoint → それを実装するハンドラ（`meta.apiRoutes` / API Gateway の route）。client が無くても張る
- `deploy`: `api.targets`（無ければ API Gateway ノード、それも無ければ `meta.infra.functionUrl === true` の Lambda が 1 つなら推定して warn）→ endpoint。
  target が 1 つなら全 endpoint、複数ならその target から deploy / uses（と `deploy.<id>.go` / `nodes`）を 4 段たどって着くハンドラが実装する endpoint
- `schema`: Lambda が参照する DynamoDB テーブルが 1 つだけなら、そのハンドラが `uses` している `schema:*` へ テーブル → schema

## 制限

- REST API（`aws_api_gateway_*`）の route・ALB のルールは読まない（endpoint / apiRoutes 経由なら結べる）。
- 複数 repo のとき、endpoint / Go のルートは上流にある必要がある（go / openapi が全 repo で api-link より先に走ること）。
- ラッパーのパスの前にリテラル（`${BASE}/api${path}`）があるものは検出しない（`api.callers` で指定しても前置きは足さない）。
