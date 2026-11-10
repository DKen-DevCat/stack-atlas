# 20. 設計: 3D の地図と配線図をつなぐ（Phase 8-6）

> **状態: 2026-11-10 に実装（§7）。Q20 の決定（§6）どおり、モックのとおり ＋ 流れを両方の面で同期する（D106・D107）。**

作成: 2026-11-09。**Q20 は 2026-11-10 に決定（§6）**。docs/15 §3.7（C の地図側）の**案 2「切り替える」**を作る（案 1「浮かび上がる」は後で育てる）。今は 3D の地図が graph.v1.json（v1 の抽出器の箱の単位）、配線図が graph.json（v2）を別々に開き、左上の文字のリンクで行き来するだけで、選択は引き継がれない。

## 1. 結論

- **地図も graph.json（v2）から描く**。v2 を地図の形（v1 の Graph）に写す `projectMap(v2)` を `@stack-atlas/wiring` に置き、3D の Viewer はそれを読む（Viewer 自体は変えない）。graph.v1.json は互換のために出し続けるが、ビューアは使わない
- **地図は group で畳んだ俯瞰**: 地図の 1 ノード = v2 の group（`group ?? file のディレクトリ`）× runtime。関数の箱は地図に出さない（docs/15 §3.7「単位は箱。項目は出さない」を、関数の単位の v2 では group の単位に読み替える）。線は group の対ごとに束 1 本。層は `runtime` の語彙で、存在するものだけ（user・time が最上段、data が最下段）
- **1 つのページに 2 つの面**: 左に地図、右に配線図（境目はドラッグで動かせる）。地図でノードをクリックすると、配線図はその group の箱を選んだ状態になり流れが始まる。配線図で箱を選ぶと、地図はその箱の group のノードを光らせる。幅が 1100px 未満なら、面は 1 つで切り替え（今の文字のリンクの位置）
- 配線図の規則（選択中は hover が効かない、選択が最前面、補足のラベルを出さない）は両方の面に効く。地図の面の選択も同じ規則にする（今の 3D の hover のハイライトは、配線図の選択中は止める）

## 2. 構造

### 2.1 `projectMap(v2): Graph`（v1 の形）

| v1 | v2 から |
|---|---|
| `layers[]` | 存在する runtime（`user` `time` `browser` `edge` `build` `server` `data` `external`）。名前は配線図のレーンと同じ |
| `nodes[]` | (group, runtime) ごとに 1 つ。id は v1 の箱の id があればそれ（D56 で group の値は v1 の箱の id なので、メモと差分のキーがそのまま使える）、無ければ `group:<group>`。kind は中の箱の kind の多数決、名前は group の最後の段。中の箱が 1 つならその箱そのもの（id・kind・name・file・code） |
| `edges[]` | 箱をまたぐ線を (from group, to group) で束ねて 1 本。kind は via から（call・return・render・props → uses、http → http、sql → schema、deliver → deploy、event → flow）。reply の線は向きを戻して同じ束に入れる |
| host | host の箱（infra）はそのまま 1 ノード。中の group へ `deploy` の線 |
| `screen` | 画面の箱の `screen`（HTML は地図では使わない。screenshot があればそれ） |
| `cache` | cache の箱の `cache` |
| `meta.members` | 中の箱の id の一覧（選択を写すのに使う） |

決定的（同じ v2 から同じ v1）。`validateGraph`（v1）を通ること。

### 2.2 2 つの面

- `main.ts`: v2 の graph で WebGL が使えるとき、`mountSplit({ graph, mapGraph: projectMap(graph) })`。WebGL が無ければ配線図だけ（今のまま）
- 選択の写し:
  - 地図 → 配線図: ノードの `meta.members` を配線図の選択にする（複数の箱の選択。配線図の選択は今は 1 つなので、`select` を箱の集合に広げる。始点は集合で、球はそれぞれから出る）
  - 配線図 → 地図: 選んだ箱の group のノードを光らせ、経路上の箱の group も範囲として光らせる（光らない group は沈める）
  - 解除（Esc・空白のクリック）はどちらからでも両方を解く
