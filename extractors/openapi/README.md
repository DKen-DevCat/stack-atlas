# @stack-atlas/extractor-openapi

OpenAPI 3 / Swagger 2 の契約をノードにする抽出器（docs/12 §3.5）。`endpoint:` はクライアントとサーバーの結線の合流点（D17）。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `openapi.files` | `openapi.{yaml,yml,json}` / `swagger.*`、`openapi/*.{yaml,yml,json}`、`api/` `spec/` `docs/` の `openapi:`/`swagger:` を含むファイル | 文字列はどの repo でも探す。`{ repo, path }` はその repo だけ |

## ノード

- `paths.<path>.<method>` → `endpoint:<METHOD> <path>`（kind `endpoint`、`layer: types`、`name` は `GET /today`）。
  `meta.api: { method, path, operationId }`、`meta.apiRoutes: [{ method, path }]`、`meta.openapi: { file, summary }`。
  `line` は path キーの行、`code` は path キーの行 ＋ その操作のブロック（25 行まで）。
- `components.schemas.X`（Swagger 2 は `definitions.X`）→ `type:X`（`meta.ts: { exportName: X, symbolKind: 'openapi' }`、`code` は schema のブロック）。
- `cache`: 応答に `Cache-Control` ヘッダの宣言（example / default / enum / description）か `x-cache` がある操作だけ（`info`、`Cache-Control`）。

## エッジ

- endpoint → `uses` → requestBody / responses / parameters（path 共通の parameters も）が `$ref` する schema。
  `#/components/{responses,requestBodies,parameters,headers}/…` は 1 段たどる。
- schema → `uses` → その schema が `$ref` する schema。参照先が無いエッジは出さない。
- endpoint → handler の `http` は api-link が張る（`meta.apiRoutes` の照合）。

## 複数 repo

同じ契約の写しが複数 repo にあれば、上流に openapi 由来の同じ ID があるものは出さない（最初の repo のファイルを残す。info ログ）。

## 制限

- `servers[].url` のパス（`/v1` など）はパスに足さない。外部ファイルへの `$ref` はたどらない。
