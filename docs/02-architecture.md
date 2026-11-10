# 02. アーキテクチャ

## 結論

**抽出器（extractor） → 中間フォーマット（graph.json） → ビューア** の 3 部品に分ける。
スタックの違いはすべて抽出器が吸収し、ビューアは graph.json だけを知る。
今のプロトタイプは、この 3 つが 1 つの HTML に混ざっている状態。

## 全体像

```
 解析対象リポジトリ（repos: 1 つ以上。例 web / platform）
 ├─ infra/ (CDKtf / Terraform HCL / CDK・SAM・CFn) ┐
 ├─ web/   (Next.js App / Pages / 静的エクスポート)  │   ① 抽出器（12 個。抽出器 × repo の順に回す）
 ├─ src/   (TypeScript)   cmd/ internal/ (Go)        │      files / cdktf / terraform / cloudformation /
 ├─ openapi/ (契約)       migrations/ (SQL)          │      nextjs-app / ts-imports / go / openapi / sql /
 └─ そのほか（files の glob）                        ┘      api-link / cache / screenshots
                                         │  部分グラフを出力（file は複数 repo なら <repo>/<path>）
                                         ▼
                              ┌──────────────────────┐
                              │ マージ＋補正          │ ← classify（glob → kind / layer）、deploy（何に何が載るか）
                              │ （ID解決・重複統合）    │ ← stack-atlas.overrides.yaml（手書きの補正）
                              │                      │ ← flows.yaml（フロー定義）、kinds（追加 kind の見た目）
                              └──────────┬───────────┘
                                         ▼
                              ② graph.json（＋ shots/*.png）
                                         │
                                         ▼
                              ③ ビューア（静的 Web アプリ）
                                 three.js / 自動レイアウト / ハイライト /
                                 フロー / キャッシュ / メモ / 差分
                                         │
                                         ▼
                              memos.json（Git で共有）
```

## 構成要素

### ① 抽出器

- 1 つの抽出器 = 1 つの関心事。入力はリポジトリのパスと設定（`RepoContext`）、出力は**部分グラフ**（nodes と edges の断片）。設定の `repo` で対象 repo を絞れる（`sectionFor`）
- インフラの 3 抽出器（cdktf / terraform / cloudformation）はそれぞれの入力を Terraform JSON の形にして `packages/tf-graph`（純関数）に渡す。リソース → ノード、参照 → エッジ、CloudFront / API Gateway の cache はここに 1 つ
- 抽出器どうしは**ノード ID の規約**（`<kind>:<識別子>`）で合流する。たとえば ts-imports が出す `comp:ResultTable` と、screenshots が出す領域の `ref: comp:ResultTable` は同じノードを指す。OpenAPI の `endpoint:` は client（api-link）とサーバー（Go / Next のルート）の合流点
- 後続の抽出器は先行の結果を `upstream` で読める（api-link は infra / endpoint / Go のルートを参照する）。順序は `files → cdktf → terraform → cloudformation → nextjs-app → ts-imports → go → openapi → sql → api-link → cache → screenshots`
- 一覧と方法は `04-extractors.md`、各 `extractors/*/README.md`、使い方は `13-apply-to-your-repo.md`

### マージ＋補正

- 部分グラフを結合し、同じ ID のノードはフィールドを統合する
- `classify`（glob → kind / layer。ID は変えない）、`deploy`（infra ノード → 載っているもの。`app: next` / `handlers` / `go` / `nodes`）を当てる
- 静的解析で取れないつながり（利用者 → CloudFront など）は `stack-atlas.overrides.yaml` で補う
- パーサの無い言語は `files`（glob → ノード）で載せ、未知の kind は `kinds` で見た目と層を決める
- フロー定義は人が `flows.yaml` に書く。ステップのノード ID を並べるだけ

### ② graph.json

- 仕様は `03-graph-schema.md`、JSON Schema は `packages/schema/graph.schema.json`
- スクショは graph.json からの相対パスで参照する

### ③ ビューア

- graph.json を読み込んで描くだけ。プロジェクト固有の知識を持たない
- 入力方法: URL パラメータ（`?graph=./graph.json`）、ドラッグ＆ドロップ、CLI の `serve` から配信
- UI・インタラクション仕様は `05-viewer-spec.md`（プロトタイプの挙動を仕様化したもの）

## 実装状況

プロトタイプからの汎用化は Phase 0〜5 でフィクスチャに対して完了し、Phase 7 で複数 repo と他のスタックに広げ、Phase 6 で実リポジトリ 2 つに適用した（`docs/06-roadmap.md`）。