- URL: `?sel=<box id>` で選択を共有する（どちらの面から開いても同じ選択）
- 境目: ドラッグで 25〜75%。位置は localStorage（読めなくても動く）
- 狭い画面（1100px 未満）: 面は 1 つ。左上の文字のリンク（`3D の地図` / `配線図`）で切り替え、選択は引き継ぐ

### 2.3 地図の見た目

- 今の 3D の Viewer のまま（層の板・ノード・線・LOD・検索・メモ・差分）。層は runtime の 8 値から存在するものだけ
- 地図の画面のノードは、screenshot があればそれ、無ければプレースホルダ（HTML のラスタライズは入れない。D62）

## 3. 受け入れ条件

- `projectMap` の単体テスト: fixture-poly の v2（8-2b の出力）で、層・ノード・線・メモのキーが期待どおり、v1 の検証エラー 0、決定的
- e2e: fixture-poly の v2 を開くと 2 つの面が出る。地図で `route:/` のノードをクリックすると、配線図で `route:/` が選ばれて球が流れる。配線図で `fn:getToday` をクリックすると、地図でその group のノードが光る。Esc で両方解ける。`?sel=` で開くと選ばれている。幅 1000px では面が 1 つで、リンクで切り替えると選択が引き継がれる
- 地図の hover の規則: 配線図で選んでいる間、地図の hover で何も変わらない

## 4. 決めたこと

| # | 決定 | 理由 |
|---|---|---|
| D74 | 地図も graph.json（v2）から `projectMap` で描く。graph.v1.json は互換のために出すが、ビューアは使わない | 同じ graph の 2 つの見え方（docs/15 §3.7）。選択を写すには id が同じ graph が要る |
| D75 | 地図の単位は group × runtime（中が 1 箱ならその箱） | 関数の単位の v2 をそのまま 3D に置くと数百のノードになる。group の id は v1 の箱の id（D56）なので、メモと差分がそのまま使える。group の畳みは地図の側で行い、配線図は全部開いたまま（D61・Q19 と両立） |
| D76 | 案 2（左右の 2 面、選択の写し）。狭い画面は切り替え | docs/15 §3.7 の「最初は案 2 で作って案 1 に育てる」 |

## 5. 設計レビューの記録（2026-11-09、実装前に 1 回）と、ユーザーの確認待ち

独立レビューの指摘 23 件（高 6・中 11・低 6）。**実装はユーザーの確認（Q20）の後**。docs/15 §3.7 は「モックを見てから決める」で、2 面の形・地図の光り方・地図から消えるものは、どれもユーザーが見ていない。

### 5.1 写す規則の直し（自分で決める）

