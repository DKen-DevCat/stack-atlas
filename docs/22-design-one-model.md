# 22. 設計: モデルを 1 つに（Phase 9）

作成: 2026-11-10。**状態: 下書き（独立の設計レビューの前・ユーザーの確認の前）。** ユーザーの決定（2026-11-10「従来設計の作業が終わったらモデル 1 つに変えましょう」。Rust は使わない）を受けた設計。8-7（docs/18 §11）と 8-8a・8-8b（docs/21）が main に入っている前提で書く。決定の番号は **D140 から**（D114〜D122 は 8-7、D123〜D134 は 8-8）、質問の番号は **Q22 から**。コードは 1 行も変えていない（この文書とロードマップだけ）。

困っていること: 同じことをする仕組みが 2 つずつある。

- **モデルが 2 つ**: 抽出器は v1（箱と線）を出し、`upgradeGraph` が v2（箱・口・項目・線）に直し、言語アダプタの v2 と合流させる。3D の地図は、その v2 を `projectMap` で v1 の形に写し直して描く（v1 → v2 → v1）
- **まとめ方が 2 つ**: 地図は `group × runtime`（`projectMap`）、配線図は包含の木の切り口（8-8 の `foldView`）
- **抽出が 2 通り**: 型 API で読む言語アダプタ（ts-types・go-types）と、名前や正規表現で当てる抽出器（ts-imports・go・api-link）。しかもアダプタは後者を import している
- **直す入力が 5 つ**: overrides の v1 のキー、overrides の `v2:`、手書きの部分グラフ、flows.yaml、views.yaml。同じ直し（箱を足す・線を足す・host を決める）を 2〜4 か所に書ける

## 1. 結論

- **graph.json が包含の木を持つ**。トップに `containers[]`（repo・ディレクトリ・ファイル・パッケージ）、箱に `parent`。箱の id は 1 つも変えない。group だった v1 の箱の id は、そのまま入れ物の id になる（メモ・overrides・flows・`?sel=` のキーが生きる）
- **地図と配線図は、同じ graph の 2 つの切り口**になる。地図は「地図の単位（`unit`）の入れ物を閉じた切り口」での `foldView` を、薄い写し `mapScene` で 3D の Viewer の入力にしたもの。`projectMap` の独自のまとめ方と `graph.v1.json` は無くなる
- **抽出は、型 API と契約（OpenAPI・SQL・IaC）だけ**にする。ts-imports・go・api-link の 3 つは「消す」のではなく、アダプタが借りている解析をアダプタへ「移す」。名前で当てていた規則のうち、残すものは**レシピ**（名前・出所・明示のキーを持つ）にし、残さないものは線を引かずに**未確定の一覧**に出す
- **v1 の段と `upgradeGraph` を無くす**。残りの抽出器が v2 の部分（箱・入れ物・線）を直接出す。upgrade がしていた横断の処理（host の配り・runtime・既定の口。約 300 行）は v2 の上の「置き場の段」へ移す
- **直す入力は 1 つの形**にする。今の `v2:` の語彙を正にして、入れ物（`containers`）・始点（`views`）・型（`types`）を足す。キーは「箱か入れ物の id」。古い形（v1 のキー・flows.yaml）は読み込みで新しい形へ写す（警告つき）
- **段取りは 7 段**（9-1a → 9-1b → 9-2a → 9-2b → 9-2c → 9-3 → 9-4）。どの段も「3 つの fixture の数が基準の表（§6.1）と同じ。違う所は理由つき」と「実リポジトリは CLI で件数だけ」を合格にする。書き直しはしない（1 段ずつ寄せる）
- 減る行は **約 2,500〜3,000**（見積り。テストは別）。ビルドの時間はほとんど変わらない（型検査が 57%）。速くするのは 9-4 のキャッシュ

```
今
  抽出器 13 ─────▶ v1 の部分 ─┐
  （うち 3 つは名前で当てる）   ├─▶ v1 の graph ─▶ upgradeGraph ─┐
  overrides（v1 のキー）・flows ┘        │                       ├─▶ 合流 → join → 補い ─▶ graph.json（v2）─▶ 配線図
  言語アダプタ 2 ─▶ v2 の部分 ──────────┼───────────────────────┘                            │
  （上の 3 つを import）                  └─▶ graph.v1.json（ビューアは読まない）               └─▶ projectMap（v2 → v1 の形）─▶ 3D の地図
  overrides の v2:・手書き・views.yaml ──▶ 補いの段

目標
  抽出器 12 ─▶ v2 の部分（箱・入れ物・線）─▶ 合流 → join → 置き場 → 継ぎ当て（1 つの形）─▶ graph.json（v2 ＋ 木）
  （アダプタ 2 ＋ 契約・IaC・画面）                                                          │
                                                                    foldView（木・切り口）◀──┘
                                                                      ├─ 利用者の切り口 ─▶ 配線図
                                                                      └─ 地図の切り口   ─▶ mapScene ─▶ 3D の地図
```

