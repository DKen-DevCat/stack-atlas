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

- `extractors/go-types/helper/main.go`（標準ライブラリだけ。`go.mod` も同梱し外部依存なし、go 行は低く `go 1.21`）を helper のディレクトリで `go run` し（8-2b のレビューで、1 回 `go build` した実行ファイルを直接動かす形に変えた。§9.6 の 1）、解析対象のモジュールのパスを引数で渡して JSON を受け取る。環境は **`GOFLAGS=-mod=readonly GOPROXY=off GOWORK=off GOTOOLCHAIN=local CGO_ENABLED=0`**（解析対象の go.mod / go.sum を書き換えず、ネットワークもツールチェーンの取得もしない。§7 #7）。`go` が無いときは警告して何もしない（既存の `go` 抽出器の箱の単位が残る）
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
| 8-2b（完了。§9） | go-types（helper、自前の importer、net/http・認証・SQL のレシピ、型の表）、sql が table の 3 口と項目を出す、join の endpoint（サーバー側）と table、受け入れ条件のテスト（§7 #6）、CI で go を必須に、サマリ。8-2a の残り（§8.3）: export したオブジェクトリテラルのメソッドを関数の箱にする（fixture-repo の `api.getRaces`）、役割ごとの欠け（必須の body を送っていない）を broken で表す |

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
| D65 | `types[]` の同じ id は、契約（openapi・sql）が言語アダプタ（ts-types・go-types）に勝つ。同じ側どうしは先に出たものを残す。負けた側の `file:line` は `meta.copies` に足す | 契約は両側が共有する語彙（手で組んだ例は OpenAPI の `type:Transaction`）。Go の型の場所も失わない |
| D66 | table の読む線（`#read/row` → `fn#in/row`、via sql、reply）は**受ける側の子だけ**を比べる（SELECT の射影）。受ける側だけにある SQL の式（`meta.expr`。`SUM(amount)`）も error にしない。UPDATE は送る側（SET）の子だけ、INSERT は両側（必須のカラムの欠けは error） | 部分集合の SELECT で「受ける側に無い」の誤った error が出る |

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

## 9. 実装結果（Phase 8-2b。2026-11-09）

### 9.1 できたもの

- `extractors/go-types`（新規）: 標準ライブラリだけの helper（`helper/`、go 1.21、依存なし）を `go run`（レビューで `go build` した実行ファイルに。§9.6 の 1）。自前の ImporterFrom、型の表、レシピ（net/http・認証・SQL・chi / gin / echo / fiber）、host の閉包、`refs`（関数ごとに参照するモジュール内のパッケージ）。go が無ければ警告して空（`STACK_ATLAS_REQUIRE_GO=1` なら失敗。CI は必須）
- `extractors/sql`: table の 3 口（key / write / read）とカラムの項目（D66 の照合のため `row` の親）。契約（`v2Role: contract`）
- core の合流: サーバー側（`req/<役割>` → handler の役割の項目、応答 → `res/body`、`WriteHeader` → `res/status`、login の分岐）と table（WHERE → `key/<col>`、INSERT / UPDATE → `write/row`、`read/row` → 関数の `in/row`）、D59（必須の役割の欠け）、OpenAPI の無いときの直接の合流
- ts-types: export したオブジェクトリテラルのメソッドを関数の箱に（`fn:api.getRaces`）
- 例: POST /transactions にも login の分岐（§7 #11）、`today.go` と InsertTransaction の host（§9.3 の 1）

### 9.2 数字（テストで固定）

