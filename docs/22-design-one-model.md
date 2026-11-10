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
- 減る行は **約 2,500〜3,000**（見積り。テストと、9-4 で足すキャッシュ・束ねの約 250 行は別。§3.2）。ビルドの時間はほとんど変わらない（型検査が 57%）。速くするのは 9-4 のキャッシュ

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
| `nodes[].unit?` | 箱がそのまま地図の 1 ノードになるときの種類（v1 の語彙。`layout`・`handler` など）。無ければ `kind` の表から（`screen` → `page` など）。9-1b で足す（§2.7） |

8-8a の `Container { id, name, kind, parent?, memo? }` に `file`・`unit` を足した形。`unit` は「地図の単位としての種類」: 入れ物は、これがあると地図の単位になる。箱は、単位の入れ物に入っていなければいつも単位で、`unit` は種類を言い直すだけ。`memo`（メモのキー）は graph には書かない: id がそのままメモのキーになる（下の「id」）。

**id（D142）**

| 入れ物 | id | 理由 |
|---|---|---|
| group だったもの | **group の値そのもの**（`lib:web/src/feature/spend/request.ts`・`handler:internal/api`。v1 の箱の id） | メモ・overrides・flows・`?sel=`・差分が今このキーを使っている。fixture-poly の基準（13 group）で、group の値が箱の id と重なるものは 0 |
| ディレクトリ | `dir:<パス>`（箱の `file` と同じ書き方。複数 repo なら `<repo>/` 付き） | 人が継ぎ当てに書ける形にする。8-8a の `d:<パス>` より読める |
| ファイル（group の無い箱のファイル） | `file:<パス>` | 同上 |
| repo（複数 repo のときだけ） | `repo:<名前>` | 同上 |

- 作った id が箱・型・ほかの入れ物と重なったら、重ならなくなるまで末尾に `~` を足す（8-8a と同じ逃がし方）。手で書いた `containers` の id が重なったら**エラー**（今の `groups` は警告。名前空間を共有するので厳しくする）
- 8-8 の `?open=` の値（`d:<パス>`・`g:<group の値>`）は 9-1a で解けなくなり、既定の切り口で開く（docs/21 §7・D130 が先に断っているとおり。読み替えは作らない）

**木は全部持ち、つぶすのは見る側（D143）**

- graph には、箱のあるディレクトリを根まで全部、箱のあるファイルを全部、group を全部（中が 1 箱でも）書く。fixture-poly の基準で 71 箱に対して入れ物 71（ディレクトリ 35・ファイル 23・group 13）
- 「子が 1 つだけの段をつぶす」「中が 1 箱だけの入れ物は出さない」「深さ 32 まで」は、配線図の畳みの都合なので `@stack-atlas/wiring` の `compactContainment` に置く（8-8a の `containmentOf` の後半をそのまま残す）。地図はつぶす前の木を使う（1 箱だけの group も地図の単位。基準で 13 group のうち 7 つが 1 箱）
- つぶした段の id は、いちばん深い入れ物の id にする（上の段に兄弟が増えても id が変わらない）
- `kind: file` の段（group の無い箱のファイル。OpenAPI の 1 ファイルに endpoint が 8 つ、など）は 8-8a の木に無い段。Q26 の答えまで、`compactContainment` はこの段を配線図に出さない（9-1a で配線図の見た目を変えない）

**誰が作るか（D144）**

| 段 | 作り手 |
|---|---|
| 9-1a | build の最後に `deriveContainers(graph)` が箱の `file`・`group`・`groups[]` から作って書く。関数は **`@stack-atlas/wiring` に 1 つ**（core は今も wiring に依存している。ビューアは core に依存しない） |
| 古い graph（`containers` が無い v2） | ビューアが同じ `deriveContainers` を当てる。build と同じ木になるので、古い graph でも入れ物の id・メモのキーが合う |
| 9-2a・9-2b | 言語アダプタが自分の箱の入れ物を直接出す（TS は `kind: file`、Go は `kind: package` とその下の `file`）。`deriveContainers` は `parent` の無い箱にだけ働く |
| 9-2c | 残りの抽出器も `parent`（ファイル）を出す。`deriveContainers` はディレクトリの段を埋めるだけになる |

- `deriveContainers` の規則: 箱に `group` があれば group の入れ物（`kind: group`・`unit` は `groups[].kind`・親は `groups[].file` のディレクトリ、無ければ中の箱の共通のディレクトリ。8-8a と同じ）、無ければ `file` の入れ物、`file` も無ければ根の直下。同じファイルに group の箱と group の無い箱が混ざるときは入れ物が 2 つ並ぶ（地図の単位を変えないため。基準では 0 件）
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
| 種類を地図の語彙へ（`V2_KIND_TO_V1`）。入れ物は `unit` | `projectMap`（`PREFIX_KIND` で id の接頭辞も見る） | `mapScene`。**id の接頭辞は見ない**（入れ物は `unit`、箱は `unit`、無ければ `kind` の表。`layout:` と `route:` はどちらも v2 の `screen` なので、違いは箱の `unit` で持つ。9-1b では `upgradeGraph` が v1 の種類を知っているので、表と違うときだけ書く） |
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

