# 配線図のモデル（graph.json v2 の要点）

正は Stack Atlas の docs/16（契約）。ここは補いを書くのに要る所だけ。

## 1. 全体の形

```
箱（node）── 口（port）── 項目（item）── 子の項目（children）…
   │                         ▲
   └ links（箱の中: in の項目 → out の項目）
線（wire）: ある箱の out の項目 → 別の箱の in の項目（via: props | call | return | http | sql | event | render | deliver）
分岐（variants）: 箱が宣言する状態。links・線・項目に when: { <分岐>: true|false } を付ける
```

- **箱**: `id`・`kind`・`name`・`runtime`（必須）・`ports`、任意で `host`・`group`・`file`・`line`・`code`・`links`・`variants`・`cache`・`screen`・`meta`
  - `kind` の語彙（固定）: `screen` `component` `hook` `helper` `fn` `endpoint` `table` `cache` `trigger` `actor` `external` `infra` `queue`
  - `runtime` の語彙（固定）: `user` `time` `browser` `edge` `build` `server` `data` `external`
  - `host`: その箱が動く・置かれるインフラの箱（`kind: infra`。Lambda・ECS・Aurora など）。枠として描かれる
  - `group`: 折りたたみの単位。ファイル・パッケージの単位の v1 の箱（`lib:…`・`handler:…`）は、中の関数の箱（`fn:…`）が出ると group になり、箱としては消える
- **口**: `id`（`[a-z][a-z0-9_]*`）と `dir`（`in` か `out`）。よく出る口:
  - 関数・部品: `in`（引数・props・呼び出しの戻り `ret_n`）、`out`（呼び出し `call_n`・描画 `render_n`・戻り値 `return`・応答）
  - endpoint（OpenAPI の契約）: `in`（クライアントから）・`req`（実装へ。dir out）・`res`（実装から。dir in）・`out`（クライアントへ）。項目は `path` / `query` / `body`、応答は `body` か `status`
  - table: `key`（WHERE のカラム）・`write`（`row`）・`read`（`row`）
  - インフラ・v1 から来た箱: `in/_`・`out/_` の 1 項目だけ（口の単位）
- **項目**: `id`・`name`・`type`（表示用。言語どおり）、任意で `wireType`（`string` `integer` `number` `boolean` `datetime` `bytes` `object` `array` `unknown`）・`optional`・`nullable`・`typeRef`・`children`・`when`・`confidence`・`meta`
- **線**: `from`（dir out の口の項目）→ `to`（dir in の口の項目）。`reply: true` は往復の戻り側。`label`・`when`・`broken`（食い違い。ツールが付ける）
- **links**: 箱の中の `in/<項目>` → `out/<項目>`。省略した箱は「全 in → 全 out」（不透明）。`confidence`: `exact`（型で確定）/ `crude`（推定）/ `unknown`

## 2. 参照の字句

| 対象 | 形 | 例 |
|---|---|---|
| 箱 id | `<接頭辞>:<識別子>`（`#` は使えない。`/` と空白は使える） | `fn:getDays`、`fn:internal/api.handleDays`、`endpoint:GET /days` |
| 項目の参照 | `<箱 id>#<口>/<項目>(.<子>)*` | `fn:getDays#out/call_1.query.month` |
| 箱の中の参照（links・when） | `<口>/<項目>(.<子>)*` | `in/month`、`out/call_1.query` |
| 分岐のキー | `<分岐 id>` か `<箱 id>#<分岐 id>` | `hit`、`infra:static_site/this#hit` |

切り方は固定: **最初の `#` で箱、次の `/` で口、残りを `.` で項目**。

- 項目 id の文字集合は `[A-Za-z0-9_$-]+`（**`.` は使えない**）。`query.date` のような名前は `id: query_date, name: "query.date"` にする
- 分岐 id は `[a-z][a-z0-9_]*`
- 配列の要素は配列の項目の子として書く（`entries` の子が `amount`。`[]` の段は作らない）

## 3. 番号の項目（ずれる参照）

言語アダプタは呼び出し・描画・SQL を出現順に番号で作る: `call_1`・`ret_1`（呼び出しとその戻り）、`render_1`（部品の描画）、`query_1`・`insert_1`・`update_1`（SQL）。前に呼び出しが 1 つ増えると番号がずれ、同じ参照が**黙って別の項目を指す**。補いでは番号を直に書かず、意味の参照（`{ call: { in, to } }` など）か、指紋（`expect`）付きで書く（`supplements.md` §2）。

呼び出しの子は**呼び先の引数名**になる: ラッパー `fetcher(url, init?)` を呼べば `call_1.url`、`fetch(input)` なら `call_1.input`。HTTP の呼び出しは `call_n` に `meta.http = { method, path }`、子に `meta.http`（`path` / `query` / `body`）が付く（`?k=${v}` のクエリは `query` の子 `k`）。

## 4. 自動で出るもの（補わなくてよいもの）

- TS（`ts-types`）: export された関数・部品・hook の箱、引数・props・戻り、呼び出し・描画の線、`fetch` とラッパーの HTTP の呼び出し（パスがリテラルか定数のテンプレートのとき）
- Go（`go-types`）: 関数の箱、`HandleFunc("GET /x", h)` などのルート（`meta.route`）、`r.URL.Query().Get`・`r.PathValue`・`json.NewDecoder(r.Body).Decode(&v)`（v の型で展開）・`json.NewEncoder(w).Encode`、SQL の文字列、認証の middleware（分岐 `login`）
- 契約: OpenAPI の endpoint（4 つの口）、SQL マイグレーションの table
- 合流（言語をまたぐ線）: 呼び出し ⇔ endpoint ⇔ handler、handler ⇔ table。OpenAPI に無い呼び出しも、`meta.route` を持つ handler があれば直接結ぶ
- 掃除: group の箱の単位の線を中の関数の箱へ付け替える（決められないものが `undetermined`）
- 食い違い（`broken`）: 契約と実装の項目のずれ。**直すのはコードの側**で、補いで消さない

## 5. 自動で出ないもの（補いの出番）

- パスが変数で組まれた呼び出し、外部 API（自前の OpenAPI に無い URL）
- アダプタの無い言語（PHP・Java・Rust・Python など）の handler、cron・キューの中身
- OpenAPI に無いルート（webhook など）
- 中身の見えない項目（Go の `map[string]any`・`interface{}`、TS の `any`・`Record<string, unknown>`、`wireType: unknown`）
- 分岐（機能フラグ・任意の引数・認証の別の形・キャッシュの別の層）。コードの `if` や三項演算子はアダプタが分岐にしない
- 付け替え先を決められない線（`undetermined`）の行き先