| | fixture-poly | fixture-repo |
|---|---|---|
| 項目（unknown） | 550（61。型が決まった割合 **89%**） | 176（55。69%） |
| 線（項目の単位 / 箱の単位、うち参照） | 143（106 / 37、うち 12）。項目の単位 **74%** | 68（46 / 22、うち 4） |
| links（exact / crude）・不透明な箱 | 183（43 / 110）・6 | 57（13 / 41）・4 |
| 合流: クライアント側 | 5（必須の役割の欠け 1） | 6（handler へ直接。3 メソッド × @server / @browser） |
| 合流: サーバー側 | 7（handler の無い endpoint 1 = GET /transactions、login 7） | 0 |
| 合流: table | 8 | 0 |
| group / 置き換えた線 / 付け替え先を決められない線 | 13 / 66 / 0（2026-11-09 変更（8-2b レビュー）: 中が 1 つの group は決められた側に数える。以前は 11） | 2 / 32 / 0 |

docs/15 §7 の見積り（項目 90%・線 80%）に対して、fixture-poly は 89% / 74%。残りの箱の単位の線はインフラ（Terraform）と、中が `main` 1 つの `cmd/*` の group。

fixture-poly の broken は 4 本（受け入れテストで固定）:

1. `PushToggle#out/call_1 → POST /push/subscriptions#in/body`: `""`・error（D59。必須の body を送っていない）
2. `createTransaction#out/call_1.body → POST /transactions#in/body`: `amount`・warn、`occurredAt`・error
3. `handleToday#out/resp → GET /today#res/body`: `entries.occurredAt`・error
4. `handleEntries#out/txs → GET /entries#res/body`: `occurredAt`・error（見つかったこと。Go の `[]Transaction` と OpenAPI の `Entry[]`）

受け入れ（§7 #6）: 別名表は空、例の箱（TS 8・Go 4・endpoint 2・`schema:transactions`）の kind / runtime / host が一致、言語の中の線と合流点の線（クライアント・サーバー・table）が項目の参照まで一致、例に無い余分な線 0（許可表も空）、例の線の broken は例の 3 件と一致、validateGraphV2 のエラー 0。`route:/` のクリックで endpoint → handler → ListByDate → transactions → 戻りまで項目の単位で光り、Scheduler → notify → push_subscriptions も光る。

### 9.3 go-types と sql の v2 で決めたこと（8-2b の前半）