（「抽出器 13 ＋ アダプタ 2」が今の 15 個。）

## 2. 構造

### 2.1 木を graph に持つ

```jsonc
// graph.json（v2）に足す欄。ほかは今のまま
"containers": [
  { "id": "repo:web", "name": "web", "kind": "repo" },
  { "id": "dir:web/src/feature/spend", "name": "spend", "kind": "dir", "parent": "dir:web/src/feature" },
  { "id": "lib:web/src/feature/spend/request.ts", "name": "request", "kind": "group", "unit": "lib",
    "parent": "dir:web/src/feature/spend", "file": "web/src/feature/spend/request.ts" },
  { "id": "file:platform/openapi/today.yaml", "name": "today.yaml", "kind": "file",
    "parent": "dir:platform/openapi", "file": "platform/openapi/today.yaml" }
],
"nodes": [ { "id": "fn:getSpend", "parent": "lib:web/src/feature/spend/request.ts", … } ]
```

**形**

| 欄 | 中身 |
|---|---|
| `containers[].id` | 箱・型と**同じ名前空間**の id（重なったらエラー）。`#` は使えない（箱と同じ。`#` は箱と口の区切り） |
| `name` | 表示名。ディレクトリは最後の段、ファイルはファイル名、group は今の `groups[].name` |
| `kind` | 段の種類。**開いた文字列**（`repo`・`dir`・`file`・`package`・`group`。増えても型を変えない） |
| `parent?` | 親の入れ物の id。無ければ根の直下 |
| `file?` | その入れ物を表すファイル（今の `groups[].file` と同じ使い方） |
| `unit?` | **地図の単位の印**。値は地図での種類（今の `groups[].kind`。`lib`・`handler`・`schema` などの v1 の語彙）。これがある入れ物が「コードのまとまり」= 今の group |
| `nodes[].parent?` | 箱が直に入っている入れ物の id。無ければ根の直下（`file` の無い箱。`actor:user` など） |

8-8a の `Container { id, name, kind, parent?, memo? }` に `file`・`unit` を足した形。`memo`（メモのキー）は graph には書かない: id がそのままメモのキーになる（下の「id」）。

**id（D142）**

| 入れ物 | id | 理由 |
|---|---|---|
| group だったもの | **group の値そのもの**（`lib:web/src/feature/spend/request.ts`・`handler:internal/api`。v1 の箱の id） | メモ・overrides・flows・`?sel=`・差分が今このキーを使っている。fixture-poly の基準（13 group）で、group の値が箱の id と重なるものは 0 |
| ディレクトリ | `dir:<パス>`（箱の `file` と同じ書き方。複数 repo なら `<repo>/` 付き） | 人が継ぎ当てに書ける形にする。8-8a の `d:<パス>` より読める |
| ファイル（group の無い箱のファイル） | `file:<パス>` | 同上 |
| repo（複数 repo のときだけ） | `repo:<名前>` | 同上 |

- 作った id が箱・型・ほかの入れ物と重なったら、重ならなくなるまで末尾に `~` を足す（8-8a と同じ逃がし方）。手で書いた `containers` の id が重なったら**エラー**（今の `groups` は警告。名前空間を共有するので厳しくする）
- 8-8 の `?open=` の値（`d:<パス>`・`g:<group の値>`）は、9-1a のビューアが 1 回だけ読み替える（`d:` → `dir:`、`g:` を外す）。解けない値は今までどおり捨てる

**木は全部持ち、つぶすのは見る側（D143）**

- graph には、箱のあるディレクトリを根まで全部、箱のあるファイルを全部、group を全部（中が 1 箱でも）書く。fixture-poly の基準で 71 箱に対して入れ物 71（ディレクトリ 35・ファイル 23・group 13）
- 「子が 1 つだけの段をつぶす」「中が 1 箱だけの入れ物は出さない」「深さ 32 まで」は、配線図の畳みの都合なので `@stack-atlas/wiring` の `compactContainment` に置く（8-8a の `containmentOf` の後半をそのまま残す）。地図はつぶす前の木を使う（1 箱だけの group も地図の単位。基準で 13 group のうち 7 つが 1 箱）
- つぶした段の id は、いちばん深い入れ物の id にする（上の段に兄弟が増えても id が変わらない）

