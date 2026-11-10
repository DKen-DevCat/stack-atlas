# 16. graph.json v2 の契約（箱・口・項目・線）

作成: 2026-11-08。`docs/15-design-dataflow-model.md` のモデルを、JSON Schema に落とせる粒度で書いたもの。Phase 8-1 の入力。
正式な定義は `packages/schema/graph-v2.schema.json`（これから作る）。v1（`docs/03`）は読めるまま残し、v1 → v2 の変換を core に置く。

## 1. 結論

- `version: 2`。トップは `project` / `nodes` / `wires` / `types` / `views`。v1 の `layers` / `edges` / `flows` は無い（`runtime` と `wires` と `views` に置き換わる）
- 箱（node）は口（ports）を持ち、口は項目（items）を持ち、項目は入れ子になる。線（wire）は項目から項目へ。箱の中の対応は `links`。状態による分岐は `variants` と `when`
- 参照は文字列 1 種類: `<nodeId>#<portId>/<itemId>.<itemId>…`。ID の文字集合を絞って、`#` `/` `.` で必ず切れるようにする
- 既存の 12 抽出器（v1）は捨てない。**v1 → v2 変換**で「箱の単位の線」に落として読む。項目まで下げるのは言語アダプタ（8-2）

## 2. 全体の形

```jsonc
{
  "version": 2,
  "project": { "name": "...", "repo": "...", "commit": "...", "generatedAt": "...", "sources": ["web", "platform"] },
  "types": [ { "id": "type:Entry", "name": "Entry", "file": "platform/openapi/today.yaml", "line": 40 } ],
  "nodes": [ { "id": "comp:TodayIsland", "kind": "component", "name": "TodayIsland", "runtime": "browser", "ports": [ ... ] } ],
  "wires": [ { "from": "hook:useToday#out/entries", "to": "comp:TodayIsland#in/entries", "via": "return", "reply": true } ],
  "views": [ { "id": "today", "name": "今日の画面を開く", "start": "screen:/today", "variants": { "cache:swr#hit": false } } ]
}
```

## 3. ID と参照

| 対象 | 形 | 文字集合 |
|---|---|---|
| 箱 `nodes[].id` | `<kind接頭辞>:<識別子>`（v1 と同じ規約。`screen:/today`、`fn:internal/api.handleToday`） | 接頭辞は `[a-z]+`。識別子に `#` は使えない |
| 口 `ports[].id` | `in` `out` `req` `res` `key` `write` `read` `err` など | `[a-z][a-z0-9_]*` |
| 項目 `items[].id` | 口の中で一意。入れ子は親の中で一意 | `[A-Za-z0-9_$-]+`（**`.` は使えない**。表示名 `name` は自由） |
| 項目の参照 | `<nodeId>#<portId>/<itemId>(.<itemId>)*` | 例 `comp:TodayIsland#in/entries.amount` |
| 箱の中の参照（`links`） | `<portId>/<itemId>(.<itemId>)*` | 例 `in/rows.created_at` |
| 型 `types[].id` | `type:<名前>` か `table:<名前>`。TS の型は ts-imports が `type:` の箱にした宣言ならその id（衝突の退避は `~`）、それ以外（export していない型など）は `type:<repo 相対ファイル>~<名前>`（複数 repo なら `<repo>/` 付き）。OpenAPI は `type:<名前>`（2026-11-09、8-2a のレビュー） | 項目の `typeRef` が指す |
| 分岐の参照（`when` のキー） | `<variantId>` または `<nodeId>#<variantId>`（`.` ではなく `#`。箱 id に `.` が入るため） | 例 `hit`、`screen:/today#login` |

項目の `id` に `.` を禁じるので、`query.date` のような名前は `id: "query_date", name: "query.date"` になる。言語アダプタは `name` を言語どおり、`id` を `[^A-Za-z0-9_$-]` → `_` に置換して作る（衝突したら `_2` を付ける）。index signature や配列要素は、配列の項目の**子**として書き、`[]` の段は作らない（`entries` の子が `amount`）。

参照の切り方は固定: **最初の `#` で箱、次の `/` で口、残りを `.` で項目**。箱 id には `#` を使えない（`/` と空白は可。`endpoint:GET /today`）。

**v1 の箱 id は変えない**（`route:` `lib:` `handler:` `type:` のまま）。id はメモ・overrides・views の結合キーなので、kind の名前（§4）が変わっても id の接頭辞は据え置く。