1. **fixture と例**: `today.go` は map のリテラルを変数 `resp` に入れてから Encode する形に直した（規則「変数なら `out/<名前>`、式なら `out/response`」と例の `out/resp` の両方が成り立つ）。`store.InsertTransaction` は cmd/api と cmd/gmail-webhook の両方から届くので、規則どおり host を空にして `meta.hosts` に 2 つの Lambda を並べ、例もそう直した
2. **閉包の辿り方**（host を決める）: 呼び出し、関数の値の参照（`HandleFunc` に渡した handler）、interface への変換（呼び出しの引数と return。`ListenAndServe(h)` → `h.ServeHTTP`）の 3 つ。「型を作れば全部のメソッドに届く」は採らない（ListByDate まで 2 つの入口になる）
3. **標準ライブラリ**: `importer.ForCompiler("source")` ではなく、同じ ImporterFrom の中で GOROOT のソースを並列に読む（srcimporter は net/http だけで約 1.7 秒、自前は約 0.4 秒）。ソースから読む・全体で 1 つを共有する・`go list` を使わない、は §3.3 のまま
4. **replace と vendor**: replace の先はモジュールの根の中だけ読む（`../x` は警告して読まない）。モジュールへの置き換えは外部。vendor と replace の struct は型が分かるので展開する。unknown にするのは標準ライブラリの名前付きの型（基本型のものを除く）・interface・解けない外部の型。箱にするのは解析対象のモジュールの関数だけ
5. **id**: モジュールの根のパッケージは `fn:<module の最後の要素>.<名前>`。名前が衝突したメソッドだけ `.<型>.<名前>`、関数はそのまま。kind は classify に関係なく常に `fn`、runtime は常に `server`
6. **リクエストの項目**: id は常に `r`（name は実際の引数名）。path は string に子を付ける形、query は url.Values で子は optional。`FormValue` は query の子（`meta.form`）。gin / echo の Context も `r` と同じ扱い
7. **戻り値と error**: `(T, error)` は T、error だけなら `out/return`（type error、nullable）。多値は `r0` / `r1`（名前付きの戻りならその名前）
8. **状態コード**: 400 以上の `WriteHeader` と `c.JSON(4xx)` は数えない（middleware の 401 も）。`http.Error` は無視。複数のコードは `A | B`。status の links は起動の項目と、その前に戻った `ret_n` から crude
9. **SQL の項目**: 関数ごとに 1 つの数え方で `query_k` / `insert_k` / `update_k`。DELETE は query、UPDATE は update と `meta.sql.where`、RETURNING は row。プレースホルダの値は、SQL の定数を渡した呼び出し（か並び）の SQL より後ろの式を $1, $2 … とみなし、数が合わなければフィールドとカラムを名前で照合して crude。カラムの型は sql 抽出器の `readTables` で埋め、cast があればその型（`occurred_at::date` → datetime）
10. **table の口**: key は全部のカラム（例は WHERE のカラムだけ）。write/row の子は DEFAULT・serial・identity・nullable のものを optional、read/row の子は NOT NULL でなければ nullable。`in/row` の子は SELECT したカラムだけ（D66 で照合を受ける側に限る）
11. **links の確かさ**: 1 回だけ代入した変数を経由しても exact。箱でない関数（`len` など）を通したものは crude（ts-types は exact のまま通す。言語で揃っていないのは既知）
12. **呼び出しでない参照**: TS の `_` の線（D53）は Go では引かない（引くと `Server.Handler` から全部の handler が光る）。ルートは合流がつなぐ
13. **フレームワーク**: chi / gin / echo / fiber はルートの登録のほか、Param / Query / Bind 系 → in、`c.JSON` → out も読む。フレームワークはルーターの変数（`gin.Default()` など）から決める
14. **go が古いとき**: helper の go 行より古い go は「go が無い」と同じ扱い（警告）。それ以外の helper の失敗は抽出器のエラー
15. **決定的な出力**: GOARCH は amd64 に固定、警告は並べ替えてから出す
16. **時間**: helper の解析 0.6〜0.9 秒、`go run` を含めて約 1.4 秒（初回のコンパイルで約 2.2 秒）。テストの上限は helper 3 秒・全体 60 秒

### 9.4 合流で決めたこと（8-2b の後半）

1. **login の形は例に合わせる**: 分岐は endpoint が持ち、`when: { login: true }` は endpoint の中の `in/* → req/*` の links に付ける（線には付けない）。`meta.auth` は middleware の関数名と見るヘッダ
2. **handler の選び方**: method の無いルートは ANY、そのうえで最も具体的なもの。複数なら v1 の deploy のエッジ（endpoint を受け持つインフラ）と host・`meta.hosts` が合うもの。それでも複数なら全部と結んで警告。対象は項目まで下がった箱で group にならないものだけ（go が無いときは箱の単位の線のまま）
3. **サーバー側の線**: 役割ごとに親 1 本 `req/<役割> → in/<役割の項目>`（via call）。役割の項目が無い handler は入口の項目（`r`、無ければ役割・ret・row 以外の最初の項目）へ。endpoint に無い役割は警告。合流した箱の対は行きの線を引けたときだけ数える
4. **handler の無い endpoint は数えるだけ**（実装が別の所にありうる）。OpenAPI に無い handler のルートは警告して数える
5. **OpenAPI の無いとき**は endpoint を合成しない（§3.4 の route の行は未実装）。endpoint に合わない呼び出しを、ルートを持つ handler と直接結ぶ（行き via http、戻りは応答の項目か `return` から `ret_n`）。endpoint・table に触れないので broken は書かない（D57）
6. **table**: UPDATE の WHERE は項目が無い（`meta.sql.where` だけ）ので線にしない。WHERE の無い SELECT は `query_n → table#key/_`。JOIN の 2 つ目以降のテーブルは結ばない。テーブル名は大文字小文字を区別せず、引用符を外し、`schema.table` は最後の段で引く
7. **group の host**: `meta.hosts` を持つ関数は group の host を受け継がない
8. **overrides の sql の線**（`handler:cmd/notify → schema:push_subscriptions`）: `meta.sql` でそのテーブルを使う中の関数へ付け替え、無ければ入口（`main`）へ
9. **go-types の refs**: helper が関数ごとに参照するモジュール内のパッケージを、v1 のパッケージの箱 id にして渡す（付け替え先を決められない線 15 → 11、`push.Send` への付け替え 36 → 8）
10. **D59 の対象**: body（required）と query（必須のパラメータがあるとき）。path は URL なので欠けない
11. **オブジェクトのメソッドの id**: `fn:<オブジェクト>.<メソッド>`（`fn:api.getRaces`）、衝突したら `fn:<file>~api.getRaces`。プロパティが全部関数のときだけ箱にする。`api.X` の呼び出し・参照はメソッドの箱へ
12. **table の links の既存の不具合**: `_` の links を書くと既定の key → read が消えていた。既定を先に書き出し、write → read はつながない
13. **要約**は 3 行（自動率 / 合流のクライアント・サーバー・table / 掃除）