**誰が作るか（D144）**

| 段 | 作り手 |
|---|---|
| 9-1a | build の最後に `deriveContainers(graph)` が箱の `file`・`group`・`groups[]` から作って書く。関数は **`@stack-atlas/wiring` に 1 つ**（core は今も wiring に依存している。ビューアは core に依存しない） |
| 古い graph（`containers` が無い v2） | ビューアが同じ `deriveContainers` を当てる。build と同じ木になるので、古い graph でも入れ物の id・メモのキーが合う |
| 9-2a・9-2b | 言語アダプタが自分の箱の入れ物を直接出す（TS は `kind: file`、Go は `kind: package` とその下の `file`）。`deriveContainers` は `parent` の無い箱にだけ働く |
| 9-2c | 残りの抽出器も `parent`（ファイル）を出す。`deriveContainers` はディレクトリの段を埋めるだけになる |

- `deriveContainers` の規則: 箱に `group` があれば group の入れ物（`kind: group`・`unit` は `groups[].kind`・親は中の箱の共通のディレクトリ）、無ければ `file` の入れ物、`file` も無ければ根の直下。同じファイルに group の箱と group の無い箱が混ざるときは入れ物が 2 つ並ぶ（地図の単位を変えないため。基準では 0 件）
- **TS の group（ファイル）と Go の group（ディレクトリ）の粒の違い**は、9-2 でアダプタが `file`・`package` と書けば木の段の違いになり、畳む側は木をたどるだけになる。地図はどちらも `unit` で切るので変わらない
- **host は木に入れない**。「このファイルにある」と「この Lambda に載る」は別の関係で、1 つの入れ物の中に別の host の箱が混ざる（8-8 の「置き場で割る」）。host の箱（枠）にも `parent`（IaC のファイル）は付くが、畳む側（`readContainment`）は枠を木から外して読む（8-8a と同じ）
- 型（`types[]`）は木に入れない（配線図に置かないので、畳む対象でない）

**`group`・`groups` の扱い**

- 9-1a〜9-2c: build は今までどおり `group`・`groups[]` も書く（合流の中で使っている。古いビューアや差分の前の版も読む）。読む側は 9-1a で `containers` に替える
- 9-4: build が `group`・`groups[]` を書くのをやめる。読む側は「`containers` が無ければ `group`・`groups[]` から `deriveContainers`」を残す（古い graph を開く・差分の前の版）。**版は 2 のまま**（Q22）

**同時に直す所**（CLAUDE.md の規約）: `packages/schema/graph-v2.schema.json`（`containers`・`$defs.container`・`node.parent`）、`packages/schema/src/v2.ts`（`ContainerV2`・`NodeV2.parent`・`validateGraphV2`）、`docs/03-graph-schema.md`、`docs/16-graph-v2-contract.md`（§3 の「group になる」の段落を「入れ物になる」に、§8.2 の後に §8.3 `containers`）。`pnpm validate examples/race-site.graph.json` と、型とスキーマのずれのテストが通ること。

**検証（`validateGraphV2`）**: `id`・`name`・`kind` は必須。エラー = id の重複、箱・型と同じ id、無い `parent`、親の循環。警告 = 中に箱が 1 つも無い入れ物、箱の `group` と `parent` の食い違い（`group` の入れ物が祖先に無い）。ビューアは敵対的な入力でも開けるよう、8-8a の `cleanContainment`（無い親・循環は根に付け直す）を入口で通す。

採らなかった案:

- **id を `repo:file#symbol` に付け替える**: `#` は箱と口の区切り（docs/16 §3、`parseItemRef`）。メモ・overrides・flows・views のキーが全部切れる
- **木をビューアで毎回作る（8-8a のまま）**: ファイルかパッケージかは抽出器だけが知っている。入れ物にキーが無いので、メモも継ぎ当ても書けない
- **`groups[]` に `parent` を足して木にする**: 箱の `group`（1 段だけ）と二重になり、ディレクトリを「group」と呼ぶことになる
- **つぶした木を graph に書く**: 兄弟が 1 つ増えると id が変わり、`?open=` とメモが切れる

### 2.2 地図 = 畳みの段

**今**: `projectMap(graph)`（`packages/wiring/src/project-map.ts` 461 行）が、単位（`group ?? 箱の id`）× runtime でノードを作り、線を単位の対ごとに束ね、v1 の形の graph と対応表（`unitOf`・`members`・`edges`・`memoKey`・`copies`）を返す。光り方は `litOnMap`、流れは `mapFlow`（`map-flow.ts` 142 行）。8-8 の `foldView` と、同じこと（まとめる・線を束ねる・対応表を返す）を別の規則でしている。