**関数の単位の箱の id**（8-0a で判明。v1 の `lib:` / `handler:` はファイル・パッケージの単位だが、v2 の底は関数）: 言語アダプタが作る関数の箱は `fn:<名前>`（TS は export 名、Go は `<パッケージ相対パス>.<関数名>`。例 `fn:getToday`、`fn:internal/api.handleToday`）。名前が衝突したら `fn:<repo 相対ファイル>~<名前>`。部品と hook は v1 と同じ `comp:` / `hook:`。v1 のファイル・パッケージの箱（`lib:web/src/feature/spend/request`）は、関数の箱が出たら **`group`** になり（箱としては消える）、その id に付いていたメモは group に出す。

## 4. 箱（node）

```jsonc
{
  "id": "fn:internal/api.handleToday",
  "kind": "fn",                 // 形と色だけ。既知: screen component hook helper fn endpoint table cache trigger actor external infra
  "name": "api.handleToday",
  "runtime": "server",          // 必須。user | time | browser | edge | build | server | data | external
  "file": "platform/internal/api/today.go", "line": 12, "code": "...",
  "host": "infra:lambda_api/api",       // 任意。この箱が動く・置かれる場所のインフラの箱（kind infra）の id
  "group": "platform/internal/api",     // 任意。折りたたみの単位（§3.8）。省略時は file のディレクトリ
  "ports": [ ... ],                     // §5
  "links": [ ... ],                     // §6。省略時は既定（全 in → 全 out。table は key → read）
  "variants": [ { "id": "hit", "name": "cache hit", "default": false } ],   // §7
  "cache": { "tone": "ok", "badge": "SWR dedupe 2s", "rules": [...], "note": "..." },   // v1 と同じ Cache 型
  "screen": { "html": "screens/today/index.html", "width": 1280, "height": 800, "source": "next-export" },  // docs/14 §3.3
  "meta": { }
}
```

- `runtime` は固定の 8 値。`build` は「ビルド時に動く」（静的エクスポートのサーバー部品）。v1 の `layer` は無い
- **`runtime` の決め方**（優先順）: ① `host` の deploy 先（Lambda / ECS → `server`、Lambda@Edge → `edge`）② フレームワーク規約（`'use client'` → `browser`、App Router の server component → `server`、静的エクスポートなら `build`、`route.ts` → `server`）③ kind の既定（§10 の表）。両側で使われる TS モジュール（shared）は**使う側の runtime ごとに箱を複製**し、id に `@<runtime>` を付ける（`lib:src/lib/fetcher@server`）。`meta.sharedOf` に元の id
- **`kind: "infra"` の扱い**（D42 改訂）: **箱が動く・置かれる場所**になるインフラだけが線上に置かれず `host` の枠になる。Lambda / ECS / Cloud Run は関数の、Aurora / RDS / DynamoDB はテーブルの枠。枠だけの infra は `ports: []` でよい。**S3 の静的サイトは枠ではなく配信元の箱**（画面はブラウザで動くので枠を持たない。S3 は HTML を配るだけ）。これで CloudFront の HIT でも、CloudFront が画面の `in/html` へ折り返して画面以下が光る。それ以外（CloudFront、API Gateway、SQS、Cognito、S3）は普通の箱で、口は `in/_`・`out/_` の 1 項目ずつ。インフラどうしの関係は v1 の `flow` エッジを `via: "http"` の線にして残す
- `kind` は enum で固定（validate のエラー）。v1 の箱をそのまま使うときも id は変えず kind だけ v2 の語彙にする（例: CloudFront の `infra:static_site/this` は `kind: "cache"`）
- `kind: "cache"` の箱は `variants` に `hit` を持つのが規約。`links` は `when` で hit / miss を分ける（§6）
- `kind` の語彙は固定: `screen` `component` `hook` `helper` `fn` `endpoint` `table` `cache` `trigger` `actor` `external` `infra` `queue`。v1 の `handler` は `fn`（ルートは `meta.route`）、`layout` は `screen`、`service` / `db` / `cron` はそれぞれ `infra` / `table`（行型を持つ DB は `infra` のまま）/ `trigger`

## 5. 口（port）と項目（item）

```jsonc
"ports": [
  { "id": "in",  "dir": "in",  "items": [
      { "id": "date", "name": "date", "type": "string", "wireType": "string", "optional": true, "when": { "date": true } } ] },
  { "id": "out", "dir": "out", "items": [
      { "id": "resp", "name": "resp", "type": "TodayResponse", "wireType": "object", "typeRef": "type:TodayResponse",
        "children": [
          { "id": "total",   "name": "total",   "type": "int64",   "wireType": "integer", "typeRef": "type:TodayResponse" },
          { "id": "entries", "name": "entries", "type": "[]Entry", "wireType": "array",   "typeRef": "type:Entry",
            "children": [ { "id": "amount", "name": "amount", "type": "int64", "wireType": "integer", "typeRef": "type:Entry" } ] } ] } ] }
]
```