| 部分 | プロトタイプの状態 | 実装後の状態 |
|---|---|---|
| 3D 描画、ハイライト、メモ、フローのアニメーション | ほぼ汎用 | `packages/viewer` が graph.json から組み立てる（実装済み） |
| 層の数・色 | `LAYERS` 配列で可変 | graph.json の `layers` から読む。2〜6 層で e2e 確認（実装済み） |
| ノード配置（x, z） | 手置き | 自動レイアウト（`layout/auto.ts`、決定的）。`position` があれば優先（実装済み） |
| 画面ノードの判定 | `L === 1` 固定 | `screen` フィールド、または `kind` が `page` / `layout`（実装済み） |
| 画面の中身 | ページ ID ごとの Canvas 描画関数 | `screen.screenshot` ＋ `regions`。無ければプレースホルダ（実装済み） |
| ノードの関係データ | 手書きの `NODES` / `EDGES` | 抽出器 12 個（インフラ 3 種、Next、TS、Go、OpenAPI、SQL、api-link、files…）＋ classify / deploy / overrides（実装済み） |
| 複数リポジトリ | — | `repos` で宣言。`file` を `<repo>/<path>` で修飾（実装済み。Phase 7） |
| 未知の kind | — | graph.json の `kinds` をビューアの kind レジストリにマージ（実装済み） |
| キャッシュ | 手書きの `CACHE` | cdktf・nextjs-app・api-link・cache 抽出器と core のルールエンジン（実装済み） |
| フロー | 手書きの `FLOWS` | `flows.yaml`（`init-flows` で雛形）（実装済み） |
| スクショ・領域 | ダミー画面 | screenshots 抽出器（Playwright、`data-component`）（実装済み） |
| メモ | localStorage | `.stack-atlas/memos.json`（Git 共有）、`serve` の書き戻し、孤立メモ一覧（実装済み） |
| 差分・配信 | なし | `?prev=` と `stack-atlas diff`、`build --with-viewer`、`docs/ci-example.yml`（実装済み） |
| ノード ID | 短い独自名 | `<kind>:<識別子>` 規約（実装済み） |
| 実リポジトリでの動作 | — | 実リポジトリ 2 つで 149 ノード / 330 エッジ / エラー 0（Phase 6）。150 ノードでのレイアウト・LOD・検索は**進行中**、エディタ連携は未着手 |

## 自動レイアウトの方針（Phase 1）

ノード数が増えると手置きは不可能。層ごとに 2 次元平面上の配置を決める。

1. **層をまたぐ親子の整列**: 下の層のノードを、つながっている上の層のノードの (x, z) の重心付近に置く（Sugiyama 法の重心ヒューリスティック）。これで「Lambda の真下に Next の画面群」が自然にできる
2. **層内の重なり解消**: 重心で決めた位置から、d3-force などで反発力をかけて重なりを解く。Y は層の高さに固定
3. **グループ化**: 同じ親（同じ Lambda に deploy されるルート群など）を矩形の島としてまとめる
4. `position` があるノードは固定（手で調整したい人向け）

最初は 1＋2 で十分。プロトタイプの手置き座標は、自動レイアウトの見た目を評価する基準として使える。

## リポジトリ構成（このツール自体）

pnpm モノレポ（docs/08 D1）。`examples/fixture-repo/` はワークスペース外。

```
project-map/
  packages/
    schema/          graph.json の JSON Schema（正）・型・validateGraph()・検証 CLI
    core/            抽出器の契約（src/types.ts）、repo / classify / deploy、マージ、overrides、flows、ルールエンジン（src/rules/）、buildGraph()、diff、memos
    tf-graph/        IaC 共通: Terraform JSON → infra ノード・エッジ・cache
    cli/             stack-atlas コマンド（build / validate / serve / diff / init-flows）
    viewer/          Vite + TypeScript + three.js。graph.json だけを読む静的アプリ（core に依存しない）
  extractors/
    files/           glob → ノード（パーサの無いもの）
    cdktf/           インフラ層（cdk.tf.json）
    terraform/       インフラ層（HCL。module と参照の解決）
    cloudformation/  インフラ層（CDK / SAM / CFn）
    nextjs-app/      画面層（App Router / Pages Router / 静的エクスポート）
    ts-imports/      コンポーネント層・型層（ts-morph）
    go/              Go のパッケージとルート
    openapi/         endpoint: と schema の type:
    sql/             CREATE TABLE → schema:
    api-link/        フロント → API の結線
    cache/           SWR / React Query / ISR / fetch のキャッシュ情報
    screenshots/     Playwright でスクショと regions
  examples/
    fixture-repo/    合成モノレポ（Phase 2〜5 の入力。CDKtf ＋ Next on Lambda ＋ TS）
    fixture-poly/    合成 2 リポジトリ（Phase 7 の入力。Go ＋ HCL ＋ Next 静的エクスポート ＋ OpenAPI ＋ SQL）
    race-site.graph.json
  docs/  prototype/  scripts/
```