**目標**: 

```
readContainment(graph) ─▶ 木
mapCut(木)             ─▶ 地図の切り口（unit の入れ物を閉じ、ほかは全部開く）
foldView(index, 木, 地図の切り口, 置き場 = レーン) ─▶ 見える単位・線・対応表
mapScene(…)            ─▶ 3D の Viewer の入力（今の v1 の形）＋ 単位 ⇄ ノードの対応
```

- **3D の Viewer の入力の型は変えない**（`@stack-atlas/schema` の v1 の `Graph`。v1 のファイルを 3D だけで開く道と共通）。Viewer から見ると、渡ってくるものは今と同じ
- **`foldView` は変えない**。地図の切り口は `unit` の入れ物を閉じるだけ、置き場は「レーン（runtime）」（配線図の既定は「host、無ければレーン」）。どちらも今ある引数

**`mapScene` に残る地図だけの規則**（`foldView` に入れると配線図が変わってしまうもの）

| 規則 | 今の場所 | Phase 9 |
|---|---|---|
| 単位の id: いちばん箱の多い runtime が入れ物の id、ほかは `<id>@<runtime>` | `projectMap` | `mapScene`（`foldView` の単位は `fold:<番号>:<番号>`。入れ物と置き場から名前を付け直す） |
| host の箱は 1 ノード。中の箱の単位へ `deploy` の線 | `projectMap` | `mapScene`（`foldView` は host を箱の欄として持つだけ） |
| 線は単位の対ごとに 1 本。種類は deploy ＞ http ＞ schema ＞ uses ＞ flow。往復の戻り（return・sql・http の reply）は向きを戻して同じ束へ | `projectMap` | `mapScene`（`foldView` の線は「端の対 × 行き / 戻り」。開いている箱どうしは項目ごと。それを単位の対へもう 1 回束ねる） |
| 種類を地図の語彙へ（`V2_KIND_TO_V1`）。入れ物は `unit` | `projectMap`（`PREFIX_KIND` で id の接頭辞も見る） | `mapScene`。**id の接頭辞は見ない**（箱は `kind`、入れ物は `unit`。接頭辞でしか分からない `route` / `layout` の違いは、箱の `meta` に元の種類を書いて読む。9-1b） |
| 名前の候補・切り詰め（`nameCandidates`・`clipName`） | `projectMap` | 入れ物の `name` を使う。重なったときの候補だけ `mapScene` に残す |
| 層 = 在るレーン、`screen` の regions の付け替え、`cache`・`code` | `projectMap` | `mapScene` |

- 見積り: `project-map.ts` 461 行 ＋ `map-flow.ts` 142 行 → `map-scene.ts` 約 200 行 ＋ 流れ 約 50 行。**「薄い写し」は 0 行にはならない**（地図だけの規則が 6 つ残る）
- **`litOnMap` → `litOn`**: 配線図の `LitSelection`（全体の graph の箱と線）を、地図の `foldView` の `unitOf`・`lineOf` で写す。地図の束は `foldView` の線をもう 1 回束ねたものなので、「線 → 束・向き」の表を `mapScene` が返す
- **`mapFlow` → `flowOn`**: 時刻の正は配線図の `Player`（D106 のまま）。配線図の球の区間（配線図の切り口の線）→ 全体の線（配線図の `wiresOf`）→ 地図の線（地図の `lineOf`）→ 束、の順に写す。「同じ束・同じ向きで時間の重なる球は 1 つ」「同じ単位の中の線は脈動」は今の規則のまま残る
- **選択の種類**: 地図のノードの `group` と 8-8 の `container` を **`container` の 1 つ**にする（`{ kind: 'container', id }`）。`unitKind` は `'box' | 'host' | 'container'`
- **キー**: 入れ物の id = 今の group の値なので、何も移さずに済む

| キー | 今 | Phase 9 |
|---|---|---|
| メモ | 箱の id・型の id・group の値。孤立 = 箱 ∪ 型 ∪ group ∪ 地図のノードに無いもの | 箱の id・型の id・**入れ物の id**（group の値と同じ文字列）。孤立 = 箱 ∪ 型 ∪ 入れ物に無いもの。ディレクトリ・ファイルにもメモを書けるようになる |
| 差分 | 地図は `projectMap(前)` と比べる | `mapScene(前)`。前の graph に `containers` が無ければ `deriveContainers` |
| `?sel=` | 地図のノード → 箱の順に解く | 箱と入れ物は同じ名前空間なので順は要らない。`@runtime` は外して引く（今と同じ） |