| フィールド | 必須 | 意味 |
|---|---|---|
| `ports[].id` / `dir` | ✓ | `dir` は `in` か `out`。往復する箱は `in`（手前から）・`req`（奥へ、dir out）・`res`（奥から、dir in）・`out`（手前へ）。テーブルは `key`（in）・`write`（in）・`read`（out） |
| `items[].id` / `name` | ✓ | §3 |
| `type` | ✓ | 表示用の、言語どおりの型の文字列 |
| `wireType` | | 線の上の形。`string` `integer` `number` `boolean` `datetime` `bytes` `object` `array` `unknown`。合流点の照合に使う（docs/15 §3.3） |
| `nullable` / `optional` | | nullable = 値が null になりうる。optional = 項目自体が無いことがある |
| `typeRef` | | **所属する名前付き型**の id（`types[].id`）。「型をクリック」で集める単位。テーブルのカラムは `table:<名前>` |
| `children` | | 入れ子。配列の要素はその項目の子として書く（`entries` の子が `amount`） |
| `when` | | この状態のときだけ存在する（§7） |
| `confidence` | | `links` と同じ。`exact` / `crude` / `unknown` |

**引数の無い呼び出しと props の無い部品**: 呼ばれる側に合成項目 `in/call`（name `()`、type `void`）を置き、`A#out/call_n → B#in/call` を引く。props の無い部品は `in/props`（name `{}`）。

**HTTP 呼び出しの線**: パスのリテラルを持つ呼び出し元（`getToday`）から endpoint へ直接引く。ラッパー（`fetcher`）は呼び出し元の脇に call / return で置き、戻りは呼び出し元の `ret_n` に fetcher と endpoint の両方から入る（fan-in）。ラッパーを線上に置くと、共有されたラッパーの先で全部の endpoint に広がる（前向きの文脈は reply では絞れない）ため。言語アダプタの規則。

**呼び出しの合成項目**（線の端点の規約を守るために要る。レビューで判明: 型 API のスパイクは `A#in/x → B#in/x` の in → in の線を出していた）: 箱 A が B を呼ぶとき、A の `out` 口に項目 `call_<n>`（name は `B()`）を作り、その子に渡す引数を B の引数名で置く。戻り値は A の `in` 口に `ret_<n>`（name は `B() の戻り`）。線は `A#out/call_1.x → B#in/x`（via call）と `B#out/ret → A#in/ret_1`（via return、reply）。A の引数から `call_1.x` への対応は `links`。部品が子部品に props を渡すのも同じ（`out/render_<n>` の子が props）。hook の戻りは `in/ret_<n>` の子。

**endpoint（合流点）の 4 つの口**: OpenAPI の path / query / body のフィールドを `in`（クライアントから）と `req`（実装へ）の両方に同じ項目で置き、response を `res`（実装から）と `out`（クライアントへ）に置く。`links` は `in/x → req/x`、`res/y → out/y` の恒等（省略可。既定で生成）。

endpoint の項目の決め方（8-2a の openapi 抽出器。2026-11-09）:

| 対象 | 項目 |
|---|---|
| パスのパラメータ | `in/path`・`req/path` の子（`{date}` → `path.date`） |
| クエリ | `in/query`・`req/query` の子 |
| requestBody | `in/body`・`req/body`。`required` が無ければ optional（OpenAPI の既定） |
| 2xx の応答 | JSON の schema があれば `res/body`・`out/body`、無ければ `res/status`・`out/status`（type は `201 Created` など、wireType は integer） |
| 応答のコード | 箱の `meta.status`。戻りの線のラベル（`200 Today`）に使う |

body の無い応答（`out/status`）から呼び出し元の `ret_n` への線は型を照合しない（fetch の戻りの `Response` と integer を比べると誤った error になる）。

## 6. 線（wire）と箱の中の対応（links）

```jsonc
{ "from": "fn:api.handleToday#out/resp", "to": "endpoint:GET /today#res/body",
  "via": "return",                 // props | call | return | http | sql | event | render | deliver
  "reply": true,                   // 往復の戻り側
  "when": { "login": true },       // §7
  "broken": [ { "path": "entries.occurredAt", "level": "error", "reason": "相手に無い" },
              { "path": "total", "level": "warn", "reason": "送る側が nullable、受ける側は必須" } ],
  "label": "GET /today" }
```

