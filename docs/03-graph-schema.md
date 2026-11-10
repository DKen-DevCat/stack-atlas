# 03. graph.json 仕様（v1 案）

## 結論

抽出器とビューアの間の唯一の契約。**layers・nodes・edges・flows** の 4 つで構成する（任意で kind の表示定義 **kinds**）。
正式な定義は `packages/schema/graph.schema.json`（JSON Schema draft 2020-12）。TypeScript の型は `packages/schema/src/types.ts`（手書き。スキーマとのずれはテストで検出）。検証は `pnpm validate <graph.json>`。サンプルは `examples/race-site.graph.json`。

## 全体の形

```jsonc
{
  "version": 1,
  "project": { "name": "...", "repo": "...", "commit": "abc123", "generatedAt": "2026-11-07T00:00:00Z" },
  "layers": [ { "id": "infra", "name": "インフラ", "source": "infra/ · CDKtf", "color": "#ff9f43" }, ... ],
  "nodes":  [ { "id": "infra:lambdaNext", "layer": "infra", "kind": "infra", "name": "Lambda: Next.js", ... } ],
  "edges":  [ { "from": "infra:lambdaNext", "to": "route:/races/[id]", "kind": "deploy" } ],
  "flows":  [ { "id": "miss", "name": "閲覧 MISS", "steps": [ { "node": "actor:user", "text": "..." } ] } ],
  "kinds":  { "endpoint": { "name": "API エンドポイント", "color": "#38bdf8", "layer": "types" } }   // 任意
}
```

## layers

- 配列の順番 = 上から下（index 0 が最上段）
- `color` は層の板、層ラベル、**その層から下へ出る層またぎの線**の色に使う

## nodes

| フィールド | 必須 | 説明 |
|---|---|---|
| `id` | ✓ | `<kind接頭辞>:<識別子>`。抽出器どうしの合流点なので、決まった規約で作る |
| `layer` | ✓ | `layers[].id` |
| `kind` | ✓ | 形と色を決める。既知: `actor` `infra` `layout` `page` `component` `hook` `lib` `type` `schema` `handler` `endpoint` `queue` `db` `cron` `service`。`kinds` で定義した kind も既知扱い。それ以外は汎用ボックス（検証は警告） |
| `name` | ✓ | 表示名 |
| `file`, `line` | | リポジトリルートからの相対パスと行番号。複数リポジトリ（config の `repos`）では `<repo名>/<repo 相対パス>`（`project.sources` に repo 名が並ぶ）。将来「エディタで開く」に使う |
| `code` | | パネルに出すコード抜粋 |
| `position` | | `{x, z}`。層の平面上の手動配置。省略時は自動レイアウト |
| `cache` | | キャッシュ情報（下記） |
| `screen` | | 画面情報（下記）。これがあるノードは画面として描く |
| `meta` | | 抽出器固有の情報（リソース型、construct path など）。ビューアは基本的に表示のみ |

### ID 規約

| 接頭辞 | 対象 | 例 |
|---|---|---|
| `actor:` | 利用者・外部クライアント | `actor:user` |
| `infra:` | インフラリソース。識別子は IaC の論理 ID か construct path | `infra:lambdaNext`、将来は `infra:web/next` のような construct path を推奨 |
| `route:` | 画面のルート（URL パターン） | `route:/races/[id]` |
| `layout:` | レイアウト（適用されるパス） | `layout:/` |
| `comp:` | コンポーネント | `comp:ResultTable` |
| `hook:` | React hook | `hook:useRaces` |
| `lib:` | その他のモジュール | `lib:apiClient` |
| `type:` | 型・スキーマ定義 | `type:RaceResult` |
| `handler:` | API ハンドラ | `handler:getRaces` |
| `schema:` | DB スキーマ | `schema:RaceItem` |
| `endpoint:` | API の操作（OpenAPI など） | `endpoint:GET /today` |

Go のパッケージは `<kind>:<module 相対パス>`（例 `handler:cmd/api`、`lib:internal/store`）、`files` で作るノードは `<kind>:<repo 相対パス>`。
ID は repo をまたいで共有する（複数 repo でも `file` と違って repo 名は付けない。衝突するときだけ `lib:<repo>/<path>`）。