- **合格の決め方（D146）**: `projectMap` を消す前に、`mapScene` の出力（v1 の形の graph）が `projectMap` の出力と**同じ**（3 つの fixture の build・基準の `poly-86.v2.json`・敵対的な入力のテスト）ことをテストで確かめる。違いが出たら、表にして理由を書くか、`mapScene` を直す
- **`graph.v1.json`**: 9-1b で書くのをやめる（出力先に残っている古いものは build が消す）。ビューアの「隣の graph.v1.json へのリンク」（`graph/alternate.ts`・`altLink.ts`）も外す。`build --v1`（v1 だけを書く）は v1 の段がある間（9-2c の最後まで）残す。v1 のファイル（race-site のサンプル・ドロップ・古い graph.v1.json）は今までどおり 3D だけで開ける

採らなかった案:

- **`projectMap` を残す**: まとめ方が 2 つのまま。8-8 で入った入れ物の選択・開閉と、地図の group の選択が別物のまま残る
- **地図の規則を `foldView` に入れて `mapScene` を無くす**: host の線・戻りの向き・v1 の語彙が配線図の畳みに混ざる
- **地図の切り口を利用者が動かせるようにする**（ディレクトリの段の地図）: できる形にはなるが、見た目の決めごとなので Phase 9 ではやらない（§8.2）

### 2.3 抽出: アダプタの自立とレシピ

**今の依存**（コードで確かめた）

| アダプタ | import しているもの |
|---|---|
| ts-types | ts-imports（`analyzeTsRepo` ほか。`boxes.ts`・`index.ts`・`body.ts`）、api-link（`httpCallInfo`・`clientFiles`・`detectWrappers` ほか）、nextjs-app（`readNextOutput`） |
| go-types | go（`analyzeGo`・`infraType`・`lambdaHints`・`lambdaMatchesEntry`）、sql |

nextjs-app と sql は消さない抽出器なので、そのまま。3 つ（ts-imports 569 行・go 446 行・api-link 1,389 行、計 2,404 行）のうち、v1 にしか要らないのは約 850 行で、残りはアダプタが使っている。だから「消す」ではなく「移す」。

**3 つを今すぐ外すとどうなるか**（§6.1 の表）: 項目の線は、OpenAPI のある fixture-poly・fixture-gaps では変わらない（106・119）。OpenAPI の無い fixture-repo だけ 46 → 34（api-link のルート表の規則に頼っている 12 本）。group は 0 になり、flows.yaml・overrides が指す v1 の id が無くなって build エラーが 9・6・6 件出る。穴は 5 つ:

| # | 穴 | 今だれが埋めているか | Phase 9 での行き先（D151） |
|---|---|---|---|
| 1 | group の元の名前・種類（`groups[]`） | core の `groupInfosV2` が v1 の箱を読む | アダプタが入れ物（`unit`・`name`・`file`）を直接出す（9-2a・9-2b） |
| 2 | TS の箱の host・runtime | upgrade が v1 の `deploy` と、ts-imports の `uses`（import）の閉包から配る | 9-2a: アダプタが**値の import** の `uses` を出して今の配り方を保つ。9-2c: 置き場の段が v2 の線（call・render）の閉包で配る |
| 3 | TS の handler のルート（OpenAPI が無いとき） | api-link の規則 2（親ディレクトリのルート表を正規表現で読む）が `meta.apiRoutes` を書き、core の `handlerRoutes` が読む | TS アダプタの**レシピ `route-table`**（型 API でオブジェクトリテラルのキーと値の関数を読む）。線に出所を書く |
| 4 | endpoint の host | pipeline が v1 の `deploy` の線から `endpointHosts` を作る。その線は api-link が `api.targets`・API Gateway の route から張る | join の規則にする（IaC の route・`api.targets` は書いてあること = 事実）。Function URL の Lambda が 1 つだけ、のような当て方はレシピか未確定へ |
| 5 | TS の「テーブル」の箱（`schema:RaceItem`） | ts-imports の規則（`db/` のディレクトリか `*Item` の名前） | 設定で明示する（`classify` で `kind: schema`）。既定の名前の規則は外す。fixture-repo は設定に 1 行足す |