1. 地図の単位は `group ?? 箱の id`（`group ?? ディレクトリ` だと `route:/` と `layout:/`、endpoint 8 つ、テーブル 3 つがまとまり、メモが孤立する）。group の値が `^[a-z]+:` に当たらないときだけ `group:` を前に付ける。regions の ref も同じ対応表で付け替える
2. 同じ group が複数の runtime にあるとき、中の箱がいちばん多い runtime が v1 の id を持ち、ほかは `<id>@<runtime>`。メモ・差分・`?sel=` は `@runtime` を外した id で引く
3. kind は id の接頭辞から v1 の語彙に戻す（route → page、layout、comp → component、hook、lib、handler、schema、infra、endpoint、actor、trigger → cron）。group になった v1 の箱の name・file を v2 に残す（トップの `groups`。契約の変更なので schema・types・docs/03・docs/16 を同時に）
4. 線を光らせる対応表は graph の外（`projectMap` が `{ graph, unitOf, members, edgeWires }` を返す。v1 の edge は追加のプロパティを持てない）
5. 逆向きにするのは往復の戻り（return・sql・http の reply）だけ。deliver はデータの向きのまま。束の kind は deploy ＞ http ＞ schema ＞ uses ＞ flow
6. 2 面のとき、地図は配線図の `LitSelection` を対応表で写したものだけで光らせる（v1 の閉包は使わない。8-1 で直した「共有の箱でほぼ全部が光る」が戻るため）
7. 選択の写し: 配線図 → 地図は光らせるだけ（地図の選択にしない）。地図のノードのクリックは `select` に `{ kind: 'group', id }` を足す（host と同じく中の箱ごとにたどって合わせる。始点の輪は中の箱それぞれ）
8. キーは最後に触った面へ。Esc は 1 か所で受けて両方を 1 回だけ解く
9. 狭い画面: 両方の面を置いたまま隠す（WebGL の context を作り直さない）。隠れた面は描画と再生を止める。最初に出すのは配線図。WebGL の生成に失敗したら配線図だけ
10. 3D は止まっている間は描かない。クリックから両方の面が光るまで 50ms 以内（fixture-poly と合成 300 箱）
11. Viewer の改修（大きさを面から ResizeObserver で取る、fixed の部品を面の中に、狭い判定は面の幅、光らせる・選択を知らせる・hover を止める口）を独立したタスクにする
12. メモの store は 1 つを両方の面で共有し、変更を通知する。孤立の判定は「v2 の箱 ∪ 型 ∪ group ∪ 地図のノード」。**8-6 は 8-3c（配線図のメモと差分）の後**
13. 差分: 前が v2 なら `projectMap(prev)` と比べる。前が v1 なら地図でも出さない（8-3c と同じ文言）。docs/ci-example.yml・docs/11・docs/13・README の `graph.v1.json` の記述を直す
14. v1 の入力（ドロップ、`--v1`、race-site、`?graph=graph.v1.json`）は今までどおり 3D だけで開く。2 面のときは「3D の地図」リンクを出さない
15. 地図の層は wiring の LANES（7 つ。user と time は 1 つ）と同じ順と色
16. `?sel=` は箱・地図のノード・host の id（URL エンコード）。`?view=` が勝つ。`replaceState` で更新
17. e2e の 1 面のテスト用に `?pane=wiring` を置く。変わるテスト（wiring.spec・built.spec・docs-screenshots）は理由をコメントに書く
18. 基準の graph は 8-2b の fixture-poly の出力を写して固定。境目は `role=separator`、矢印キーでも動く

### 5.2 Q20（ユーザーに確認すること。モックかスクショを見せてから）

1. 案 2（左右の 2 面、選択の写し）で作るか、案 1（浮かび上がる）か
2. 3D の地図にも配線図の規則（D31）を当てるか: 赤と橙の閉包をやめて範囲は不透明度だけ、選択中は hover を効かなくする、沈んだノードのラベルを消す。凡例・📝・差分のバッジ・フローの進行表示を残すか
3. 地図から型の層とフローのアニメーションが無くなる（型は配線図の型クリック、始点は views）。層を設定の層から runtime の層に替える
4. 地図の単位を「v1 の箱（group）」にする（§3.7 の「単位は箱」の読み替え。Q19 と一緒に）

## 6. Q20 の決定（2026-11-10、モックを見たユーザーの返事）

モック（`packages/viewer/mock-split.html`。左に 3D の地図、右に配線図、選択の写し、「今の地図 / 提案の規則」の切り替え）を見たユーザーの返事: **「いい感じです。どちらのペインで流した時も、両方同期して流れるようにして欲しいです」**。

- 1〜4（2 面・提案の規則・地図の単位・地図から選んだら配線図を始点まで動かす）はモックのとおりで進める
- **追加の要望: 流れを両方の面で同期する**（D77 と番号が重なるので D106）

| # | 決定 | 理由 |
|---|---|---|
| D106 | 球（流れ）は 1 つの時刻で両方の面に出す。時刻の正は配線図の `Player`（`schedule` と `tau`）で、地図はそれを写す: 配線図の線 w を球が t0〜t1 に通るとき、w が単位（group・host・箱）をまたぐなら、地図で w を含む束の線の上を同じ t0〜t1 に球が単位から単位へ動く。同じ単位の中の線は、地図ではその単位のノードの脈動（短く明るくする）にする。再生・停止・シーク・速度は配線図の再生バー 1 つで、地図の面には置かない。どちらの面で選んでも同じ選択から同じ schedule が作られる | ユーザーの要望。時刻の正を 1 つにすれば、ずれない。地図は束なので、1 通信 = 1 球（D33）は束の上でも保つ（同じ時刻に同じ束を通る球は 1 つにまとめる） |
| D107 | 地図の旧フローのアニメーション（flows.yaml の手順）は 2 面では出さず、D106 の流れに置き換える。v1 の graph を 3D だけで開いたときは今までどおり | §5.2 の 3（型の層とフローを地図から外す）を、ユーザーの要望で「フローは配線図と同じものを出す」に読み替える |