- 抽出器の契約（`packages/core/src/types.ts`）は、v2 の部分（`PartialGraphV2`）に `containers` を足す（9-2a）。`PartialGraph` の v1 の欄（`nodes`・`edges`）は 9-2c の最後に外し、抽出器が返すのは v2 の部分だけになる。`extract(ctx, upstream)` の `upstream`（先に走った抽出器の結果。cache が `hook:` の箱を、screens が画面の箱を読む）も v2 の部分になる。契約を変えるので、core と各抽出器を同じ PR で直す
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

### 2.7 id は不透明に（接頭辞を読まない）

- 今、id の接頭辞（`hook:`・`comp:`・`handler:` …）から種類を読んでいる所が、テストを除いて 13 ファイル 23 か所と、`project-map.ts` の表 1 つある（単純な grep の数。事実メモは 14 ファイル 25 か所）
- Phase 9 では、種類は欄から読む（箱の `kind`・`unit`、入れ物の `kind`・`unit`）。id は「同じものを指す名前」としてだけ使う。**id の付け方（接頭辞の規約）は変えない**（人が読む・書くため）

| 場所 | 数 | 直す段 |
|---|---|---|
| wiring の `PREFIX_KIND`（地図の種類） | 表 1 | 9-1b（`unit`） |
| ts-imports・api-link | 3 | 9-2a（パッケージごと無くなる） |
| ts-types・cache・screens・screenshots | 9 | 9-2a（アダプタの箱の `kind` を読む） |
| core の join・strict・broken-v2・rules | 7 | 9-2c（v2 の `kind`） |
| cli の init-flows・init-views | 4 | 9-3 |

- 古い graph（`containers`・`unit` が無い）を開くときだけ、`deriveContainers` が接頭辞の表で `unit` を埋める。接頭辞を読む所はこの 1 か所に集める（build は読まない）
- 数を固定するテストを置く（上の grep の数。段ごとに下げる。増えたら落ちる）

## 3. 段取り

### 3.1 共通の決まり（D158）