- `from` は **`dir: out` の口の項目**、`to` は **`dir: in` の口の項目**。向きはデータが流れる向き。validate が `dir` を検査する（in → in の線はエラー。§5 の合成項目で解く）
- **最も粗い単位で引く**（D34 改訂）: 受ける側の子が送る側の子に**名前で全部写る**（子を再帰、配列は要素で）なら親 1 本。`typeRef` の一致は条件にしない（合流点では TS の `type:Today`・OpenAPI の `schema:Today`・Go の `type:Transaction` と名前が違い、一致を条件にすると HTTP の線が項目ごとに分かれてしまう）。子の線を別に引くのは改名や一部だけが渡るとき
- `broken` は配列。`path` は「送る側にあれば送る側の、無ければ受ける側の」項目からの相対パス。`level` は `error` / `warn`
- **照合の規則**（`detectBroken`）:
  - 子を宣言していない側（`RequestInit`、generic の `T`、`*http.Request` など）は不透明として照合しない
  - 送る側だけにある子は error（「受ける側に無い」）。受ける側だけにある**必須**の子は error（「送る側に無い」）、`optional` なら無視
  - `nullable → 必須` と `optional → 必須` は warn
  - `wireType` の互換表: `integer → number` は互換、`number → integer` は **warn**（送る側が広い。TS の `number` を OpenAPI の `integer` に送るなど）、`datetime → string` は互換、`string → datetime` は **`via: sql` のときだけ互換**（DB が変換する）でそれ以外は error、`unknown` はどちらにあっても照合しない
- 同じ `(from, to)` の線は 1 本（マージで重複排除）
- `links` は箱の中:

```jsonc
"links": [
  { "from": "in/rows", "to": "out/resp.entries" },
  { "from": "in/rows.created_at", "to": "out/resp.entries.createdAt" },   // 改名は子の単位で明示
  { "from": "in/key", "to": "out/key",   "when": { "hit": false } },      // キャッシュ MISS: 通り抜け
  { "from": "in/key", "to": "out/value", "when": { "hit": true } }        // キャッシュ HIT: 折り返し
]
```

- `links` の `from` は `dir: in` の口の項目、`to` は `dir: out` の口の項目（validate のエラー）
- `links` を省略した箱は「全 in → 全 out」（不透明）。既定の例外: `kind: table` は `key → read` だけ、`kind: endpoint` は `in → req` と `res → out` の id が同じ項目どうし
- 親の単位の `links` は子に写る（docs/15 §3.4 の親子の写し）。写らない子（改名）だけ明示する
- `links[].confidence`: `exact`（型 API で確定）/ `crude`（state・ローカル変数経由の推定）/ `unknown`。`from` が分からない links は書かず、箱を不透明に落とす

## 7. 分岐（variants / when）

- `variants[]` は箱が宣言する: `{ "id", "name", "default" }`。`id` は `[a-z][a-z0-9_]*`
- `when` は線・`links`・項目に付く。`{ "<key>": true|false, ... }` で、複数キーは AND。OR は要素を 2 つに分ける
- キーの解決: `<variantId>` だけなら「それを宣言している箱」（線なら両端、`links`・項目ならその箱）。見つからなければ validate のエラー。**線の両端が同じ id を宣言しているときは修飾必須**（validate のエラー。SWR と CloudFront の `hit` など）。`<nodeId>#<variantId>` ならその箱
- 表示は常に 1 つの組み合わせ（既定は `default`）。`views[].variants` で組み合わせを保存できる

## 8. 型（types）と名前付きの始点（views）

```jsonc
"types": [ { "id": "type:Entry", "name": "Entry", "file": "platform/openapi/today.yaml", "line": 40, "source": "openapi" } ],
"views": [ { "id": "today-hit", "name": "今日の画面（SWR HIT）", "start": "screen:/today", "variants": { "cache:swr#hit": true } },
           { "id": "resp", "name": "レスポンスから", "start": { "from": "fn:internal/api.handleToday#out/resp", "to": "endpoint:GET /today#res/body" } } ]
```

- `types[]` は `typeRef` の宛先。同じ型の写しが複数の言語にある（OpenAPI の Entry、TS の Entry、Go の Entry）ときは **契約側を正**にして 1 つにし、`typeRef` は全部それを指す。写しの場所は `meta.copies` に
- `views[]` は flows.yaml の置き換え（docs/15 §3.9）。`start` は箱 id か項目の参照（文字列）、線なら `{ from, to }`（線に id は無い）。`variants` のキーは必ず `<nodeId>#<variantId>`

## 9. 検証（validateGraph v2）

エラー（止める）:
- 参照が解けない（`wires[].from/to`、`links[].from/to`、`host`、`views[].start`、`when` のキー）。`typeRef` が `types[]` に無いのは警告
- `host` の先が `kind: infra` でない、`wires[].via` が無い、`kind` が語彙に無い
- `links` の `from` が `dir: out`、`to` が `dir: in`
- `from` が `dir: in` の口、`to` が `dir: out` の口
- 同じ `(from, to)` の線の重複、項目 `id` の衝突、`.` を含む項目 `id`
- `kind: cache` に `hit` の分岐が無い