### 9.5 見つかったこと（upgrade-wiring に固定）

- テーブルから下流だけたどると、読んだ行が表示する部品まで届く（35 / 下流 21。以前は 14 / 13）。画面と INSERT・DELETE の側は光らない
- group になって消えた箱の差し替え: `handler:internal/api` の起点は `fn:internal/api.handleToday`、`handler:cmd/notify` は `fn:cmd/notify.main`、fixture-repo の `lib:apiClient` は `fn:api.getRace@server`
- `route:/push` をクリックすると、型だけの参照の `_` の線（D53）で `push.Send` が光る
- fixture-repo の `post(path, body)` ラッパーの呼び出しは `path` の子しか出ない（既知の動詞の扱い）
- build の抽出器ごとの行で、ts-types・go-types は v2 だけを出すので「ノード 0」と出る（見た目だけ）

### 9.6 レビューの指摘で決めたこと（セキュリティ 6 件・コードレビュー 10 件、2026-11-09）

セキュリティ（実測は §9.7）:

1. **helper の動かし方**（S1・S6）: `go run` をやめ、1 回 `go build` した実行ファイルを直接動かす（`go run` は時間の上限で `go` だけが止まり、helper が ppid=1 で動き続けていた。標準出力の上限も同じ）。置き場は利用者ごとのキャッシュ（`$XDG_CACHE_HOME`・`~/Library/Caches`・`~/.cache` の `stack-atlas/go-helper`、無ければ `<tmpdir>/stack-atlas-go-<uid>`、それも駄目なら mkdtemp）で、0700・持ち主が自分・シンボリックリンクでないことを確かめる。実行ファイルの名前は helper のソースと go のバージョン・GOROOT・OS・アーキテクチャのハッシュ（`stack-atlas-go-helper-<hash>`）。時間と出力の上限は実行ファイルに掛けて SIGKILL、helper 自身も `-timeout` で止まる（最後の守り。終了コード 3）。動かすときは GOROOT を今の go のものにする。ビルドは cwd が helper のディレクトリ、環境は D48 のまま、上限は 120 秒（timeoutMs がそれより長ければそちら）。HOME も GOCACHE も無いときの GOCACHE は同じディレクトリの `gocache`（共有の固定の名前 `<tmpdir>/stack-atlas-go-cache` をやめた）
2. **型の文字列**（S2a）: 書き出す長さを型の値ごとに 1 回だけ見積もり（無名の struct の入れ子は同じ型を何度も書くので倍々になる）、256 文字を超える型は外側の形だけ書く（`struct{…}`・`*struct{…}`・`map[…]…`・`func(…)`）。短い型は types.TypeString のまま
3. **定数の文字列の連結**（S2b）: go/constant は連結を木のまま持ち、constant.StringVal で平らにする。**go/types も `len(A)`・比較・添字で平らにする**（見つかったこと。constString を直すだけでは足りない）ので、型の検査の前に AST で長さを上から見積もり（名前を挟んだものも、名前で。依存を先に検査して import 先の表を使う）、64KB を超える `+` の両辺を空の文字列に置き換えてから検査する（実行しないので値は使わない。警告する）。解析の側も平らにする前に同じ見積もりで断る。SQL として読むのは 64KB まで、定数の名前で参照した SQL は宣言ごとに 1 回だけ読む。残る量: 64KB 以下の別々の定数を多数持つソースは、その合計まで平らにする（時間の上限が最後の守り）
4. **SQL の計算量**（S2c）: 式の項目の文字列は strings.Builder、`uniqueID` は名前ごとに次の番号を覚える（`SELECT a, a, …` で番号を 2 から数え直す O(n²) もあった。見つかったこと）
5. **sql 抽出器**（S3）: 型の括弧は `[^()]*` を内側から繰り返して消し、256 文字を超える型は unknown（カラムの型の文字列も 256 文字で切って `…`）。readTables・PRIMARY KEY・ADD COLUMN のカラムの照合は名前の表。行番号は前から数え、閉じない `(` の CREATE TABLE の後はその末尾から次を探す（どちらも O(n × 表の数) だった。見つかったこと）。1 ファイル 5MB を超えるマイグレーションは警告して読まない。go-types の fillSqlColumns も名前の表
6. **合流の上限**（S4）: 1 つの endpoint・呼び出しに同じ具体性で合う相手（handler・endpoint）が 8 を超えたら結ばず、数と最初の 3 つだけを 1 回警告する（8 以下は従来どおり全部と結んで警告）。警告の文に並べるのは 20 件まで（残りは数）。handler のルートと endpoint のパスは前もって分け、具体性も 1 回だけ計算する
7. **import パス**（S5）: 空の段・`.`・`..`・絶対パス・バックスラッシュ・NUL を含む import パスは断る（外部のモジュールと同じ扱い）。標準ライブラリは、シンボリックリンクを解いた実体が GOROOT/src の中にあるものだけ読む

