# 17. 設計: 言語アダプタと合流（Phase 8-2）

作成: 2026-11-09。`docs/15`（モデル）・`docs/16`（v2 の契約）の上で、**項目の単位の graph をコードから自動で作る**部分の設計。8-1（v1 → v2 の変換。箱の単位）の次。

## 1. 結論

- 新しい抽出器を 2 つ足す: **`ts-types`**（TS / TSX。ts-morph が内蔵する TypeScript の型 API）と **`go-types`**（Go。リポジトリに置く標準ライブラリだけの Go プログラムを `go run` で動かし、`go/parser` ＋ `go/types` で型を読む）。どちらも**依存を足さない**
- アダプタが出すのは **v2 の部分グラフ**（関数の単位の箱、口・項目・links、同じ言語の中の線）。言語をまたぐ線（HTTP・SQL）はアダプタは引かず、パイプラインの **合流（join）** の段が引く
- 合流点は 3 つ: **endpoint**（OpenAPI の schema から 4 つの口に項目を入れる）、**table**（SQL のマイグレーションからカラム）、**event**（後回し）。両側の項目をここで照合し、`detectBroken` で `broken` を書く
- 受け入れ条件: fixture-poly を `stack-atlas build` すると、手で組んだ `examples/fixture-poly.today.v2.json` と**同じ形**（箱・線の対応、食い違い 3 件）が自動で出る

## 2. 全体像（パイプライン）

```
v1 抽出器（12 本、従来どおり）──▶ merge（v1）──▶ upgradeGraph（8-1。箱の単位の v2）
                                                   │
ts-types / go-types（v2 の部分グラフ）─────────────▶ mergeV2: 同じ箱 id は口・項目をアダプタで置き換え
                                                   │       v1 のファイル・パッケージの箱は group に（D47）
                                                   ▼
                                     join: endpoint / table / route の照合で言語をまたぐ線を引く
                                                   ▼
                                     detectBroken → wires[].broken、validateGraphV2
                                                   ▼
                                     graph.json（v2）＋ graph.v1.json
```

## 3. 構造

### 3.1 契約の追加（`packages/core/src/types.ts`）

- `PartialGraph` に `v2?: { nodes: NodeV2[]; wires: WireV2[]; types?: TypeV2[]; groups?: Record<string, string> }` を足す。v1 の `nodes` / `edges` と同じ出力に並べてよい
- **mergeV2 の規則**: 同じ箱 id は、口を口 id で、項目を項目 id で合わせる。アダプタの項目があれば upgrade の `_` 項目を消す。`_` どうしの線（箱の単位の線）は、同じ 2 つの箱の間にアダプタの項目の線が 1 本でもあれば消す（細かい方が勝つ）
- v1 の `lib:` / `handler:`（ファイル・パッケージの箱）の中に関数の箱が出たら、その v1 の箱は消えて `group` になる（D47）。v1 の箱に付いていた線は、group の中の関数の箱どうしの線で置き換わる
- （8-2a のレビューで追加）`PartialGraphV2.refs`（箱 → 参照先。型の注釈も含む）は掃除の付け替え先を決めるためだけに使い、graph.json には出さない。抽出器に `v2Role`（`language` / `contract`。openapi・sql は contract）。要約と `project.generator` は言語アダプタ（`adapters`）と契約（`contracts`）を分け、付け替え先を決められない線の数（`undetermined`）を出す
- （8-2a で確定）`v2.nodes` は `PartialNodeV2[]`（`runtime` を省略できる。決められないときは upgrade の値か group の値、無ければ `browser`）。`groups` は「関数の箱 id → 置き換える v1 の箱 id」。config に `adapters: { depth, maxItems }`（既定 2 / 200。docs/13 §4.1）

### 3.2 `ts-types`（TS / TSX）

入力: `ts.tsconfig`（既存の設定キー）。ts-morph の `Project` から `ts.TypeChecker` を取る。

| 箱 | 判定 | id |
|---|---|---|
| 画面 | Next の page / layout の default export（nextjs-app と同じ規則。id は `route:` / `layout:` を共有） | `route:/today` |
| 部品 | 名前が大文字で JSX を返す関数 | `comp:<名前>` |
| hook | `use` で始まる関数 | `hook:<名前>` |
| 関数 | それ以外の export された関数・アロー関数 | `fn:<名前>`（衝突時は `fn:<file>~<名前>`。D47） |