**9-2a・9-2b の間の移行の形（D149）**: アダプタは、関数の箱（v2）に加えて、**モジュールの箱を v1 の段にも同じ id で出す**（今 ts-imports・go が出しているノード。エッジは値の import の `uses` と、設定に書かれた `deploy` だけ）。こうすると flows.yaml・overrides・`classify`・`deploy` は v1 の段で今のまま当たり、3 つのパッケージを消しても build エラーが出ない。v1 の段へ出すのをやめるのは 9-2c の最後（v1 の段が無くなるとき）。

**レシピ（D150）**: 型 API でも契約でも決まらないものを、名前や形で当てる規則。残すものは次の 4 つを満たす。

1. 名前がある（`route-table`・`lambda-entry` など）。docs/04 に一覧を置く
2. 当たった箱・線に出所を書く: `meta.by: "recipe:<名前>"`（補いの `meta.by: "overrides"`・手書きの `"hand"` と同じ欄）と `confidence: crude`
3. 設定で明示できるキーがあり、明示されていれば警告なし。明示が無いまま当たったら警告に「推定」と「明示できるキー」を書く（D18 の規約のまま）
4. 解けなければ線を引かず、**未確定の一覧**（`build --dry-run --json` の報告の `unresolved`）に「こう書けば確定する」を出す

| 今の規則（api-link・go・ts-imports） | Phase 9 |
|---|---|
| `// @route GET /x` のコメント、API Gateway の route_key、OpenAPI の endpoint、`config.deploy[<lambda>].handlers`、`api.targets`、`classify` | **事実として移す**（書いてあること）。読む場所はアダプタか join |
| ルート表のプロパティ（`"GET /races": getRaces`）を正規表現で読む | **レシピ `route-table`**（TS アダプタ。型 API で読む） |
| Go のルートの登録（`recipes_http.go`） | 今もアダプタの中のレシピ。出所を書く |
| Lambda の名前 ↔ Go の入口のパッケージ | **レシピ `lambda-entry`**（go-types。明示のキーは `deploy`） |
| 動詞の接頭辞と名前の一致（get/list → GET …）、Lambda に handler が 1 つだけ、Function URL の Lambda が 1 つだけ、Lambda が参照するテーブルが 1 つだけ | **移さない**（線を引かず未確定に出す）。ただし 9-2a の最初に、規則ごとの当たった回数を 3 つの fixture と実リポジトリ（件数だけ）で数え、当たっていた規則はレシピとして残す |
| ディレクトリ名・ファイル名 → kind（`handler`・`lib`・`schema`） | 見た目の種類（入れ物の `unit`）を決める既定として残す（線は引かない）。`classify` が勝つ |
| パッケージの単位の `uses`、import した名前の文字列の一致 | 移さない（アダプタの線がある）。型だけの import から来ていた call / return の線 8 本は消える（正しくなる） |

- 3 つの fixture で「推定」の警告は今 0 件、実リポジトリの v1 の build も警告 0 件だった（Phase 6）。警告を出す当て方は当たっていない見込みだが、警告を出さずに当てている規則があるかもしれないので、数えてから決める
- **設定のキーは変えない**（`api.client`・`api.clients`・`api.callers`・`api.targets`・`deploy`・`classify`）。読み手がアダプタに変わるだけ。`extractors: { ts-imports: false }` のように消えた名前が書かれていたら、警告して無視する
- cache 抽出器（v1 の `hook:` のノードを読む）と screens の覆いの計算（v1 の `uses` を読む）は、9-2a でアダプタの出力（`hook:` の箱・値の import の `uses`）を読むように直す

採らなかった案:

- **3 つを一度に消して、足りない所を後で埋める**: fixture の数が変わり（build エラー 9・6・6）、どの差がどの穴かを追えない
- **共有の解析を新しいパッケージ（`ts-analysis` など）に出す**: 使う側はアダプタ 1 つずつなので、パッケージを増やす理由が無い
- **レシピを全部やめる**: OpenAPI の無い構成（fixture-repo）で、画面から handler までの線が箱の単位に戻る（項目の線 12 本）

### 2.4 残りの抽出器と置き場の段（upgrade.ts の行き先）

`upgradeGraph`（`packages/core/src/upgrade.ts` 842 行。呼ぶのは `pipeline.ts` と `cli` の `diff`）は 4 つの仕事をしている。行き先を分ける（D152）。