名前が衝突する場合（同名コンポーネントが別ディレクトリにある等）は、識別子にファイルパスを使う: `comp:apps/web/components/Table.tsx#Table`。

### cache

```json
{ "tone": "warn", "badge": "ISR 60s",
  "rules": [ { "key": "revalidate", "value": "60秒" } ],
  "note": "ISR(60s) と CDN(60s) が二段になるので…" }
```

- `tone`: `ok`（効いている、緑）／`warn`（要注意、黄）／`off`（なし、灰）／`info`（補足、水色）
- `badge` はラベル横の短い表示。`rules` はパネルの表、`note` は ⚠ 付きの注意書き

### screen

```json
{ "screenshot": "shots/races-id.png", "width": 1280, "height": 800,
  "regions": [ { "ref": "comp:ResultTable", "x": 28, "y": 140, "w": 712, "h": 314 } ] }
```

```json
{ "html": "screens/races-id/index.html", "source": "dir", "width": 1280, "height": 800 }
```

- `width` / `height` は regions の座標系（スクショのピクセル寸法。`html` のときはビューポート）
- `regions[].ref` は、その領域を描画しているノード。ビューアは、ハイライト対象が `ref` と一致する領域をスクショ上で枠表示する。スクショ上のホバーやタップは `ref` のノードを選んだ扱いになる
- `html`（Phase 8-3b で追加）: graph.json からの相対パス。`screens` 抽出器がビルド成果物の HTML を route ごとに写し、許可リストで消毒したもの（script 無し。`<head>` の最初の子に CSP の meta。資産は `screens/_assets/<hash>.<ext>`。SVG はファイルにせず data: URL で埋め込む。docs/18 §3.3）。`screenshot` と両方あれば `html` を優先して描く。graph.json に `regions` があればビューアの計測より優先する
- `source`（Phase 8-3b で追加）: `html` の出どころ。`next-export`（Next の静的エクスポート）・`dir`（任意のディレクトリ）・`next-build`・`wireframe`・`screenshot`（v2 の `screen.source` と同じ語彙。v1 → v2 の変換は `screen` をそのまま写し、`source` の無いスクショだけの画面は `screenshot` にする）
- `screenshot` も `html` もない場合、ビューアはプレースホルダ（ルート名と regions の枠だけ）を描く
- `regions[].source`（Phase 8-4 で追加）: 領域の出どころ。省略時は `screenshot`（スクショで測った値）。`yaml` は `.stack-atlas/screens/<slug>.regions.yaml` で補った値（HTML の `data-component` で測れない部品だけ。ビューアは ref ごとに合わせ、HTML の計測が勝つ。docs/19 §3.7）。v2 の `screen.regions[].source` と同じ語彙

## edges

| kind | 意味 | ハイライトでたどる方向 |
|---|---|---|
| `flow` | インフラ間のリクエスト経路（CloudFront → Lambda など） | 1 ホップのみ |
| `deploy` | インフラ上に載っている中身（Lambda → 各ルート、Lambda → ハンドラ） | 下方向・上方向とも推移的 |
| `uses` | import・型参照・コンポーネント利用 | 下方向・上方向とも推移的 |
| `http` | HTTP 呼び出し（api client → ハンドラ） | 下方向・上方向とも推移的 |
| `schema` | DB リソース → スキーマ型 | 下方向のみ推移的 |

方向は「from が to を使う（含む）」。ハイライトの詳しい規則は `05-viewer-spec.md`。

## flows

```json
{ "id": "miss", "name": "閲覧 MISS", "tone": "default",
  "steps": [ { "node": "actor:user", "text": "/races/42 をリクエスト" }, ... ] }
```

- `steps` の順に粒子が流れる。同じノードを複数回通ってよい（往復の表現）
- 最初と最後が同じノードの場合、戻りの線は少しずらして描く
- `tone: "cache-hit"` は黄色で描く

## kinds（任意）

kind → 表示定義。ビューアは既定の kind 表（`packages/viewer/src/graph/kinds.ts`）にマージする（同じ kind は上書き、無ければ追加）。
抽出器と設定（`stack-atlas.config.yaml` の `kinds`）が出し、設定が優先する。v1 に追加した任意フィールド（version は 1 のまま）。