- **口と項目**: `in` = 引数（分割代入の props はフィールドに展開）。`out` = 戻り値（`Promise` を剥がし、既定 2 段まで展開。設定 `adapters.depth`）。呼び出しごとに `out/call_<n>`（子は呼び先の引数名）と `in/ret_<n>`（呼び先の戻り値）。JSX の子部品は `out/render_<n>`（子は渡す props）。引数の無い呼び出しは呼び先の `in/call`、props の無い部品は `in/props`（docs/16 §5）
- **型**: `type` は `checker.typeToString`、`wireType` は対応表（`number` → number、`string` → string、`boolean`、`Date` → datetime、配列 → array、オブジェクト → object、ほか unknown）、`typeRef` は名前付きの型の宣言（`type:<名前>`。generic の型引数は除く）、`optional` / `nullable` は `?` と `| null | undefined`
- **links**: `return` 式・JSX の props の式・呼び出しの引数の式が参照する引数（`exact`）。`useState` の setter・ローカル変数を経由するもの（`crude`）。分からなければ書かない（不透明）
- **runtime**: `'use client'` とその import の閉包 → browser、App Router の server component → server（静的エクスポートなら build）、`route.ts` → server。両方から使われるものは使う側ごとに複製（`@<runtime>`。docs/16 §4）
- **同じ言語の中の線**: 呼び出し（`call_n.x → 呼び先#in/x`、via call）と戻り（`呼び先#out/... → ret_n`、via return、reply）、props（`render_n.p → 子#in/p`、via props）。線は最も粗い単位で（D41。名前で子が全部写るなら親 1 本）
- **HTTP の呼び出し**（D45）: `fetch(...)` と、ラッパー（`api.callers` か、既存の api-link の自動検出）の呼び出しで、パスがリテラル（テンプレートの定数を展開したもの）なら、`call_n` の子に `path`（と `query` / `body` の項目）を置き、`meta.http = { method, path }` を付ける。endpoint への線は合流の段が引く
- **上限**: 1 箱の項目は 200 まで、展開の深さは 2 段まで。超えたら警告して打ち切る

### 3.3 `go-types`（Go）

- `extractors/go-types/helper/main.go`（標準ライブラリだけ。`go.mod` も同梱し外部依存なし、go 行は低く `go 1.21`）を helper のディレクトリで `go run` し、解析対象のモジュールのパスを引数で渡して JSON を受け取る。環境は **`GOFLAGS=-mod=readonly GOPROXY=off GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0`**（解析対象の go.mod / go.sum を書き換えず、ネットワークもツールチェーンの取得もしない。§7 #7）。`go` が無いときは警告して何もしない（既存の `go` 抽出器の箱の単位が残る）
- 型は `go/parser` ＋ `go/types` と**自前の `ImporterFrom`**: モジュール内・`replace => ./dir`・vendor のパッケージは go/parser と go/types で再帰的に読む（メモと循環ガード、ファイルは `build.Context{GOOS: "linux"}.MatchFile` で選ぶ）。標準ライブラリは共有の source importer 1 つで解く。それ以外（外部モジュール）は即エラーを返し、go/types に偽のパッケージとして扱わせて検査を続ける。外部の型の項目は `wireType: unknown`。chi / echo / gin のレシピは型ではなく AST と import パスで判定する（§7 #8）
- **箱**: 関数とメソッド（`fn:<パッケージ相対パス>.<関数>`、メソッドは `.<型>.<メソッド>`）。`cmd/*` の `main` は入口（`meta.entry`）
- **口と項目**: 引数・戻り値の struct を json タグの名前で展開（タグが無ければ Go の名前）、`error` は `err` 口。呼び出しは TS と同じ `call_n` / `ret_n`
- **レシピ**（フレームワーク規約。`helper/recipes_*.go`）:
  - net/http: `HandleFunc("GET /x", h)` / `Handle` → 箱 h の `meta.route`。`r.URL.Query().Get("k")` / `r.PathValue("k")` → `in` に項目 `k`。`json.NewDecoder(r.Body).Decode(&v)` → `in/body`（v の型で展開）。`json.NewEncoder(w).Encode(x)` → `out/response`（x の型。`map[string]any` のリテラルはキーと値の式の型で展開）
  - 認証の middleware（`Authorization` を見て 401 を返す関数で包むもの）→ endpoint に `login` の分岐（`when: { login: false }` で handler に届かない）
  - SQL: 定数の SQL 文字列 → テーブル名、読むカラム、書くカラム、WHERE のカラムを `meta.sql`。`rows.Scan(&t.A, &t.B)` の引数の順 → カラム → フィールドの `links`
  - chi / echo / gin はルートの登録だけ（項目はリクエストの struct が取れたときだけ）