| 仕事 | 今の行 | 行き先 |
|---|---|---|
| 箱の既定の形（kind の表・既定の口・table の型） | 約 250 | core の `box-defaults`（箱の単位しか知らない抽出器が呼ぶ小さい関数）。IaC の profile（約 90 行）は tf-graph へ |
| 横断の処理（host の枠と配り・runtime の優先順・`deploy` で受け持つ endpoint） | 約 300 | **置き場の段 `placeV2`**（合流と join の後）。v1 の `uses` の閉包を、v2 の線（call・render。戻りは除く）の閉包に替える |
| v1 のエッジ → 線（kind → via、口の選び方、往復の組） | 約 120 | 各抽出器が口を知っているので直接書く。箱の単位の線の既定（`out/_` → `in/_`）は `box-defaults` |
| flows → views | 約 20 | 古い形の写し（§2.5）。9-2c の最後 |

| 抽出器 | 今（v1） | 9-2c で足すもの（見積り） |
|---|---|---|
| openapi・sql | endpoint・テーブルの箱（v2 の口は今も出している） | 20〜40 行ずつ（`parent`・v1 の出力を外す） |
| tf-graph（cdktf・terraform・cloudformation が使う） | infra のノードとエッジ・cache | 250〜350 行（profile・口・host になれる印・`apiRoutes`） |
| nextjs-app | 画面・layout のノード | 約 60 行 |
| files | glob → ノード | 約 30 行 |
| cache・screenshots・screens | ノードへの書き足し | 10〜20 行ずつ |

- 抽出器の契約（`packages/core/src/types.ts`）は、v2 の部分（`PartialGraphV2`）に `containers` を足す。v1 の部分（`PartialGraph`）は 9-2c の最後に契約から外す
- v1 の段にあるもの（`applyClassify`・`applyDeployConfig`・`assignLayers`・`runRules`・v1 の検証）の行き先: `classify` は抽出器が kind を決めるときに既に使っている（`classifyKind`）ので段としては要らない。`deploy` は継ぎ当て（host）に写す。層（`layers`・`layerOf`）は v1 のファイルを開くときだけの概念になり、build からは外す（2 面の地図の層は runtime）。規則（`rules/`。キャッシュの古さなど 367 行）は v2 の graph を見るように移す（数が同じことを fixture で確かめる）。v1 の検証（`validateGraph`）は、v1 のファイルを開く・`validate` するために残す
- `cli diff` の「v1 の側を v2 に変換して比べる」は、`upgradeGraph` と一緒に無くなる。前が v1 で今が v2 のときは「前の graph が v1 です（比べられません）」と出す（ビューアの差分は今もそうしている）

### 2.5 直す入力を 1 つの形に

**今**（同じ直しを書ける場所）

| したいこと | 書ける場所 |
|---|---|
| 箱を足す | overrides の `nodes`（v1）、手書きの部分グラフ、（`v2.nodes` は直すだけ） |
| 箱を直す | overrides の `nodes`（v1）、`v2.nodes` |
| 線を足す | overrides の `edges`（v1）、`v2.wires`、手書きの部分グラフ |
| 消す | overrides の `remove`（v1）、`v2.remove` |
| host を決める | config の `deploy`、overrides の `deploy`、`v2.nodes`、手書きの部分グラフ |
| 始点・シナリオ | flows.yaml、`.stack-atlas/views.yaml` |

読む側は 5 つ（`overrides.ts` 213 行・`supplements.ts` 1,052 行・`hand-graph.ts` 215 行・`flows.ts` 115 行・`views-yaml.ts` 159 行）で、当てる段も v1 と v2 に分かれている。

**目標（D153）**: 新しい文法は作らない。**今の `v2:` の語彙**（8-4 のドッグフードで 6/6 を出した形）を正にして、足りないキーを 3 つ足す。

| キー | すること | 今の何を吸うか |
|---|---|---|
| `nodes` | 箱を足す・直す。id の箱が無ければ足す（`runtime` 必須。口も書ける）。在れば書いた欄だけ直す。口・項目は、アダプタの項目に子が無いか unknown の所にだけ足す（今の手書きの規則） | `v2.nodes`、v1 の `nodes`、手書きの `nodes` |
| `containers`（新） | 入れ物を足す・直す（`name`・`unit`・`parent`）。`host` を書くと中の箱すべての host | v1 の `nodes`（group になった id）、`deploy` |
| `wires` | 線を足す。端は項目・箱・入れ物 | `v2.wires`、v1 の `edges`、手書きの `wires` |
| `retarget`・`items`・`links`・`variants`・`when` | 今のまま | `v2.*` |
| `remove` | 箱・入れ物・線を消す | `v2.remove`、v1 の `remove` |
| `types`（新） | 型を足す | 手書きの `types` |
| `views`（新） | 始点とシナリオ（docs/16 §8 の形） | views.yaml、flows.yaml |