警告（`--strict` でエラー）:
- 口の単位の線（`#in/*` のような 1 項目の口）が残っている箱の数（項目まで下がっていない所）
- `links` を省略した箱のうち、in と out の両方に 2 つ以上の項目がある箱（不透明な箱）
- `wireType: unknown` の項目
- `typeRef` が `types[]` に無い

## 10. v1 → v2 の変換（core の `upgradeGraph`）

既存の 12 抽出器は v1 を出す。v2 のビューアとハーネスはこれを変換して読む。

| v1 | v2 |
|---|---|
| `node.layer` | 捨てる。`runtime` は `kind` と `meta` から導く: actor → `user`、cron → `time`、CloudFront / Lambda@Edge → `edge`、Lambda / API Gateway / service / queue → `server`、DynamoDB / RDS / S3(データ) / schema → `data`、route / layout / component / hook / lib → `browser`（App Router で `meta.runtime: server` なら `server`、静的エクスポートなら `build`）、handler / endpoint → `server`、外部 → `external` |
| `node.kind` | `page` / `layout` → `screen`、`lib` → `helper`、`handler` → `fn`、それ以外はそのまま |
| ノードの口 | `in` と `out` を 1 つずつ、項目は `{ "id": "_", "name": "値", "type": "unknown", "wireType": "unknown" }` の 1 つ |
| `edge.kind: deploy` | 線にしない。`to` の箱の `host` に `from` を入れる |
| `edge.kind: flow` | `via: http` の線（`from#out/_ → to#in/_`） |
| `edge.kind: uses` | import の向きはデータの向きではないので、**呼び出しと戻りの対**に落とす: `from#out/_ → to#in/_`（`via: call`）と `to#out/_ → from#in/_`（`via: return`、`reply: true`）。相手が `type:` の箱なら線にせず、`types[]` の `meta.usedBy` に入れる |
| `edge.kind: http` | `via: http`。api-link が `label` を持つならそのまま |
| `edge.kind: schema` | `via: sql`。`to` の箱（schema）は `kind: table`、`typeRef: table:<名前>` の行型 |
| `flows[]` | `views[]`。`steps[0].node` を `start` に。文は捨てる |
| `layers[]` | 捨てる（`runtime` の順が代わり） |

変換した graph は「箱の単位」なので、項目の光りや分岐は出ないが、配線図と地図はそのまま開ける。8-2 の言語アダプタが同じ箱 id に項目を足すと、マージで口と項目が置き換わる。

**core と周辺の変更**（レビューで欠けていた所）:

- `PartialGraph`（`packages/core/src/types.ts`）に `ports` / `wires` / `links` / `variants` / `types` を足す。抽出器は v1 の `edges` を出し続けてよく、パイプラインが `upgradeGraph` で v2 に揃える
- `buildGraph` は **v2 を正**として `graph.json` に書き、3D の地図（当面 v1 前提）のために `graph.v1.json` を射影して併せて出す（`runtime` → 層、`host` → deploy エッジ、口の単位の線 → エッジ）
- `memos.json` のキーは箱 id で、id は変えない（§3）ので移行は不要。`type:` の箱は `types[]` に移るが id は同じで、メモは型の一覧に出す
- `diffGraphs` は v2 の `nodes` / `wires` / `types` で比べる（項目の増減も出す）
- たどる規則・球の時刻・レイアウト前処理は、ビューアが `@stack-atlas/core` に依存できない規則があるので、新しい純 TS パッケージ **`@stack-atlas/wiring`**（schema にだけ依存）に置く。ビューアは schema と wiring に依存する（CLAUDE.md の規則を更新）
- レイアウト（ELK 相当）は `build` 時に Node で 1 回計算し、`nodes[].position` と `wires[].route` に埋める（任意フィールド）。ビューアは埋まっていれば描くだけ、無ければ簡易レイアウトで描く（手書きの v2 でも開ける）

### 実装結果（Phase 8-1。2026-11-09）

**結論**: `upgradeGraph(v1) → GraphV2`（`packages/core/src/upgrade.ts`。純関数）を作り、`buildGraph` は `graph`（v1）と `graphV2` の両方を返す。
`stack-atlas build` は **`graph.json` = v2**、**`graph.v1.json` = v1** を書く（`--v1` で従来どおり graph.json に v1 だけ。v2 への変換と検証もしない）。
変換した graph の `project.generator.v2` は `"upgrade"`（箱の単位の graph の印。手書きや言語アダプタの v2 と見分ける）。
v2 の検証は 3 つともエラー 0（警告は全部「口の単位」と、置き場の項目の `wireType unknown`）:

| graph | 箱（うち枠） | 線 | 型 | view | 警告 |
|---|---|---|---|---|---|
| `examples/race-site.graph.json` を変換 | 27（3） | 51 | 6 | 3 | 123 |
| `examples/fixture-repo` の build | 28（3） | 56 | 6 | 3 | 132 |
| `examples/fixture-poly` の build | 48（4） | 101 | 11 | 2 | 248 |

周辺: `validate` は version を見て検証器を選ぶ（8-0 のまま）。`diff` は両方 v1 ならノード・エッジ、どちらかが v2 なら箱・線・型・項目（`diffGraphsV2`。v1 の側は変換して比べる）。
`init-flows` は v1 の graph を読むまま（v2 では最初の箱が view の始点になる旨を出力に足した）。`serve` は変更なし（graph.v1.json も静的に配る）。
ビューアは build の graph.json（v2）の隣に graph.v1.json があれば（HEAD で確かめる）左上に「3D の地図」、3D の地図は graph.v1.json を開いていて graph.json があれば「配線図」を出す。
配線図の検証の一覧には、変換した graph（`project.generator.v2: "upgrade"`）に限って、箱の単位で必ず出る警告（口の単位、type も unknown の項目の wireType unknown）を出さない（`validate` では全部出る。手書きの v2 は配線図でも全部出る）。
`build` は出力先（既定は解析対象の repo の中の `.stack-atlas/out`）のシンボリックリンクを書く前に確かめ、あれば書かずに終了コード 2（repo が置いたリンクで repo の外のファイルを書き換えないため。graph.json・graph.v1.json・issues.json・memos.json・shots/ の中・`--with-viewer` の写し先、repo の中の出力先のディレクトリ）。

**§10 の表から踏み込んだ所・変えた所**（表は箱の単位で引くと決まらない所があった）:

| # | 内容 | 理由 |
|---|---|---|
| 1 | `graph.v1.json` は v2 の射影ではなく、パイプラインの v1 そのもの | v2 は v1 を変換したものなので情報は同じ。射影が要るのは言語アダプタが項目を足す 8-2 から |
| 2 | 枠（`ports: []`）になるのは、host になりうる infra（Lambda / ECS / Cloud Run / Cloud Functions、Aurora / RDS / DynamoDB）のうち deploy・schema で**実際に箱を載せているもの**だけ。何も載せていない Lambda（Lambda@Edge など）は普通の箱 | 中の無い枠は配線図に出ない（layout は host に指された箱だけを枠にする）ので、線を受けられる箱にする |
| 3 | endpoint（契約）は枠に入れない。deploy H → endpoint は「H が受け持つ endpoint」として覚え、枠への http の引き直し先にする | 8-0 の手組みの v2 と同じ。枠は「関数の」場所（D42） |
| 4 | 枠に入る flow / http は、枠に直に載っている箱へ引き直す（http で endpoint を受け持つなら endpoint へ）。枠から出る flow は直に載っている関数・helper から引き、**画面だけの枠（Next の Lambda）からは引かず**枠の `meta.flows` に残す | 枠の箱には線を描けない。Next の Lambda の環境変数（`API_BASE_URL`）を全部の画面から引くと、どのハンドラの上流にも全部の画面が入った |
| 5 | 枠の中の関数から uses でたどれる fn / helper は、たどれる枠が 1 つならその枠に入れる（2 つ以上なら入れない。使う側ごとの複製は 8-2） | Go の import は同じバイナリで動く。8-0 の手組みでも handleToday は Lambda の枠の中 |
| 6 | 口の形: 利用者・時刻は `out` だけ、endpoint は `in` / `req` / `res` / `out`、テーブルは `key` / `read`、cache は `in` / `out` に `key` / `value`（コードからの無効化があれば `in/purge`） | 「全部の箱に in と out」だと、利用者へ戻りが入ると利用者の out から全部へ広がる。endpoint とテーブルは §5 の口の名前にして既定の links（`in→req` / `res→out`、`key→read`）を効かせる |
| 7 | uses は相手で変える: 部品・画面へは `render`（戻りなし）、テーブルへは `sql` の往復、それ以外は `call` / `return`（reply） | §5 の `render_n` と 8-0 の手組み。部品は親へ値を返さない |
| 8 | http は行き（`http`、ラベル付き）と戻り（`http`、reply）の対。endpoint → 実装は `call` / `return`（req / res）。infra（cache・API Gateway など）への http は片道。**コードから cache への http は無効化の呼び出し**として links の無い `in/purge` で止める | 戻りが無いとハンドラの戻り先の絞り込み（往復の相手）が効かない。fixture-repo の `route:/admin/entry → infra:cdn`（CDN の無効化）を `in/key` に入れると、MISS で全部のオリジン（画面）へ広がった |
| 9 | flow は `http`、ただし時刻・キューからは `event` | Scheduler → Lambda は HTTP ではない |
| 10 | schema のエッジは、元が DB（枠になりうる infra）ならテーブルの `host`。それ以外は `sql` の線 | §10 の「`via: sql`」は D42（Aurora / RDS / DynamoDB はテーブルの枠）と食い違う。枠には線を付けられない |
| 11 | v1 の `schema` のうち、コード由来（`meta.go` / `meta.ts`）で schema のエッジに指されず `meta.sql` も無いもの（Go の `internal/store` を classify で schema にしたもの）は `table` ではなく `helper` | 「テーブル」ではなくデータアクセスのパッケージ |
| 12 | runtime の優先順: `meta.runtime`（明示）> host（Lambda → server、Lambda@Edge → edge、DB → data）> infra の型 > Go（server）> kind の既定。誰からも呼ばれずサーバー側だけを呼ぶ helper は server（Lambda の入口のファイル）。**静的エクスポートの画面は browser**（`build` にしない） | §10 の「静的エクスポートなら build」は D42 改訂の「画面はブラウザで動く」と 8-0 の手組み（`route:/` は browser）と食い違う。v1 には `'use client'` の情報が無く、部品の server / build は決められない（`meta.runtime` で明示できる） |
| 13 | S3 の前に cache があれば、S3 → cache の `in/value`（deliver、reply）、cache の `out/value` → S3 が配る画面（deliver、reply）。cache の前に無ければ S3 → 画面へ直接 deliver。cache のほかのオリジン（枠の中の画面、API Gateway）からの戻りは `in/value` へ（http、reply）。CloudFront Function・Lambda@Edge（関連付けのラベル `*function_association*`。型の無い graph では名前）へは戻りを引かない。エッジの関数かは枠の中の箱へ引き直す前の箱で決める（コードを載せた Lambda@Edge は枠になる）。名前の規則は CloudFront Function・Lambda@Edge をディストリビューションより先に見る | D42 改訂の「HIT でも画面以下が光る」。エッジの関数は脇で動く |
| 14 | 型: OpenAPI にもある型は file を OpenAPI のファイル（複数 repo の修飾つき）、元の場所を `meta.copies` に（D37）。`source` は openapi > sql > go > typescript。uses の相手は `meta.usedBy`。テーブルの行型は `table:<meta.sql.table か id の識別子>` | — |
| 15 | views: 最初の**箱**のステップ（型は飛ばす）を start、`tone: cache-hit` は経路上の cache の `hit: true`（それ以外は false）。start が枠なら直に載っている最初の箱（無ければ受け持つ endpoint）。箱が 1 つも無いフローは落とす | §3.9。枠は口も線も無いので、始点にすると何も流れない（fixture-poly の「メール取り込み」は `handler:cmd/gmail-webhook` から） |
| 16 | v1 の `kinds`・`layers`・`position`（x / z）は捨てる。語彙に無い kind（config.kinds で足したもの）は v1 の層で決め（infra → infra、routes → screen、components → helper、types → helper / server）、元の kind を `meta.kindV1` に。handler は `meta.api` から `meta.route` | — |
| 17 | 同じ (from, to) の線は先に引いたもの。コードのエッジ（uses / http / schema）→ deploy → flow の順に引く（sql が flow の http に勝つ）。ラベルは同じ via のときだけ補う | — |

**見つかったこと**（`packages/cli/src/__tests__/upgrade-wiring.test.ts` に事実として固定した）:

- **画面のクリックは期待どおり**: fixture-poly の `route:/` は TodayIsland → spend の request / transformer → fetcher → 3 つの endpoint → `handler:internal/api` → store → テーブルと、上流の CloudFront・S3・利用者の 20 箱。`route:/calendar` / `route:/push` / `layout:/` は光らない。fixture-repo（Next on Lambda）の各画面も他の画面を光らせない
- **共有の箱から始めると、ほぼ全部が光った**（2 段のたどり、D43）: `lib:fetcher` は 48 箱（うち枠 4）中 40、`handler:internal/api` は 35、`schema:transactions` は 38（`route:/` は 20）。fixture-repo の `lib:apiClient` は 28 箱中 19 で、使っていない `/login` と Header も入った。第 k 回の戻りの絞り込みを「前回の範囲」で判定していたので、第 1 回の範囲がほぼ始点だけだと、第 2 回で先の曖昧な戻りが「相手が 1 つも前回の範囲にいない → 全員へ」で全部通り、その回で光った箱が次の回の範囲に入って絞り込みが効かないまま止まった。**8-1 のレビューで `@stack-atlas/wiring` のたどりを直した**（曖昧な戻りを保留し、戻り先が光っているものから通し、光る箱が増えなくなってから「全員へ」を決める。docs/15 §3.5）: `lib:fetcher` は 26（下流 21。PushToggle と push の endpoint は入らない）、`schema:transactions` は 14（store の呼び出し元まで）、`lib:apiClient` は 17（/login と Header は入らない）。`handler:internal/api` は 35 のまま（全部の endpoint から呼ばれるので、呼び出し元を全部光らせるのが正しい）。画面のクリックは変わらない
- **CloudFront の HIT**: fixture-poly（静的エクスポート）は HIT でも画面へ届く。fixture-repo（SSR）は HIT で CDN で止まる（画面はオリジン）。fixture-poly では利用者 → Lambda の http（overrides）が endpoint へ直接入るので、利用者のクリックは HIT でも API まで光る
- **配線図が縦に長い**: fixture-poly は 3204 × 7538（箱の高さの合計は 2,500 ほど）。隙間は線の数（最大 12 本 ≈ 96px）ではなく、左のレーンの相手に揃える重心の配置が下へ連鎖して空く（データのレーンの最初の箱が y ≈ 6300）。重なり・箱を横切る線は無く、layout は数 ms。build 時に埋める ELK 相当のレイアウト（本節「core と周辺の変更」）で直す

**まだやっていないこと**: `PartialGraph` の `ports` / `wires` / `links` / `variants` / `types`（8-2 の言語アダプタと一緒に）、build 時のレイアウトの埋め込み、v2 → v1 の射影、`init-views`。

## 11. 決めたこと（8-1 の範囲）

| # | 決定 | 理由 |
|---|---|---|
| D36 | 項目 `id` に `.` を禁じ、参照を `node#port/a.b.c` の 1 形式にする | パーサが要らず、文字列で切れる |
| D37 | 型の写しは契約側を正にして `types[]` に 1 つ。`typeRef` は全部それを指す | 「型をクリック」が言語をまたいで集まる |
| D38 | v1 は変換して読む。抽出器は当面 v1 を出し続け、言語アダプタが項目を足す | 12 抽出器を一度に書き換えない |
| D39 | `runtime` は 8 値固定（`build` を追加） | 静的エクスポートのサーバー部品の置き場 |
| D40 | 線の端点は `out` → `in` に限り、呼び出し・props・戻りは合成項目（`call_n` / `render_n` / `ret_n`）で表す | 型 API の出力をそのまま線にすると in → in になり、たどれない（レビュー #1） |
| D41 | D34 の「親 1 本」の条件は名前の写しだけ。`typeRef` の一致は要らない | 合流点では型の名前が言語ごとに違う（レビュー #5） |
| D42 | 箱が動く・置かれる場所の infra（Lambda / ECS / Aurora など）だけ `host` の枠。S3 の静的サイトを含む他の infra は箱（2026-11-08 改訂。当初は「コードを載せる infra」で S3 も枠だったが、CloudFront の HIT で画面以下が光らなくなった） | 枠と箱の規則の矛盾（レビュー #4、8-0a #4・#5） |
| D43 | たどりは 2 段（範囲を不動点まで求めてから戻りを絞る）。球は同じ線を 1 周回に 2 回流さない | 順序依存と循環（レビュー #7） |
| D44 | たどる規則とレイアウト前処理は `@stack-atlas/wiring` に置き、レイアウトは build 時に埋める | ビューアの依存規則と、選択ごとの再レイアウトの重さ（レビュー #8・B） |
| D45 | HTTP 呼び出しの線はパスのリテラルを持つ呼び出し元から endpoint へ直接引き、共有ラッパーは脇に置く | 共有ラッパーを線上に置くと前向きに全 endpoint へ広がる（8-0a #3） |
| D46 | `wireType` の互換表: `number → integer` は warn、`string → datetime` は sql の境界だけ互換、子を宣言しない側は照合しない | 規則どおりだと TS の数値や SQL のパラメータが全部切れる（8-0a #9） |
| D47 | 関数の箱は `fn:<名前>`（衝突時はファイルで修飾）、v1 のファイル・パッケージの箱は group になる | 底を関数にしたときの id とメモの扱い（8-0a #15） |

8-0a（`claude/phase8-0-slice`）で実装して分かった残りの決定（たどりの細部）は docs/15 §3.5 に書いた。