### 3.4 合流（`packages/core/src/join.ts`）

| 合流点 | 箱 | 片側 | もう片側 |
|---|---|---|---|
| endpoint | openapi 抽出器の `endpoint:<METHOD path>` を 4 つの口に。request（path / query / body）を `in` と `req`、response を `res` と `out` に、schema のフィールドを項目で | クライアント: `meta.http` が合う `call_n` → `endpoint#in/*`、`endpoint#out/body` → 呼び出し元の `ret_n`（reply） | サーバー: `meta.route` が合う handler: `endpoint#req/* → handler#in/*`、`handler#out/response → endpoint#res/body`（reply） |
| table | sql 抽出器の `schema:<table>` を `key` / `write` / `read` の口に。カラムを項目に | 関数の `meta.sql`: WHERE のカラム → `table#key/*`、書くカラム → `table#write/*`、`table#read/row → 関数#in/ret_<n>`（reply） | — |
| route（OpenAPI が無いとき） | endpoint を合成（`meta.http` と `meta.route` のパスで照合） | 同上 | 同上 |

- パスの照合は既存の api-link の正規化（`{id}` と `:id` と `[id]`）を使う。照合できない呼び出しは警告（従来どおり overrides で補える）
- 合流のあと `detectBroken` を全線に掛けて `wires[].broken` を書く（D46 の照合）

### 3.5 分岐の自動抽出（最小）

- キャッシュ: SWR / React Query の呼び出し（cache 抽出器が見つけたもの）→ `cache:<hook>` の箱を hook と fetcher の間に挟み、`hit` の分岐と when 付きの links。CloudFront は 8-1 の変換で `hit` 付き
- 認証: go-types の middleware レシピ → endpoint の `login`
- 任意の引数・クエリ: 自動では分岐にしない（項目の `optional` だけ）。分岐にしたいものはハーネス（8-4）でエージェントが書く

## 4. 受け入れ条件と検証

- `pnpm atlas build examples/fixture-poly -o out/fixture-poly` の graph.json（v2）で:
  - 手で組んだ例の箱（`route:/`・`comp:TodayIsland`・`fn:getToday`・`fn:toTodayView`・`lib:fetcher`・`endpoint:GET /today`・`fn:internal/api.handleToday`・`fn:internal/store.ListByDate`・`schema:transactions` ほか）が全部あり、例と同じ線（端点の箱と via が同じ）がある。テストで固定（`examples/fixture-poly.today.v2.json` との構造比較。id の揺れは表で吸収）
  - 食い違いは例と同じ 3 件（`occurredAt` 2 件の赤、`amount` の黄）
  - `validateGraphV2` のエラー 0
- 項目・線・links の自動率を CLI のサマリに出す（`項目 N（unknown M）、線 N（項目 / 箱の単位）、links N（exact / crude / 不透明）`）。docs/15 §7 の見積り（項目 90%・線 80%）と比べて記録する
- go が無い環境（CI の一部）でも build は通る（go-types は警告して空）。CI には go を入れる（`actions/setup-go`。ネットワークは CI の中だけ）

## 7. 設計レビューの記録と、確定した規則（2026-11-09、実装前に 1 回）

独立レビューで「このままでは受け入れ条件の 3 件が自動で出ない」と指摘された。直した点（§3 の記述より優先する）:

1. **合流点の線の粒度**（D52）: `createTransaction#out/call_1.body → POST /transactions#in/body` は受ける側にしか `occurredAt` が無いので D41 では親 1 本にならず、子ごとの線になって `occurredAt` が検出されない。合流点では役割ごとに必ず親 1 本
2. **名前は例に合わせる**（D54）:

| 対象 | 規則 |
|---|---|
| HTTP の呼び出しの子 | 呼び先の引数名（`call_1.url`）。`JSON.stringify(x)` は剥がして x の型（`call_1.body` は `Entry`）。`call_n` の項目に `meta.http = { method, path }`、子に `meta.http: "path" \| "body" \| "query"`。子の optional は呼び先ではなく実引数から決める（呼び先の `init?` を写すと warn が増える） |
| 部品が子部品に渡す props の線 | `via: "render"`（`out/render_n.p → 子#in/p`） |
| 戻り値の項目 | `out/return` |
| 画面の入口 | `in/html`（配信の線が着く） |
| Go の関数・メソッドの id | `fn:<パッケージ相対パス>.<名前>`（レシーバは衝突したときだけ `.<型>.<名前>`） |
| Go の Encode の出力 | encode した変数の名前（`out/resp`）、式なら `out/response`。`WriteHeader(n)` → `out/status` ↔ endpoint の `res/status` |
| Go の error | 項目にしない（値の戻りは `out/return`）。`ctx` と `w http.ResponseWriter` も項目にしない |
| レシピの項目が無い handler | `endpoint#req/path → handler#in/r` |
| table | `query_n.<col> → table#key/<col>`（WHERE）、`insert_n → table#write/row`（親 1 本）、`table#read/row → fn#in/row`（Scan の先、reply） |

3. **起動の links**: 起動の項目（`in/call` / `in/props` / `in/html` / `in/r`）から、データ由来の link が無い `call_n` / `render_n` へ `crude` の link を足す。links を 1 本でも持つ箱には既定の「全 in → 全 out」が効かず、画面をクリックしても `getToday` 以降が光らないため
4. **mergeV2**（D53）: 掃除は join の後。group は file と `meta.go.pkg` の被覆で判定。呼び出しでない参照は `_` を残す。ts-types は ts-imports の classify と id の規則を共有する（同じ関数が 2 箱にならないように）。口・項目・links・runtime はアダプタが勝ち、host・cache・screen は upgrade の値を残す
5. **join を書ける形にする**: パスの正規化を api-link から core に移す（api-link は core に依存しているので逆は循環）。openapi 抽出器が `PartialGraph.v2` で endpoint の 4 口と schema のフィールドの項目を出す（8-2a）。sql 抽出器が table の 3 口とカラムの項目（SQL の型 → wireType）を出す（8-2b）。join は線だけを引く。`mergePartialGraphs` と `prefixRepoFiles` が `v2` を運ぶ。detectBroken をパイプラインに入れるのは 8-2a
6. **受け入れ条件の比べ方**: ① 例の id を規則に合わせて直し、別名表を空に近づける ② 例の箱が全部ある ③ 合流点の線は from / to の項目の参照まで一致、言語の中の線は（箱, 箱, via, reply）が一致 ④ 例の箱どうしの間で例に無い線は、許可した表に無ければ失敗（残った `_` や二重を捕まえる）⑤ broken は「線 → {(path, level)}」が一致 ⑥ validateGraphV2 のエラー 0 ⑦ 全体の broken はスナップショットで固定（fixture 全体では `GET /entries` も Go の `[]Transaction` と OpenAPI の `Entry[]` で `occurredAt` が食い違うので、3 件より多くなる。これは見つかったこととして固定する）。8-1 が作る箱（CloudFront・S3 など）は比べる対象から除く
7. **Go の実行環境**（D48）: `-mod=mod` は go.mod を書き換えて取りに行くので逆。`-mod=readonly GOPROXY=off GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0`
8. **Go の importer**: 検証のスクリプトは `importer.Default()` で、外部依存 0 の 2 パッケージを決め打ちしていた。未解決の import の経路を通っていない。§3.3 の自前の importer にする
9. **Go の型の表**: 外部の型（`*http.Request` など）は unknown（object にすると `req/path → in/r` が error）。`time.Time` は datetime（展開しない）。slice は nullable にしない（nil slice が JSON で null になる穴は既知として残す）
10. **TS**: 部品と `useState` は構文で判定（React 19 にはグローバルの JSX が無い）。react が解けないときだけ最小の型の stub を足す。`ret_n` は `checker.getResolvedSignature(call)` の戻り型。tsconfig の `extends` が node_modules の共有設定で解けないときは警告（paths が黙って消える）。call_n の番号は出現位置の順。ts-morph の Project は抽出器の間で共有する
11. **範囲**: SWR の cache の箱は 8-2 から外す（fixture-poly に SWR が無く、`useSWR(key, fn)` はコールバック渡しで呼び出しの線が出ない）。`@runtime` の複製は 8-2 のアダプタが行う（upgrade はしない）。Go の関数の host は入口（`cmd/*`。config の `deploy.*.go`）からの閉包で決め、複数の入口から使われる関数は host を空にして `meta.hosts` に並べる。ルートの照合は method の無いパターンを ANY、handler が複数なら host が合うものを優先。middleware が mux 全体を包むなら全 endpoint に login が付く（例の POST にも付ける）