- **ファイル**: 新しい形は `stack-atlas.patch.yaml`（トップにこのキーが並ぶ）と、分けて書きたいとき用の `.stack-atlas/graph/*.yaml`（同じ形。今の `*.v2.yaml` はそのまま読める）。今の `stack-atlas.overrides.yaml` のトップの `nodes` は v1 の箱の配列で、新しい `nodes` と意味が違うので、**ファイル名で見分ける**（overrides.yaml = 古い形）
- **キーは「箱か入れ物の id」（D154）**。入れ物を端にした線・`retarget`・view の始点は、今の「group になった箱」の規則（付け替え先を決める・中の最初の関数の箱にする）で箱へ下ろす。解けなければ今までどおり「解けない補い」（strict ではエラー）
- **当てる段は v2 の 1 か所**（今の補いの段 A・B）。結果は今と同じ applied / unresolved / mismatch。`reason` は必須のまま
- **古い形の写し（D155）**: 読み込みで新しい形へ写してから、同じ当て方で当てる。当てる側を 2 つ持たない

| 古い形 | 写し先 | 警告 |
|---|---|---|
| overrides.yaml の `v2:` | そのまま（同じ語彙） | 無し（9-3 では。ファイルを移すよう案内は出す） |
| overrides.yaml の `nodes`（v1） | 在る箱 → `nodes` のパッチ（kind は v1 → v2 の表で）、入れ物 → `containers`、無い id → `nodes` の追加（`box-defaults` で既定の口）。`layer` は捨てる | 「古い形です。`stack-atlas migrate` で書き換えられます」 |
| overrides.yaml の `edges`・`remove`・`deploy` | `wires`（箱の単位。via は kind の表）・`remove`・`containers[].host` / `nodes[].host` | 同上 |
| config の `deploy` | 写さない（設定のまま読む）。当てるのは同じ段 | 無し |
| flows.yaml | `views`（始点は最初に解ける歩。cache の歩は分岐 `#hit`。今 upgrade がしている変換） | 同上 |
| `.stack-atlas/views.yaml`・`.stack-atlas/graph/*.v2.yaml` | そのまま | 無し |

- **`stack-atlas migrate <repo>`**: 上の写しの結果を `stack-atlas.patch.yaml` として出す。既定は書かずに差分を表示、`--write` で書く（古いファイルは消さない。消すのは人）。Q23
- **メモ**（`memos.json`）は graph の直しではなく利用者のデータなので別のまま。キーは同じ id
- **`screens/<slug>.regions.yaml`** は測った値の補いで、形（ref ごとの矩形）が違うので別のまま
- harness の skill（`harness/skill/`）は、書く先のファイル名とキーの表を直し、`VERSION` を上げ、fixture-gaps のドッグフード（再現 6/6・誤った補い 0）をやり直す

採らなかった案:

- **動詞で並べ直した新しい文法**（`add:` / `set:` / `remove:` の下に箱・線・入れ物）: 意味は同じで、skill・テスト・ドッグフードを全部やり直すことになる
- **overrides.yaml のまま `version: 2` の印で見分ける**: 1 つのファイルに 2 つの意味の `nodes` が残り、読み間違える
- **古い形の当て方を残す（写さない）**: 当てる段が v1 と v2 に分かれたままになり、v1 の段を消せない

### 2.6 片付け（9-4）

- **場面の状態を 1 つに**: 選択・切り口・光り・時刻を 1 つのモジュールが持ち、配線図（8-7 の `setScene`）と地図（`mapScene`）はそれを写すだけにする（今は `split/` 610 行が 2 つの面の状態をつないでいる）。**描画は 2 つのまま**（SVG と three.js）。ここで減るのは約 200 行。3D の Viewer（v1 の側 約 5,700 行）は、v1 のファイルを開く道を残すので消えない
- **`group`・`groups[]` を書くのをやめる**（§2.1）
- **アダプタの結果のキャッシュ**: 実リポジトリの build 約 17 秒のうち 57% が TS の型検査。repo ごとに、アダプタの出力（v2 の部分）を「アダプタの版・設定の該当の節・読んだファイルの内容のハッシュ」をキーにして保存する。置き場所は設定のディレクトリの `.stack-atlas/cache/`（出力にはコードの抜粋が入るので、公開のリポジトリに入らない場所。`.gitignore` の案内を出す）。`--no-cache` で使わない。外へは送らない
- **CLI を 1 ファイルに束ねる**: node の起動と読み込みが 19%。cli と抽出器を 1 つの JS に束ねる（`typescript` と Go の補助プログラムは外のまま）
- 古い形の読み込み（§2.5）を消す時期は Q23