型の層は 2 面の地図から外す（§5.2 の 3 のまま。型は配線図の型クリック）。

## 7. 実装結果（2026-11-10）

### 7.1 結論

- v2 の graph.json は **WebGL があれば 2 面**で開く（左に 3D の地図、右に配線図。`packages/viewer/src/split/`）。WebGL が無い・作れない・`?pane=wiring` は配線図だけ、v1（ドロップ・`--v1`・race-site・`?graph=graph.v1.json`）は今までどおり 3D の地図だけ
- 地図は `projectMap(graph)`（`@stack-atlas/wiring`）を今の Viewer で描く。光り方は配線図の `LitSelection` を `unitOf` で写したものだけ（提案の規則 = D31 を地図に当てたもの。「今の地図 / 提案の規則」の切り替えは外した）
- **流れ（D106）**: 時刻の正は配線図の `Player`。`mapFlow(projection, schedule)` で球を束に写し、地図は同じ `tau` で描く。再生・停止・シーク・速さは配線図の再生バー 1 つ。地図の旧フローは 2 面では出さない（D107）
- モックの足場（`mock-split.html`・`mock-map.html`・`src/mock/`・`examples/map-mock/`・Viewer の `mock` フック）は外した。`projectMap`・group の選択・`onSelectionChange`・`reveal` は本実装の API として残した

### 7.2 構造（§5.1 の 18 項目の行き先）

| §5.1 | 実装 |
|---|---|
| #1・#2 単位と `@runtime` | `projectMap`（モックのまま）。メモ・差分・`?sel=` は `stripRuntime` した id で引く（地図の 📝 は `memoKey`、group の選択の id もメモのキー） |
| #3 kind と `groups` | v2 のトップに **`groups: [{ id, name, kind, file? }]`**（group になった v1 の箱の元の値。kind は v1 の語彙）。パイプライン（`groupInfosV2`）が書き、`graph-v2.schema.json`・`GroupInfoV2`・`validateGraphV2`（id の重複はエラー、どの箱の group でもない id・箱と同じ id は警告）・docs/16・docs/03 を同時に直した。`projectMap` は group のノードの名前・kind・file にこれを使う |
| #4 線の対応表 | `projectMap` が `{ graph, unitOf, members, unitKind, edges }` を返す（モックのまま） |
| #5 戻りの向き・束の kind | モックのまま |
| #6 地図の光り | `litOnMap`。地図の group を選んだときの始点は中の箱の単位から引く（選択の id は `@runtime` を外したメモのキーなので） |
| #7 選択の写し | 地図のクリック → `selectionForUnit`（箱・host・group。group は札の見出しに地図の名前 `label`）＋ `reveal`。配線図 → 地図は光らせるだけ |
| #8 キーと Esc | キー（Esc・`/`・`F`）は最後に `pointerdown`・`focusin` した面だけ（Viewer の `embed.keys`、配線図の `keys`）。選択は配線図の 1 か所にあり、どちらの面の Esc・空白のクリックも配線図の選択を 1 回解くだけ（地図はそれを写す） |
| #9 狭い画面 | 窓 1100px 未満で面を 1 つ（最初は配線図）。両方を置いたまま `visibility: hidden`、隠れた地図は描かず（`setHidden`）、隠れた配線図は球を描かない（`Player.setHidden`。時刻は進む）。題名の横のリンク（「3D の地図」/「配線図」）はページを移らずに面を切り替える |
| #10 止まっている間は描かない | `scene/frames.ts` の `framePlan`。カメラの寄せ・OrbitControls の慣性・層の展開・旧フロー・キャッシュの輪・地図の球のどれかが動いている間だけ毎フレーム描き、それ以外は見た目が変わったときに 1 回。3D だけのページにも効く |
| #11 Viewer の改修 | iframe は使わない。描く面（`.stage`）の大きさを ResizeObserver で取り（0 は無視）、fixed の部品は面に `transform` を掛けて面の中に閉じ込める。狭い並べ方は面の幅（`.viewer.narrow`、761px 未満。以前の `@media (max-width: 760px)` を置き換え）。口は `embed`（`lit`・`onSelect`・`hoverLocked`・`keys`・`memoKey`・`flow`・`onSwitchPane`）。2 面では右のパネル・凡例・孤立メモの一覧・旧フローを出さず、沈んだノードのラベルを消す |
| #12 メモ | `SharedMemoStore.subscribe`（変更の通知）。1 つの store を両方の面で共有。孤立の判定は「v2 の箱 ∪ 型 ∪ group ∪ 地図のノード」で、一覧は配線図の題名の横の 1 か所（「移す…」の候補にも地図のノード） |
| #13 差分 | 前が v2 なら地図は `projectMap(前)` と比べる。前が v1 なら地図は比べず、配線図は「前の graph が v1 です」。docs/ci-example.yml は前回の graph.json を退避するように直した（docs/11・docs/13・README も） |
| #14 v1 は 3D だけ | `viewFor` が `split` / `wiring` / `map` を返す。2 面では隣の graph.v1.json のリンクを出さない（配線図だけのときは今までどおり） |
| #15 層 | `projectMap` が LANES の順と色（`LANE_TINT`） |
| #16 `?sel=` | 地図のノード → host → 箱の順に解く（URL エンコード）。`?view=` が勝つ（`?sel=` を外す）。選択が変わるたびに `replaceState`（箱・host・group だけ。項目・線・型の選択は外す）。解けない値は警告の一覧に出して外す |
| #17 `?pane=wiring` | e2e の 1 面のテスト（wiring・wiring-views・screens・built）は `&pane=wiring`（理由はテストのコメント） |
| #18 基準の graph と境目 | 基準は 8-6 の fixture-poly の build（`packages/wiring/src/__tests__/fixtures/poly-86.v2.json`。groups 入り）。境目は `role=separator`、ドラッグと矢印キー（5% ずつ、25〜75%、localStorage） |