## 5. タスク

| # | 内容 |
|---|---|
| 8-2a | 契約（`PartialGraph.v2`、merge と prefix が運ぶ）、パスの正規化を core へ、openapi が endpoint の 4 口と項目を出す、ts-types（画面・部品・hook・関数、呼び出し・render・戻り、起動の links、runtime と複製、HTTP の呼び出し）、join の endpoint（クライアント側）、mergeV2 の掃除（join の後）と group 化、detectBroken をパイプラインに、例の id と runtime を規則に合わせる、テスト（POST の 2 件が出る） |
| 8-2b | go-types（helper、自前の importer、net/http・認証・SQL のレシピ、型の表）、sql が table の 3 口と項目を出す、join の endpoint（サーバー側）と table、受け入れ条件のテスト（§7 #6）、CI で go を必須に、サマリ。8-2a の残り（§8.3）: export したオブジェクトリテラルのメソッドを関数の箱にする（fixture-repo の `api.getRaces`）、役割ごとの欠け（必須の body を送っていない）を broken で表す |

## 6. 決めたこと

| # | 決定 | 理由 |
|---|---|---|
| D48 | TS は ts-morph 内蔵の TypeScript（ts-morph 28 の `export { ts }`、TypeScript 6.0）、Go は標準ライブラリだけの helper を `go run`（`-mod=readonly GOPROXY=off GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0`）。npm も Go も依存を足さない。CI は ubuntu の runner に入っている go を使い、`actions/setup-go` は足さない | ネットワークを伴う依存追加は事前確認が要る（グローバルルール） |
| D49 | アダプタは同じ言語の中の線だけを引き、言語をまたぐ線は合流の段が引く | 照合の規則（パスの正規化・schema）を 1 か所に置く。アダプタを足すときに合流を書き直さない |
| D50 | 細かい方が勝つ: アダプタの項目は `_` を置き換え、同じ 2 つの箱の間の箱の単位の線は消す | 8-1 の箱の単位と 8-2 の項目の単位を同じ graph に重ねるため |
| D51 | go が無ければ go-types は空（警告のみ）。CI では `STACK_ATLAS_REQUIRE_GO=1` で go が無いことを失敗にする | 利用者の環境に toolchain を必須にしない。CI で黙って飛ばさない |
| D52 | 合流点（endpoint / table）の線は役割の対（path / query / body / response / status / row）ごとに必ず親 1 本。D41（名前で全部写るなら親 1 本）は言語の中の線だけ。子を宣言していない側の子は写ったとみなす | D41 を合流点に当てると、受ける側だけにある必須の子（`occurredAt`）の線が消え、食い違いが検出されない（§7 #1） |
| D53 | 「細かい方が勝つ」（D50）の掃除は join の後。group にするのは接頭辞ではなく file と `meta.go.pkg` の被覆で判定。呼び出しでない参照（定数の import、コールバック渡し、overrides）は、向き付きの箱の対に項目の線が無ければ `_` の項目と線を残し、残った数をサマリに出す | 合流の前に掃除すると v1 の api-link の線が残って二重になる。classify で `schema:` / `type:` になった Go の箱を取りこぼす（§7 #4） |
| D54 | 名前は手で組んだ例に合わせる（§7 #2 の表）。runtime は アダプタ ＞ upgrade。**画面の箱（page / layout）は静的エクスポートでも `browser`**（利用者が見ているもの。D42 改訂と 8-1 の実装に合わせる）。`build` に置くのは `'use client'` の無い部品（ビルド時に描画されるもの）だけ | 例は wiring のテストで固定済みで、アダプタの出力と比べる正。8-1 の実装で、画面を build に置くと D42 改訂（画面はブラウザで動く）と矛盾することが分かった |
| D55 | 関数の箱の id は `fn:<名前>`。ただし、ファイルの export がその関数 1 つで、名前がファイルの lib 名と同じなら v1 の id（`lib:fetcher`、kind helper）のまま | 手で組んだ例（`lib:fetcher`）と D47（`fn:`）の両方を満たす規則。メモと差分のキーが変わらない |
| D56 | 関数の箱の `group` は、置き換えた v1 の箱の id（ディレクトリではない）。v1 の箱を group にするのは、その export が**全部**関数の箱になったときだけ | メモ・差分・8-3 の畳みを v1 の id で引ける。定数の export を持つファイルの箱が消えない。例の `group`（ディレクトリ）は比べる対象外なので 8-3 で直す |
| D57 | 型の照合（detectBroken）は endpoint・table に触れる線だけ。body の無い応答（`out/status`）→ `ret_n` は照合しない | docs/15 §3.5「切れるのは合流点」。言語の中の線は構造的部分型で、送る側にだけあるプロパティが error になる。fetch の `Response` と integer を比べて誤った error が出た |
| D58 | 起動の links（`in/html` / `in/call` / `in/props` / `in/r` → `call_n` / `render_n` / データ由来の link が無い `out/return`）は `crude`。起動の項目が無い箱（引数を持つ関数）は引数の全部が起点。残った `_` は `in/_` → `out/_` と `in/_` → 全部の out を crude で足す。例の 2 本（`route:/`・`fn:getToday`）も crude に直した | §7 #3 の規則どおり。`_` の links が無いと fixture-repo の `route:/` から `schema:RaceItem` が光らない |
| D59 | 合流点で、受ける側の**必須の役割**（requestBody が required など）を呼び出し元が丸ごと送っていないときは、呼び出し元の親の項目 `call_n` から `endpoint#in/<役割>` へ線を 1 本引き（via http）、`broken: [{ path: "", level: "error", reason: "送る側に無い（必須の body）" }]` を付ける | 役割ごとの欠けは子の照合（線の端どうし）では出ない。線が無いと赤くする場所が無い。path が空なら線そのものを指す（`detectBroken` の相対パスの規約どおり）。fixture-poly の PushToggle → POST /push/subscriptions で見つかった |

