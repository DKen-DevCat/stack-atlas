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
| 型 `types[].id` | `type:<名前>` か `table:<名前>` | 項目の `typeRef` が指す |
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
