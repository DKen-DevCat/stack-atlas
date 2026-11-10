# 20. 設計: 3D の地図と配線図をつなぐ（Phase 8-6）

> **状態: 下書き（ユーザーの確認待ち）。実装はユーザーの確認（Q20）の後。** 8-6 の設計の案で、§5.2 の Q20 をモックかスクショで確かめてから決める。

作成: 2026-11-09。docs/15 §3.7（C の地図側）の**案 2「切り替える」**を作る（案 1「浮かび上がる」は後で育てる）。今は 3D の地図が graph.v1.json（v1 の抽出器の箱の単位）、配線図が graph.json（v2）を別々に開き、左上の文字のリンクで行き来するだけで、選択は引き継がれない。

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