## 8. 実装結果（Phase 8-2a。2026-11-09）

### 8.1 できたもの

- core: `paths.ts`（パスの正規化を api-link から移した。`[id]` / `[...slug]` も扱う）、`v2-parts.ts`、`merge-v2.ts`（mergeV2・cleanupV2・coverageV2）、`join.ts`（クライアント側の endpoint。D52 の役割ごとの親 1 本）、`broken-v2.ts`（detectBroken をパイプラインで。D57）。`buildGraph()` の結果に `v2Adapters`（サマリ）
- `extractors/ts-types`（新規。ts-morph 内蔵の `ts`。依存は足していない）: 画面・部品・hook・関数の箱、呼び出し（`call_n` / `ret_n`）・render・戻り、起動の links、runtime と複製、HTTP の呼び出し。解析は ts-imports と共有（`analyzeTsRepo`、キャッシュ付き）。CLI の順は ts-imports の直後
- openapi: `v2.ts`（endpoint の 4 口と項目。docs/16 §5 の表）
- CLI: build のサマリに言語アダプタの自動率と合流の数（`formatAdapterSummary`）
- 例 `examples/fixture-poly.today.v2.json`: `meta.http` を `call_1` の項目と子へ移した。起動の links 2 本を crude に（D58）

### 8.2 数字（fixture-poly。テストで固定）

| 項目 | 値 |
|---|---|
| 項目 | 292（unknown 70） |
| 線 | 109（項目の単位 40 / 箱の単位 69、うち呼び出しでない参照 4） |
| links | 92（exact 13 / crude 56）、不透明な箱 15 |
| 合流 | endpoint と結んだ HTTP の呼び出し 5（結べないもの 0）、group にした v1 の箱 4、置き換えた箱の単位の線 28、broken のある線 1 |
| 受け入れ（§7 #6、`adapters-acceptance.test.ts`） | 別名表は空。例の箱 10 個がすべてあり kind・runtime も一致。言語の中の線は (箱, 箱, via, reply) が一致、合流の線 5 本は項目の参照まで一致、例に無い余分な線 0（許可表も空）。validateGraphV2 のエラー 0 |
| 食い違い | POST /transactions の body で `amount:warn`・`occurredAt:error`。全体は今 1 本（Go 側は 8-2b で増える） |
| 性能 | build の中で ts-types 143ms。合成 150 ファイルで ts-imports ＋ ts-types 約 0.9 秒（テストの上限 5 秒 / 30 秒） |

