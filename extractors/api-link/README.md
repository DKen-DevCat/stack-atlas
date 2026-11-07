# @stack-atlas/extractor-api-link

**フロント → API の結線**を作る抽出器: api client の呼び出し ⇔ URL パス ⇔ API Gateway の `route_key` ⇔ integration ⇔ Lambda ⇔ ハンドラ。

## 入力・設定

| キー | 意味 |
|---|---|
| `api.client` | api client のファイル。`fetch` / `get` / `post` / `put` / `patch` / `delete` / `request` 呼び出しを読む |
| `cdktf.out` / `cdktf.stack` | `aws_apigatewayv2_route` / `aws_apigatewayv2_integration` を読むため cdk.tf.json を自分で読み直す |
| `deploy.<lambda>.handlers` | Lambda に載っているハンドラファイルの glob（`**` / `*` / `?` / `{a,b}`） |

上流（cdktf / ts-imports）のノードがあれば ID をそこから引く（`meta.cdktf`、`file`）。無ければ自分で `handler:<basename>` / `lib:<camelCase basename>` のノードを作る。

## client 側

- 第 1 引数の文字列・テンプレート・`"a" + b` をパスにする（`${id}` → `{id}`）。先頭のベース URL（`${BASE}` や `https://host`）と末尾のクエリ連結は落とす。`/` を含まないもの（ラッパー内部の `fetch(\`${BASE}${path}\`)` など）は読まない（debug ログ）。
- メソッドは関数名（`get` → GET）か `{ method: 'POST' }`。
- `meta.apiCalls: [{ method, path }]`。`next: { revalidate, tags }` / `cache: 'no-store'` があれば `cache`（`info`、`fetch cache`）。

## route ↔ ハンドラ（上から優先）

1. ハンドラファイルの `// @route GET /races/{id}` コメント
2. glob の親ディレクトリにあるルーティング表（`"GET /races": getRaces`）
3. 名前の規約: 動詞の接頭辞（get/list/fetch → GET、post/create/add → POST、put/update → PUT、patch → PATCH、delete/remove → DELETE）＋ 残り（単数形）がパスの静的セグメントと一致（`getRaces` ↔ `GET /races`, `GET /races/{id}`）
4. Lambda のハンドラが 1 つだけなら全 route

ハンドラには `meta.api: { method, path }`（最初の route）と `meta.apiRoutes`（すべて）を付ける。

## エッジ

- `deploy`: Lambda → ハンドラ
- `http`: client → ハンドラ（`label` は route_key。複数あればカンマ区切り）。route と結べない呼び出しは warn（overrides で補う）
- `schema`: Lambda が参照する DynamoDB テーブルが 1 つだけなら、そのハンドラが `uses` している `schema:*` へ テーブル → schema

## 制限

- REST API（`aws_api_gateway_*`）・ALB・Function URL 直叩きは未対応。
- client の呼び出しはファイル 1 つだけ。