コードレビュー（10 件とも実在を確かめた。テストで固定）:

8. **SQL のスキーマを helper に渡す**（C2・C4・C5 の土台）: go-types は先にマイグレーションを読み（sql 抽出器の readTables）、テーブル → カラム（定義の順）を標準入力で helper に渡す（`-schema-stdin`。32MB まで）。helper は FROM・JOIN・`UPDATE … FROM`・`DELETE … USING` のテーブルと別名を読み、カラムのテーブルを修飾（別名）→ 1 つだけのテーブル → スキーマでそのカラムを持つ 1 つ、の順に解く
9. **別名**（C1）: `name AS user_name` の項目は id が別名、元のカラムを `meta.sql.column` に残す（型もそのカラムから）。table の線の照合は子をカラムの名前で組にする（path は送る側の子の id）
10. **JOIN**（C2）: カラムごとのテーブルを typeRef（`table:<表>`）に、行の `meta.sql.tables` に文のテーブル。読む線（`table#read/row → fn#in/row`）は、JOIN した行ならそのテーブルのカラムだけを比べる（決められなかったカラムも比べない）。別のテーブルの WHERE のカラムは最初のテーブルの key に結ばない。2 つ目以降のテーブルと線を引かないのは §9.4 の 6 のまま
11. **大文字小文字**（C3）: table の線の子は大文字小文字を区別せずに組にする（引用符の無い識別子は畳まれる。引用符で区別した Postgres の `"UserID"` と `userid` も同じとみなす近似）
12. **WHERE のカラムの候補**（C4）: 副問い合わせ（`(SELECT …)`）の中のカラムとプレースホルダは外の述語のものにしない。型付きのリテラル（`interval '1 day'`）・`CAST(x AS 型)`・`extract(epoch FROM x)` の欄・`current_date` などを除く。スキーマがテーブルを知っていてカラムが無ければ候補にしない（`interval` は前からキーワードで、副問い合わせのテーブル名・カラムが実際の幻のカラムだった）
13. **`*`**（C5）: `*`・`t.*` はスキーマで広げてから Scan を引数の順に写す。広げられなければ行の `meta.sql.star` と位置（`starAt`）を残し、そこから先の Scan の引数は行の全体から crude。TS の側（fillSqlColumns）も、他の子があってもその位置に広げる（1 つの `*` につき adapters.maxItems まで。超えたら警告）
14. **箱 id の衝突**（C6）: 言語アダプタの部分グラフを足すとき、別の持ち主（別の言語アダプタか、同じアダプタの別の repo）が先に出した id の箱は、後の方を `<種類>:<file>~<名前>`（TS の衝突の退避と同じ形。file が無ければ `~2`）にし、その部分グラフの線・refs・groups の参照も付け替えて警告する。契約（openapi・sql）は今までどおり id で合わせる
15. **複数の入口**（C7）: 2 つ以上の入口から届く関数は、入口のインフラが分からなくても `meta.hosts` を空の配列で書く（mergeV2 が group の host を受け継がせない）
16. **接頭辞**（C8）: chi / fiber の `Mount("/p", sub)`（sub はルーターの変数か、ルーターを返すモジュールの中の関数の呼び出し。handler なら `/p/*`）と、net/http の `mux.Handle("/p/", http.StripPrefix("/p", sub))`（sub の mux のルートに `/p`。StripPrefix の無いサブの mux も親子にして認証を受け継ぐ）。接頭辞はルーターの親子で持ち、全部の関数を読んでから付ける（登録の順によらない）。定数でない接頭辞・決められないルーターは警告。gorilla/mux の PathPrefix は未対応
17. **直接の合流の警告**（C9）: OpenAPI の無い直接の合流でも、複数の handler と結ぶときは joinHandlers と同じ警告。8 を超えれば 6 と同じく結ばない
18. **正規表現**（C10）: helper の正規表現はパッケージで 1 回だけ作る（関数の中で MustCompile しないことをテストで固定）
19. **付け替え先**（§9.4 の補足）: 中が 1 つだけの group は、付け替え先が決まっているものとして数える。fixture-poly の付け替え先を決められない線は 11 → 0（11 は全部、中が main 1 つの `cmd/*` の group に付いた線だった）。ほかの数（§9.2）は変わらない