流れの写し（`packages/wiring/src/map-flow.ts`）:

- 配線図の描く球（`drawnBalls`。線ごとに最も早い区間）の線だけを見る。箱の中の対応は写さない
- 単位をまたぐ線 → その線を含む束の上を、同じ t0〜t1 に送る側の単位から受ける側の単位へ。戻り（束が逆向き）は束の向きと逆に進む。球が乗っている束はシアン
- 同じ束・同じ向きで時間の重なる球は 1 つ（t1 は遅い方。触れるだけはまとめない）
- 同じ単位の中の線 → その単位のノードの脈動（箱は emissive、画面は枠をシアンに寄せる。短い線でも 0.3 秒）
- 速さを変えると配線図が schedule を作り直し（`onClock`）、地図も写し直す。シーク・一時停止も `onClock` で地図に 1 回描かせる

### 7.3 モックから本実装で決めたこと（docs/20 §6 のモックの覚え）

| # | 決定 | 理由 |
|---|---|---|
| D108 | v2 のトップに `groups`（group になった v1 の箱の id・name・kind・file）。kind は v1 の語彙のまま | §5.1 #3。地図の 1 ノード = v1 の箱なので、名前と kind は v1 の値が正しい。v2 の kind の語彙（fn・helper）に直すと地図の色と形が v1 の地図と変わる |
| D109 | group の名前は `groups` の元の名前。ただし元の名前がほかの group と重なるとき（fixture-poly の `days/request.ts` と `spend/request.ts` がどちらも `request`）は、モックの「重ならない最後の段」（`days/request`）。`groups` の無い graph（手書きの v2）もモックの規則 | 2 面ではパネルを出さないので、同じ名前のノードを見分けられない |
| D110 | id の接頭辞が `infra:` でも、v2 で `trigger`・`actor` の箱そのもの（Scheduler など）は v2 の kind を v1 の語彙にしたもの（cron・actor）。接頭辞の表に無い箱（`fn:` の group の無い関数。fixture-poly の `fn:internal/domain.Sum`）は中の箱の v2 の kind の多数決を v1 の語彙に（fn → lib） | モックで見つけたこと。接頭辞だけで決めると Scheduler が infra の色になり、利用者・時刻の層の箱が infra に見える |
| D111 | 選択は配線図の 1 か所に持ち、地図は持たない（地図の Viewer の `selectedId` は使わない） | §5.1 #6・#8。Esc を 1 回で両方に効かせるには、選択の正が 1 つであればよい |
| D112 | 止まっている間は描かない規則を 3D だけのページにも当てる | 同じ Viewer。見た目は変わらない（3D だけのページの e2e はそのまま通る） |
| D113 | `?pane=wiring` は配線図だけで開く 1 面（e2e と、2 面を使わないとき）。狭い画面のどちらの面かは URL に書かない | §5.1 #17。面の切り替えは表示の都合で、共有する状態ではない |