fixture-repo は 項目 132（unknown 56）、線 58（項目 26 / 箱 32、うち参照 14）、links 44（exact 3 / crude 38）、合流 0、group 1。
docs/15 §7 の見積り（項目 90%・線 80%）との比較: 項目の型が決まった割合は 76%、線が項目の単位まで下がった割合は 37%。箱の単位の線の多くはアダプタの無い所（Terraform と Go。Go は 8-2b）。

### 8.3 決めたこと（実装中。D55〜D58 のほか）

1. HTTP の呼び出しの子: 呼び先が箱でない fetch は役割の子だけ（`call_1.input`）。ラッパーの init の項目は `body` に置き換え、`call_n.body → ラッパー#in/init`。`call_n.query` の言語の中の線は呼び先のパスの引数（`fetcher#in/url`）へ
2. 呼び出しでない参照: ts-types が `_` の線を引く（相手は ts-imports と同じ。同じファイルの非 export の宣言も推移的にたどる）。upgrade の線のうち group になる v1 の箱に付いて残ったものは、相手がアダプタの箱でなければ中の関数の箱へ付け替え、アダプタの箱なら消す。配信の線は画面の `in/html` へ付け替える
3. runtime: どの閉包にも入らないファイルはアダプタでは決めない。画面は自分は browser のまま、複製のどちらを描くかは server component の文脈（server / build）で選ぶ
4. v2 の印: `project.generator.v2 = "upgrade"` を残し、`adapters: [...]` を足した。ビューアの警告を畳む動きは今のまま（8-3 で見直す）

### 8.3b レビューの指摘で決めたこと（コードレビュー 10 件・セキュリティ 2 件＋1 件、2026-11-09）

1. **掃除の規則の改訂**（D50・D53）: group になった v1 の箱に残った線は消さない。付け替え先は、実際に参照している中の関数の箱だけ（手がかりは `refs` → HTTP の `meta.http` が合うもの → 合流できなかった呼び出しを持つ箱の順）。決められなければ中の全部へ付け替えて `undetermined` に数える。「相手がアダプタの箱なら消す」は廃止（合流できなかった呼び出しや overrides の線が消えていた）。group に入れるのは v1 の箱の export になっている箱（と複製）だけ
2. **overrides を v2 にも当てる**: docs/13 §3.5 に書いた。v1 の kind → v2 の via の読み替えは uses → call / return / render / props / sql、http → http / call / return、schema → sql、deploy → deliver / http、flow → http / event / deliver
3. **上限**: openapi も `adapters.maxItems` を 1 操作あたり（request と response の合計。4 口への写しは数えない）で数え、超えたら警告して打ち切る。allOf のまとめは schema ごとに 1 回（菱形で倍々にならない）。ts-types は repo の外で宣言されたプロパティ（React の DOM の属性など）と上限で切ったプロパティを、子の無い不透明な項目 `props`（型は引数の型）にまとめる
4. **HTTP の呼び出しの判定**（D45 の補足）: `fetch` と `api.callers` は名前で、自動検出したラッパーは宣言が repo の中にあるときだけ、get / post などの動詞は api-link のクライアントファイルの中だけ。パスより後ろの引数に関数を渡すもの（`app.get(path, handler)`）は呼び出しにしない
5. **型の id**: docs/16 §3 の表（`type:<file>~<名前>`）
6. **パスの正規化**: 正規表現を全部線形にした。2048 文字を超えるパスは正規化も照合もしない（1 回だけ警告）。合流はパスを 1 回ずつだけ正規化する
7. **YAML の別名**: openapi の YAML の別名の展開は yaml の既定の上限（100）で止める（無制限だと別名を倍々に重ねた YAML で指数時間。範囲外で見つかったものを一緒に直した）
8. 見つかったこと（直していない）: アダプタだけが出す id（`fn:…`）を overrides の `remove` に書くと、v1 の側は「削除しようとしたノードはありません」と警告するが、v2 では消える。警告が実態と合わない → 8-4（`validate --strict` と一緒に）

### 8.4 残り（8-2b 以降）

- App Router の `route.ts`、クラスの部品（未対応）
- export したオブジェクトリテラルのメソッド（fixture-repo の `api.getRaces`）。fixture-repo の HTTP の呼び出しが項目の単位にならず、合流が 0 本 → 8-2b
- 見つかったこと: PushToggle は body を送らないのに、POST /push/subscriptions は requestBody が必須。役割ごとの欠けは子の照合では出ないので 8-2a では出していない → D59 で表し方を決め、8-2b で実装する