### 9.7 敵対的な入力の実測（2026-11-09、darwin/arm64・go 1.27.3・Node 22。セキュリティのレビューの入力）

| 入力 | もと | 直した後 |
|---|---|---|
| 無名の struct の入れ子（深さ 20 / 22） | 1.5 秒・出力 89MB / 7.3 秒・出力 357MB（標準出力の上限を超える） | 0.06 秒・2KB / 0.3 秒・2KB |
| 倍々の定数（16 文字 × 2^24、`Println(A24)`） | 3.0 秒・1.1GB | 0.16 秒・72MB |
| 倍々の定数（16 文字 × 2^26、`len(A26)`。go/types が平らにする） | 16.0 秒・1.5GB | 0.14 秒・72MB |
| SQL の式 `a+a+…`（10 万項） | 5.0 秒（CPU 24 秒） | 0.16 秒（64KB を超えるので SQL にしない） |
| sqlWireType（閉じない `(` × 10 万） | 15.8 秒 | 1ms 未満 |
| readTables（4 万カラム） | 20.9 秒 | 0.1 秒 |
| 合流（`/{x}` の handler 2000 × endpoint 2000） | メモリが尽きる | 1.6 秒・線 0・警告 1 件（133 文字） |
| `go run` の時間の上限 | helper が ppid=1 で残る | 実行ファイルを SIGKILL（残らない） |