### 7.4 数（fixture-poly の build。`STACK_ATLAS_REQUIRE_GO=1`）

| 項目 | 値 |
|---|---|
| v2 | 箱 71（枠 4）・線 143・型 18・view 2・**groups 13**（TS のファイルの箱 4・Go のパッケージの箱 9） |
| 地図（projectMap） | ノード 50（group 13・host 4）・束 81・層 5（利用者・時刻 / ブラウザ / エッジ・配信 / サーバー / データ）。v1 の検証はエラー・警告とも 0 |
| `route:/` を選ぶ | 地図で光る 18 ノード・束 20。地図の球 21（配線図の schedule の区間 62 のうち、線の描く球を束でまとめたもの）。脈動 0（下の「見つかったこと」） |
| クリックから両方の面が光るまで | fixture-poly: 32〜46ms（手元の Chrome、窓 1440×900、地図のクリック → 地図の次のフレーム）。合成 300 箱（`synthetic()`。箱 312・線 1000）: 170〜320ms |
| 止まっている間 | 開いた直後に 1 フレーム描いて止まる。一時停止・選択なしでもフレームは増えない（e2e で確かめる） |
| テスト | 単体 1307 → **1332**（skip 2）。viewer の e2e 48 → **58**（`split.spec.ts` 9 件、built.spec 1 件） |

### 7.5 見つかったこと

- **fixture-poly には同じ単位の中の線が無い**: 線はどれも単位（group・host・箱）をまたぐので、地図の脈動は fixture-poly では出ない（合成の graph と、today の手書きの v2 では出る）。テストで固定した
- **合成 300 箱では 50ms に届かない**（§5.1 #10 の目安）: 地図の側（`litOnMap` と見た目の当て直し）は 1ms 前後で、時間のほとんどは配線図の描き直し（選択のたびに SVG を全部 `innerHTML` で作り直す）と、その後の layout。配線図だけ（`?pane=wiring`）でも同じ graph で選択から次のフレームまで 140〜950ms（窓いっぱいの配線図の方が遅い）なので、2 面で遅くなったのではない。配線図の描き直しを差分（class の付け替え）にするのは 8-6 の外（次の作業の候補。ユーザーの判断）
- 3D の地図のフローの切り替えは、flows の無い graph でも「フローなし」のボタンだけ出ていた（`.seg` の `display: flex` が `hidden` に勝つ）。`.seg[hidden]` で直した（3D だけのページも）
- 配線図の球（SVG の `circle`）は `visibility` の属性を自分で持つので、親を `visibility: hidden` にしても透ける（狭い画面の隠れた配線図の球が地図の上に見えた）。隠れた面の球は `display: none`
- ヘッドレスの Chromium（手元の SwiftShader）は 1 秒に 1〜2 フレームしか出ないことがあるので、e2e は「描いた・描かない」を時間ではなくフレーム（`requestAnimationFrame`）の数で確かめる

### 7.6 残り

- 合成 300 箱の 50ms（配線図の描き直しを差分に。上の「見つかったこと」）
- 案 1「浮かび上がる」（docs/15 §3.7。地図と配線図が同じ空間）は後で育てる
- 2 面の地図は型の層を出さない（§5.2 の 3）。型は配線図の型クリックで見る