```json
"kinds": {
  "endpoint": { "name": "API エンドポイント", "color": "#38bdf8", "size": [2.2, 0.3, 1.4], "layer": "types" },
  "job":      { "name": "ジョブ", "color": "#fb7185" }
}
```

| フィールド | 説明 |
|---|---|
| `name` | パネルに出す表示名（日本語） |
| `color` | `#rrggbb` |
| `size` | ボックスの大きさ `[x, y, z]`（正の数 3 つ） |
| `layer` | この kind の既定の層（`layers[].id`）。抽出時に `layer` の無いノードの割り当てに使う（`config.layerOf` が優先）。ビューアは使わない |

- `kinds` に定義した kind のノードは、検証で「未知の kind」の警告を出さない

## メモ（graph.json の外）

メモは抽出のたびに再生成される graph.json には入れない。別ファイルでノード ID をキーにして持つ案:

```json
// .stack-atlas/memos.json（解析対象リポジトリに置き、Git で共有する案）
{ "infra:lambdaNext": "メモリ1024MB / standalone。コールドスタート要観察" }
```

リネームなどで ID が変わったときにメモが孤立しないよう、ビューアに「孤立メモ一覧」を出すのが望ましい。

## バージョニング

- 破壊的な変更をしたら `version` を上げる。ビューアは未知のバージョンなら警告を出す
- 未知の `kind` やフィールドは無視して描画を続ける（前方互換）

## v2（箱・口・項目・線）

Phase 8 で、箱の単位の `nodes` / `edges` に代えて **箱（node）→ 口（port）→ 項目（item）** と、項目から項目への **線（wire）** を持つ v2 を追加した。
契約の正本は `docs/16-graph-v2-contract.md`（ID と参照 §3、箱 §4、口と項目と合成項目 §5、線と links と broken §6、分岐 §7、型と views §8、検証 §9、v1 → v2 の変換 §10、決定 D36〜D44）。たどる規則・球の規則は `docs/15-design-dataflow-model.md` §3.4〜§3.5。

| もの | 場所 |
|---|---|
| JSON Schema（正） | `packages/schema/graph-v2.schema.json`（`version: 2`。`additionalProperties: false`） |
| 型（手書き。スキーマとのずれは `v2.test.ts` で検出） | `packages/schema/src/v2.ts`（`GraphV2` / `NodeV2` / `PortV2` / `ItemV2` / `WireV2` / `LinkV2` / `VariantV2` / `ViewV2` / `NamedType`、`parseItemRef` / `parseWhenKey` / `wireTypeCompatible`） |
| 検証 | `validateGraphV2(json)` → `{ ok, graph, errors, warnings }`（docs/16 §9）。`validateAnyGraph` が `version` で v1 / v2 を振り分け、`pnpm validate` / `stack-atlas validate` はこれを使う |
| たどる・選ぶ・球の時刻・切れている線（純 TS） | `packages/wiring`（`@stack-atlas/wiring`。schema にだけ依存）: `indexGraph` / `traverse` / `select` / `schedule` / `detectBroken` |
| 手で組んだ例 | `examples/fixture-poly.today.v2.json`（fixture-poly の `/`（画面）→ `GET /today` → `transactions` の経路と、契約の食い違いを出す `POST /transactions`。箱 20・線 32。`pnpm validate` で エラー 0・警告 1） |

`project.generator.report`（build の報告。`validate --strict` が読む）は docs/16 §8.1。2026-11-11（Phase 9-L0）に、段 0 の報告の数 `coverage`（数える範囲・言語ごとの読めた行。`$defs/coverageSummary`）と `counts.unreadLanguages` を足した（docs/23 §3.1）。

トップの `groups`（2026-11-10 Phase 8-6）: group になった v1 の箱の元の `name`・`kind`（v1 の語彙）・`file`（docs/16 §8.2）。3D の地図は v2 の graph.json を `@stack-atlas/wiring` の `projectMap` で v1 の形に写して描き（docs/20）、group のノードの名前と kind にこれを使う。graph.v1.json（v1）は互換のために出し続けるが、2 面のビューアは使わない。

v1 は読めるまま残す（`validateGraph`、`graph.schema.json`、この文書の上の節）。v1 → v2 の変換（`upgradeGraph`）とパイプラインの v2 化は 8-1（docs/16 §10）。