- **基準の表**（§6.1）: 3 つの fixture（fixture-repo・fixture-poly・fixture-gaps）の、箱・線・項目の線・links・地図の単位（今の group）・型・build のエラー / 警告・strict のエラーの数。9-1a の最初に、この数を 1 つの JSON にして CLI のテストで固定する（今の「fixture-poly は 56 ノード / 95 エッジ」のテストに v2 の列を足す）。段で数が変わるときは、その JSON の差分が PR に出る
- **合格**: 基準の表と同じ。違う所は、PR の説明に「どの fixture の、どの列が、いくつ → いくつ、なぜ」を 1 行ずつ書く。理由を書けない差が 1 つでもあれば入れない
- **実リポジトリ**: `<非公開の設定ディレクトリ>` で CLI を回し、**件数だけ**を前の段と比べる（箱・線・項目の線・食い違い・build のエラー / 警告・strict）。中身は読まない・この公開リポジトリに書かない（Q17 が未決）。件数が変わったら、変わった列と数だけを報告して止まる（中を見るかはユーザーが決める）
- **毎段**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`。ビューアを触る段は e2e（CI）。Go を触る段は `STACK_ATLAS_REQUIRE_GO=1`。数を比べる前に `pnpm install --frozen-lockfile`（node_modules が古いと go-types・screens が抜けて数が変わる。8-7 で、抜けたら警告が出るようになる）
- **レビュー**: 設計のレビューはこの文書に 1 回。各 PR は作る直前に `/code-review` を 1 回（既定は medium。9-1b・9-2c の最後・9-3 は high）、`/security-review` は §4 の表のとおり
- **戻し方**: 各段は、その PR のマージコミットを `git revert` する（履歴は改変しない）。形が変わるもの（graph.json の `containers`、`stack-atlas.patch.yaml`）は、戻した後に build し直す。どの段も、前の段までの入力（設定・overrides・flows・メモ）をそのまま読めるようにしてあるので、戻しても入力は直さなくてよい
- **書き直しはしない**: どの段も、main が動く状態のまま 1 つずつ寄せる。段の途中で「両方ある」期間（`group` と `containers`、v1 の段と v2 の部分、古い形と新しい形）を作り、最後に古い方を消す

### 3.2 段の一覧

| 段 | すること | 触るパッケージ | 行（見積り。テスト別） | PR |
|---|---|---|---|---|
| 9-1a | 木を graph に持つ（足すだけ） | schema・wiring・core・viewer・docs/03・docs/16 | 約 +150 | 1 |
| 9-1b | 地図を畳みの段から描く。`graph.v1.json` をやめる | wiring・viewer・cli・core | −350〜−450 | 1 |
| 9-2a | TS アダプタの自立。ts-imports・api-link を消す | ts-types・core（join）・cache・screens・cli | −550〜−650 | 1 |
| 9-2b | Go アダプタの自立。go を消す | go-types・cli | −200〜−250 | 1 |
| 9-2c | 残りの抽出器が v2 を出す。v1 の段と `upgrade.ts` を消す | core・tf-graph・openapi・sql・nextjs-app・files・cache・screenshots・screens・cli | −700〜−900 | 4 |
| 9-3 | 直す入力を 1 つの形に。`migrate` | core・cli・harness/skill・docs | −600〜−900 | 1〜2 |
| 9-4 | 片付け（場面の状態・`group` を書かない・キャッシュ・束ね） | viewer・core・cli | −250（キャッシュ・束ねで別に 約 +250） | 3〜4 |
| 計 | | | **約 −2,500〜−3,200** | 12〜14 |

抽出器の数: 15 →（9-2a）13 →（9-2b）12。テストは、消すコードのテスト（upgrade の 968 ＋ 421 行、`project-map`・`map-flow` のテスト 約 700 行）を、移した先（`box-defaults`・`placeV2`・写し・`mapScene`）のテストに書き直す。テストの行は減らす目標にしない。

### 3.3 9-1a — 木を graph に持つ

- **前提**: 8-8b が main に入っている（8-8a の `Containment`・`containmentOf`・`cleanContainment`・`foldView` が wiring にある）
- **すること**
  1. 基準の表を JSON にしてテストで固定する（§3.1）。fixture-repo・fixture-gaps の入れ物の数（ディレクトリ・ファイル・group）を測って足す（fixture-poly は 35・23・13）
  2. schema: `containers`・`$defs.container`・`node.parent`、型、`validateGraphV2` の検証、docs/03・docs/16（§2.1 の「同時に直す所」）
  3. wiring: 8-8a の `containmentOf` を 3 つに分ける。`deriveContainers(graph)`（全部の木を作る）・`readContainment(graph)`（graph の `containers` を 8-8a の `Containment` として読む。枠は外す）・`compactContainment(c)`（つぶす）。`containmentOf(graph)` は `compactContainment(readContainment(graph))` として残す（呼ぶ側を変えない）
  4. core: build の最後（補いの後・検証の前）で `deriveContainers` を呼び、`containers` と箱の `parent` を書く。`build --dry-run --json` の報告に入れ物の数を足す
  5. viewer: 開いた graph に `containers` が無ければ `deriveContainers` を当てる。メモの孤立の判定に入れ物の id を足す。サンプル（`examples/*.v2.json`）を作り直す
- **合格**
  - 基準の表が同じ（`containers` と `parent` が増えるだけ）
  - 配線図の畳みが 8-8 と同じ: つぶした木が、8-8a の `containmentOf` の木と「id の付け替え（`d:<p>` → `dir:<p>`、`g:<v>` → `<v>`）を除いて同じ」（3 つの fixture と基準の `poly-86.v2.json`）
  - build が書いた木と、`containers` を消した同じ graph にビューアが当てた木が同じ
  - 実リポジトリ: 件数が同じ。入れ物の数（種類ごと）と、「group の値が箱の id と重なる数」を記録する（重なると、その入れ物の id に `~` が付く）
- **止まる条件**: 実リポジトリで group の値と箱の id の重なりが 1 件でもあれば、メモのキーの扱い（箱と入れ物が同じキーを分け合っていた）をユーザーに確認する
- **戻し方**: revert。この段の間に作った graph.json は作り直す（v2 のスキーマはトップの知らない欄をエラーにするので、古いビューアは `containers` のある graph を開けない）

### 3.4 9-1b — 地図を畳みの段から

- **すること**
  1. `upgradeGraph` が箱の `unit` を書く（v1 の種類が `kind` の表と違うときだけ）。schema・型・docs/03・docs/16
  2. wiring: `mapCut`・`mapScene`（§2.2）を足す。`projectMap` と同じ出力になることをテストで確かめる（下の合格）。確かめてから `project-map.ts`・`map-flow.ts` を消し、`litOnMap`・`mapFlow` を `litOn`・`flowOn` の組み合わせに替える
  3. viewer: `split/` と `main.ts` を `mapScene` に替える。選択の種類 `group` を `container` に寄せる。差分は `mapScene(前)`。`graph/alternate.ts`・`altLink.ts` を外す
  4. cli: `graph.v1.json` を書かない。出力先に古い `graph.v1.json` があれば消す（出力のディレクトリの直下の、その名前のファイルだけ。リンクは辿らない）。`build --v1` は残す
  5. docs: docs/20 §7、docs/11・docs/13・README・`docs/ci-example.yml` の `graph.v1.json` の記述
- **合格**
  - `mapScene` の出力（v1 の形の graph と対応表）が `projectMap` の出力と同じ: 3 つの fixture の build、`poly-86.v2.json`、今の `project-map.test.ts`・`map-hostile.test.ts`（敵対的な入力）の入力。違いが残るなら、表にして理由を書く
  - 流れ: `flowOn` の組み合わせが、今の `map-flow.test.ts`（702 行）の期待と同じ（球の数・時刻・束・向き）
  - e2e: 2 面の spec を、選択の種類の名前の他は変えずに通す
  - 速さ: 開くときの `foldView` ＋ `mapScene` と、選択のたびの `litOn` を、合成 300 箱で `projectMap`・`litOnMap` と比べて PR に書く（遅くしない）
  - 基準の表は同じ（v1 の列は、ここから「出力しないが、v1 の段の中の数として記録だけする」）。実リポジトリは件数が同じ
- **止まる条件**: `mapScene` が `projectMap` と同じ出力にならない規則が残る、または `map-scene.ts` が 300 行を超える見込みになったら、止めてユーザーに選択肢を出す（`projectMap` を残して木だけ読ませる / 違いを受け入れる）
- **戻し方**: revert（`graph.v1.json` は次の build でまた書かれる）

### 3.5 9-2a — TS アダプタの自立

- **すること**（コミットを分ける）
  1. **数える**: 名前や形で当てる規則（§2.3 の表）ごとの当たった回数を、`build --dry-run --json` の報告に出す（`recipes: { <名前>: 件数 }`。この報告は残す）。3 つの fixture と実リポジトリ（件数だけ）で数え、§6 に表を足す。当たっている規則はレシピとして移す
  2. **移す**（中身を変えない）: ts-imports の解析（`analyzeTsRepo` と import の解決）と、api-link のクライアント側（`httpCallInfo`・`clientFiles`・`detectWrappers`）を `extractors/ts-types/src/` へ。`git mv` で移し、差分が「移動」と読めるようにする
  3. **アダプタが出すものを足す**: 入れ物（`kind: file`・`unit`。id は今の group の値）、モジュールの箱（v1 の段へ。今と同じ id）、値の import の `uses`、定数だけのモジュールの箱（`lib:consts` など）
  4. **穴を埋める**（§2.3 の 3・4・5）: レシピ `route-table`、endpoint の host の join の規則、TS のテーブルの明示（fixture-repo の設定に 1 行）
  5. cache・screens・screenshots を、アダプタの箱の `kind` を読むように直す
  6. ts-imports・api-link のパッケージを消す。CLI の一覧、消えた名前の警告、docs/04・README・CLAUDE.md の抽出器の一覧
- **合格**
  - fixture-repo: 箱 33・項目の線 46・地図の単位 2（7 箱）・型 6・エラー 0・警告 0・strict 0 のまま。項目の線 46 のうち 12 本は、出所が `recipe:route-table` になる
  - fixture-poly・fixture-gaps: 箱 71・76、項目の線 106・119、地図の単位 13（34）・15（37）、strict 0・3 のまま
  - 線・links の全体の数（68・143・156、57・183・201）は、箱の単位の線が変わる分だけ動きうる（名前の一致で引いていた `uses` が無くなる）。動いたら、事実メモ A2 の種類ごとに本数を書く
  - 「推定」の警告 0 件のまま。未確定の一覧に出るものが増えたら、それも数で書く
  - 実リポジトリ: 件数が同じか、1 の「数える」で当たっていた規則の分だけの差（数で説明できること）
- **止まる条件**: 実リポジトリで、移さないと決めた規則（動詞の接頭辞・1 つだけ、の類）が当たっていた → レシピとして残すか、設定に明示を書いてもらうかをユーザーに確認する（書く場所は実リポジトリの側）
- **戻し方**: revert（消したパッケージも戻る。設定のキーは変えていない）

### 3.6 9-2b — Go アダプタの自立

- **すること**: go の解析（`analyzeGo`・`infraType`・`lambdaHints`・`lambdaMatchesEntry`）を go-types へ移す。アダプタが入れ物（`kind: package`・`unit`、その下に `kind: file`）とパッケージの箱（v1 の段へ。同じ id）を出す。レシピ `lambda-entry`（明示のキーは `deploy`）。go のパッケージを消す
- **合格**
  - fixture-poly・fixture-gaps: 箱 71・76、項目の線 106・119、地図の単位 13（34）・15（37）のまま
  - 線: **143 → 135、156 → 148 の見込み**（型だけの import から来ていた call / return の偽の線が 8 本ずつ消える。事実メモ A2 の 8。ソースは型を使うだけで関数を呼んでいない）。この 8 本以外の差は理由を書く
  - fixture-repo は変わらない（Go が無い）。実リポジトリは件数の差を数で説明できること（偽の線の分は減りうる）
- **戻し方**: revert

### 3.7 9-2c — 残りの抽出器が v2 を出す・`upgrade.ts` を消す

4 つの PR に分ける。1〜3 は「graph.json が 1 バイトも変わらない」を合格にできる。

| PR | すること | 合格 |
|---|---|---|
| 9-2c-1 | `upgrade.ts` から `box-defaults`（kind の表・既定の口・箱の単位の線の既定）と `placeV2`（host の配り・runtime）を切り出す。`upgradeGraph` はそれを呼ぶ形にする。IaC の profile を tf-graph へ | 3 つの fixture の graph.json が同じ（バイト単位） |
| 9-2c-2 | openapi・sql・tf-graph（cdktf・terraform・cloudformation）が v2 の部分（箱・`parent`・口・線）を直接出す。v1 の出力はまだ残す（同じ id は v2 の部分が勝つ。今の合流の規則） | 同上。違いが出たら理由を書く |
| 9-2c-3 | nextjs-app・files・cache・screenshots・screens も同じ | 同上 |
| 9-2c-4 | flows.yaml・overrides の v1 のキー・`config.deploy` を v2 の上で当てる（§2.5 の写しのうち、この 3 つ）。`rules/` を v2 の graph を見るように移す。v1 の段（`mergePartialGraphs` の v1 の側・`applyClassify`・`applyDeployConfig`・`assignLayers`）、`upgrade.ts`、`build --v1` を消し、契約の `PartialGraph` から v1 の欄（`nodes`・`edges`）を外す。アダプタが v1 の段へ出していた箱も外す。`cli diff` は v1 と v2 を比べない | 基準の表と同じ（v1 の列は無くなる）。build のエラー 0・警告の数が同じ。`placeV2` が v2 の線の閉包で配った host・runtime が、今と同じ（箱ごとに比べるテスト） |

- **止まる条件**: 9-2c-4 で、v2 の線の閉包に替えたときに host・runtime が変わる箱が出る → 変わる箱の数と種類を出して、規則を直すか、違いを受け入れるかを決める（fixture は自分で、実リポジトリの差はユーザーに）
- **戻し方**: PR ごとに revert。9-2c-4 を戻すと v1 の段が戻る（入力のファイルは変えていない）

### 3.8 9-3 — 直す入力を 1 つの形に

- **すること**
  1. core: 当てる側を 1 つにする（`supplements.ts` を土台に、`containers`・`views`・`types` のキー、「無ければ足す」の `nodes`）。`overrides.ts`・`flows.ts`・`views-yaml.ts`・`hand-graph.ts` は「読んで新しい形に写す」だけに縮める
  2. `stack-atlas.patch.yaml` を読む。古いファイルは写して読み、警告を出す（§2.5 の表）
  3. cli: `stack-atlas migrate <repo>`（既定は差分の表示、`--write` で書く）。`init-flows` は古い形の雛形なので、`init-views` を案内して同じものを出す。`init --skill`
  4. harness: skill の本文・references・templates を新しいファイル名とキーに直す。`VERSION` を上げる。fixture-gaps の参照解（`gaps-answers`）を新しい形でも置く。ドッグフードをやり直す
  5. docs/13（設定キー一覧）・docs/19・docs/11
- **合格**
  - 3 つの fixture: 古いファイルのままの build と、`migrate --write` した写しの build で、graph.json が同じ
  - fixture-gaps の参照解: 古い形と新しい形で同じ結果（applied・unresolved・mismatch の数も）
  - ドッグフード: 再現 6/6・誤った補い 0・注入の文に従わない（8-4 と同じ基準）
  - 実リポジトリ: 古いファイルのままで件数が同じ。`migrate`（書かない方）の差分の行数だけを記録する
- **戻し方**: revert。`migrate --write` は古いファイルを消さないので、戻しても古いファイルで動く

### 3.9 9-4 — 片付け

独立した PR に分ける（順は問わない）。

| PR | すること | 合格 |
|---|---|---|
| 場面の状態 | 選択・切り口・光り・時刻を 1 つのモジュールに。2 つの面はそれを写す | e2e が期待を変えずに通る。クリックから両方の面が光るまでの時間を悪くしない |
| `group` を書かない | build が `group`・`groups[]` を書くのをやめる（読む側の「無ければ作る」は残す） | 基準の表が同じ。古い graph（`containers` 無し）が今までどおり開く |
| キャッシュ | アダプタの結果を repo ごとに保存（§2.6） | キャッシュあり・なしで graph.json が同じ。ファイルを 1 つ変えると作り直す。実リポジトリの 2 回目の build の時間を記録 |
| 束ね | CLI を 1 ファイルに | 束ねた CLI で 3 つの fixture の graph.json が同じ。起動の時間を記録 |
| （Q23 の後）古い形の読み込みを消す | overrides.yaml の v1 のキー・flows.yaml の写し | ユーザーが実リポジトリの側を `migrate` してから |

### 3.10 順番の依存

- **9-1a が最初**: 入れ物の id が決まらないと、9-2 で group が消える（13 → 0）問題と、9-3 のキーが決まらない
- **9-1b は 9-2 の前**: 地図が `containers` を読むようになってからでないと、アダプタが入れ物を直接出したときに地図が変わる。`graph.v1.json` も、v1 の段が痩せていく前に止める（止めないと、段ごとに中身が変わるファイルを出し続ける）
- **9-2a・9-2b は 9-2c の前**: アダプタが v1 の段へ出す箱（移行の形）を、v1 の段と一緒に最後に消す
- **「古い形の写し」の一部は 9-2c-4 に入る**: v1 の段を消すには、flows.yaml・overrides の v1 のキー・`config.deploy` が v2 の上で当たっていなければならない。方針メモは写しを 9-3 に置いていたが、この 3 つの最小限だけ前に出す（§6.3）。9-3 は、新しいファイルの形・`migrate`・当てる側の一本化
- 9-3 を 9-2c の前に出す順もある（写しを先に全部作ってから v1 の段を消す）。方針メモの順（データの流れの上流から）を保った。レビューで見てほしい所

## 4. 受け入れ条件とテスト

どの段も §3.1 の共通の合格（基準の表・実リポジトリの件数・lint / typecheck / test / build）に加えて、次を満たす。`/security-review` の列は、グローバルの規約（server・web・protocol・依存・ファイルやプロセスの扱いに触れる変更は 1 回）に当てはめたもの。

| 段 | 足す・直すテスト | e2e | `/security-review` |
|---|---|---|---|
| 9-1a | スキーマと型のずれ（今のテストに `containers`・`parent`）。`validateGraphV2`: id の重複・箱や型と同じ id・無い親・循環はエラー、空の入れ物・`group` と `parent` の食い違いは警告。`deriveContainers`: 決定的、3 つの fixture と `poly-86` で数が表のとおり、id の重なりに `~`、`__proto__` などの id、64,000 段のパス。build の木 = ビューアが古い graph に当てた木。つぶした木 = 8-8a の木（id の付け替えを除く）。メモ: 入れ物の id が孤立にならない | 8-8 の畳みの spec が期待を変えずに通る。`containers` の無い graph（古い形）を開く spec を 1 つ足す | **掛ける**（graph.json の契約、敵対的な graph を読むビューア） |
| 9-1b | `mapScene` = `projectMap`（消す前に、同じ入力で出力を比べるテスト。消した後は、その出力を固定した期待に替える）。`mapCut`: `unit` の入れ物が入れ子のとき外側を閉じる、`unit` が 1 つも無い graph、枠だけの graph。`litOn`・`flowOn` の組み合わせが今の `litOnMap`・`mapFlow` のテストの期待と同じ。箱の `unit`: 表と同じなら書かない、古い graph は接頭辞から。`graph.v1.json`: 書かない、古いものを消す（リンクは消さない・辿らない） | 2 面の spec（選択の写し・`?sel=`・Esc・狭い画面）。v1 のファイルを 3D だけで開く spec はそのまま | **掛ける**（ビューア、出力先のファイルを消す処理） |
| 9-2a | 移した解析のテストを ts-types へ移す（期待は変えない）。レシピ `route-table`: 型 API で読める形・読めない形（計算したキー・関数でない値）は未確定に出る、出所が線に付く、明示があれば警告なし。endpoint の host: IaC の route・`api.targets` から、当てずっぽうをしない。消えた抽出器の名前が設定にあると警告。fixture の数（基準の JSON）。接頭辞を読む所の数 | fixture を作り直して、built の spec が通る | **掛ける**（repo のファイルを読む抽出器の移動。`repoPath`・`globInRepo`・リンクを辿らない規約が移した先でも守られていること。依存の削除） |
| 9-2b | 同上（Go）。`STACK_ATLAS_REQUIRE_GO=1` で。偽の線 8 本が無いことを、線の名前で固定するテスト | 同上 | **掛ける**（Go の補助プログラムを起動する処理の移動） |
| 9-2c-1 | upgrade のテスト（968 ＋ 421 行）を `box-defaults`・`placeV2` のテストに分ける（期待は変えない）。3 つの fixture の graph.json が同じ | 不要（ビューアを触らない） | **掛けない**（core の中の移動だけ。ファイル・プロセス・外部に触れない。理由を PR に書く） |
| 9-2c-2・3 | 各抽出器: v2 の部分の箱・口・`parent` が、今 `upgradeGraph` が作る箱と同じ（抽出器ごとに比べるテスト）。graph.json が同じ | built の spec | **掛ける**（ファイルを読む抽出器。IaC・HTML の消毒（screens）に触れる） |
| 9-2c-4 | 写し（flows → views、v1 のキー → `nodes`・`wires`・`remove`・host）: 今の flows・overrides のテストの期待を、v2 の結果で書き直す（何が変わったかをテストのコメントに書く）。`placeV2`: v2 の線の閉包で配った host・runtime が今と同じ（fixture の箱ごと）。`rules/` の結果の数が同じ。`build --v1` が「無くなりました」と出る。`cli diff` の v1 と v2 | built の spec。差分の spec（前が v1） | **掛ける**（cli、入力のファイルの読み込み） |
| 9-3 | 写し: 古い形のそれぞれのキー → 新しい形（表のとおり）。同じ直しを古い形と新しい形で書いて結果が同じ。`nodes` の「無ければ足す・在れば直す」、入れ物を端にした線、`containers[].host`。読み込みの上限（今の 64 ファイル・1MB）とリンク。`migrate`: 既定は書かない、`--write` は repo の中にだけ書く・在るファイルは上書きしない、2 回当てても同じ。skill: 版、例に fixture-gaps の答えの id が無い（今の `harness.test.ts`） | 不要（ビューアを触らない）。ドッグフードは手で 1 回 | **掛ける**（YAML の読み込み、ファイルを書く `migrate`、skill の本文 = エージェントへの指示） |
| 9-4 場面 | 状態のモジュールの単体テスト（選択・切り口・時刻の写し） | 2 面の spec が期待を変えずに通る | **掛ける**（ビューア） |
| 9-4 `group` | 古い graph の読み込み（`group`・`groups[]` だけ）、新しい graph に `group` が無い | built の spec | 掛けない（書く欄を減らすだけ。理由を PR に書く） |
| 9-4 キャッシュ | キーに入るもの（版・設定の節・ファイルの内容）を 1 つずつ変えて外れる。壊れたキャッシュは捨てて作り直す。置き場所が repo・設定のディレクトリの外に出ない。`--no-cache` | 不要 | **掛ける**（ファイルの扱い。コードの抜粋を手元に保存する） |
| 9-4 束ね | 束ねた CLI で 3 つの fixture | CI の build | **掛ける**（依存・ビルド） |

## 5. 決めたこと

番号は D140 から。理由の詳しい所は §2、数字は §6。

| # | 決定 | 理由 |
|---|---|---|
| D140 | 箱の id は 1 つも変えない。`repo:file#symbol` にしない。種類は id からではなく欄から読む（§2.7） | `#` は箱と口の区切り。メモ・overrides・flows・views・`?sel=`・差分のキーが全部 id |
| D141 | 包含は graph の欄で持つ: トップの `containers[]`（`id`・`name`・`kind`・`parent?`・`file?`・`unit?`）と箱の `parent`。`kind` は開いた文字列。host と型は木に入れない | 8-8a の `Container` と同じ形で、畳む側をそのまま使える。host は「載る」関係で、1 つの入れ物に複数の host が混ざる |
| D142 | 入れ物の id は箱・型と同じ名前空間。group だった入れ物は **group の値そのもの**、作る入れ物は `dir:<パス>`・`file:<パス>`・`repo:<名前>`。重なったら `~` | group の値 = v1 の箱の id で、今のキーがそのまま生きる。名前空間が 1 つなら「箱か入れ物の id」を 1 つのキーにできる |
| D143 | graph には木を全部書く（1 箱の入れ物・子が 1 つの段も）。つぶすのは見る側（`compactContainment`） | 地図は 1 箱の group も単位にする（基準で 13 のうち 7）。つぶした id は兄弟が増えると変わる |
| D144 | 木を作る関数は wiring に 1 つ（`deriveContainers`）。build が呼んで graph に書き、ビューアは `containers` の無い古い graph にだけ当てる。9-2 からは抽出器が直接出し、関数は残りを埋める | core は wiring に依存している。ビューアは core に依存しない。古い graph でも同じ id になる |
| D145 | 地図の単位は `unit` の印の付いた入れ物（と、その外の箱・枠）。地図 = 「`unit` を閉じた切り口 × レーン」の `foldView` を `mapScene` で 3D の入力に写したもの。3D の Viewer の入力の型は変えない | まとめ方を 1 つにする。v1 のファイルを開く道と Viewer を共有する |
| D146 | `projectMap` を消す前に、`mapScene` の出力が同じことをテストで確かめる。同じにならない・300 行を超えるなら止めて確認する | 地図の見た目を、気付かないまま変えない |
| D147 | 選択の種類は `box`・`host`・`container` の 3 つ（地図の `group` を `container` に寄せる）。メモ・`?sel=` は id だけ。メモの孤立 = 箱 ∪ 型 ∪ 入れ物に無い id | 8-8 の入れ物の選択と地図の group の選択が同じもの |
| D148 | `graph.v1.json` は 9-1b で書くのをやめる（Q24）。`build --v1` は v1 の段がある間だけ残す。v1 のファイルは今までどおり 3D だけで開く | ビューアは 8-6 から読んでいない。v1 の段が痩せる前に止める |
| D149 | ts-imports・go・api-link は「消す」ではなく、解析をアダプタへ「移す」。移行の間、アダプタはモジュール・パッケージの箱を v1 の段へも同じ id で出す | 3 つで 2,404 行のうち v1 にしか要らないのは約 850 行。v1 の段にある flows・overrides・`classify`・`deploy` を、v1 の段を消すまで動かし続ける |
| D150 | 型 API でも契約でも決まらない規則は**レシピ**にする: 名前・出所（`meta.by: "recipe:<名前>"`）・明示のキー・解けなければ未確定の一覧。当たっていない当て方は移さない（9-2a の最初に数える） | 出所の分からない線を無くす。「推定」の規約（D18）を保つ |
| D151 | 3 つを外すと開く 5 つの穴の行き先: 入れ物はアダプタ、TS の host・runtime は値の import → v2 の線の閉包、TS のルートはレシピ `route-table`、endpoint の host は join（IaC に書いてあること）、TS のテーブルは設定で明示 | §2.3 の表。fixture の数を変えずに外すため |
| D152 | `upgrade.ts` は 3 つに分けて消す: 箱の既定（`box-defaults`。IaC の profile は tf-graph）、置き場の段（`placeV2`）、古い入力の写し。残りの抽出器は v2 の部分を直接出す | 箱の単位の知識は抽出器の側、横断の処理は合流の後、v1 の語彙は入口だけに |
| D153 | 直す入力は 1 つの形: 今の `v2:` の語彙に `containers`・`views`・`types` を足す。新しい文法は作らない。ファイルは `stack-atlas.patch.yaml` と `.stack-atlas/graph/*.yaml` | 8-4 のドッグフードで確かめた語彙。当てる側（補いの段）が既にある |
| D154 | 直す入力のキーは「箱か入れ物の id」（項目は今までどおり `<箱>#<口>.<パス>`）。入れ物を指した線・始点は、今の group の規則で箱へ下ろす | v1 のファイルの単位の id が入れ物の id として生きる |
| D155 | 古い形（overrides.yaml の v1 のキー・flows.yaml）は、読み込みで新しい形に写して同じ当て方で当てる。警告を出す。`stack-atlas migrate` で書き換えられる（既定は書かない）。メモと regions は別のまま | 当てる側を 2 つ持たない。実リポジトリの側のファイルを、こちらから触らずに済む |
| D156 | graph.json の版は 2 のまま（Q22）。`containers`・`parent`・`unit` は足すだけ、`group`・`groups[]` は「読むが書かない」にする | 読む側は「無ければ作る」で両方開ける。版を上げると、ビューア・validate・diff に 3 つ目の分岐が要る |
| D157 | 順は 9-1a → 9-1b → 9-2a → 9-2b → 9-2c → 9-3 → 9-4。flows・v1 のキー・`deploy` を v2 で当てる写しの最小限だけ、9-2c の最後の PR に入れる | §3.10。v1 の段を消す条件だから |
| D158 | 各段の合格 = 基準の表（3 つの fixture）と同じ・違いは理由つき、実リポジトリは CLI で件数だけ。基準は JSON にしてテストで固定する | 数字を比べられる順に寄せる。実リポジトリの中身を読まない（Q17） |
| D159 | 9-4: 場面の状態を 1 つに（描画は SVG と three.js の 2 つのまま）、`group` を書かない、アダプタの結果のキャッシュ（手元の非公開の場所）、CLI を 1 ファイルに | 3D の Viewer は v1 のファイルを開くために残る。速くなるのは型検査を飛ばすキャッシュだけ |
