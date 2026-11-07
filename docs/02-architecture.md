# 02. アーキテクチャ

## 結論

**抽出器（extractor） → 中間フォーマット（graph.json） → ビューア** の 3 部品に分ける。
スタックの違いはすべて抽出器が吸収し、ビューアは graph.json だけを知る。
今のプロトタイプは、この 3 つが 1 つの HTML に混ざっている状態。

## 全体像

```
 解析対象リポジトリ
 ├─ infra/  (CDKtf)        ┐
 ├─ apps/web (Next.js)     │   ① 抽出器（スタックごとのプラグイン）
 ├─ apps/api               │      cdktf / nextjs-app-router / ts-imports /
 └─ packages/types         ┘      api-link / cache / screenshots
                                         │  部分グラフを出力
                                         ▼
                              ┌──────────────────────┐
                              │ マージ＋補正          │ ← stack-atlas.overrides.yaml（手書きの補正）
                              │ （ID解決・重複統合）    │ ← flows.yaml（フロー定義）
                              └──────────┬───────────┘
                                         ▼
                              ② graph.json（＋ shots/*.png）
                                         │
                                         ▼
                              ③ ビューア（静的 Web アプリ）
                                 three.js / 自動レイアウト / ハイライト /
                                 フロー / キャッシュ / メモ
                                         │
                                         ▼
                              memos.json（Git で共有する案）
```

## 構成要素

### ① 抽出器

- 1 つの抽出器 = 1 つの関心事。入力はリポジトリのパスと設定、出力は**部分グラフ**（nodes と edges の断片）
- 抽出器どうしは**ノード ID の規約**（`<kind>:<識別子>`）で合流する。たとえば ts-imports が出す `comp:ResultTable` と、screenshots が出す領域の `ref: comp:ResultTable` は同じノードを指す
- 想定する抽出器の一覧と方法は `04-extractors.md`

### マージ＋補正

- 部分グラフを結合し、同じ ID のノードはフィールドを統合する
- 静的解析で取れないつながり（フロント → API など）は `stack-atlas.overrides.yaml` で補う
- フロー定義は人が `flows.yaml` に書く。ステップのノード ID を並べるだけ

### ② graph.json

- 仕様は `03-graph-schema.md`、JSON Schema は `packages/schema/graph.schema.json`
- スクショは graph.json からの相対パスで参照する

### ③ ビューア

- graph.json を読み込んで描くだけ。プロジェクト固有の知識を持たない
- 入力方法: URL パラメータ（`?graph=./graph.json`）、ドラッグ＆ドロップ、CLI の `serve` から配信
- UI・インタラクション仕様は `05-viewer-spec.md`（プロトタイプの挙動を仕様化したもの）

## 実装状況

プロトタイプからの汎用化は Phase 0〜5 でフィクスチャに対して完了している（`docs/06-roadmap.md`）。

| 部分 | プロトタイプの状態 | 実装後の状態 |
|---|---|---|
| 3D 描画、ハイライト、メモ、フローのアニメーション | ほぼ汎用 | `packages/viewer` が graph.json から組み立てる（実装済み） |
| 層の数・色 | `LAYERS` 配列で可変 | graph.json の `layers` から読む。2〜6 層で e2e 確認（実装済み） |
| ノード配置（x, z） | 手置き | 自動レイアウト（`layout/auto.ts`、決定的）。`position` があれば優先（実装済み） |
| 画面ノードの判定 | `L === 1` 固定 | `screen` フィールド、または `kind` が `page` / `layout`（実装済み） |
| 画面の中身 | ページ ID ごとの Canvas 描画関数 | `screen.screenshot` ＋ `regions`。無ければプレースホルダ（実装済み） |
| ノードの関係データ | 手書きの `NODES` / `EDGES` | 抽出器 cdktf / nextjs-app / ts-imports / api-link ＋ overrides（実装済み） |
| キャッシュ | 手書きの `CACHE` | cdktf・nextjs-app・api-link・cache 抽出器と core のルールエンジン（実装済み） |
| フロー | 手書きの `FLOWS` | `flows.yaml`（`init-flows` で雛形）（実装済み） |
| スクショ・領域 | ダミー画面 | screenshots 抽出器（Playwright、`data-component`）（実装済み） |
| メモ | localStorage | `.stack-atlas/memos.json`（Git 共有）、`serve` の書き戻し、孤立メモ一覧（実装済み） |
| 差分・配信 | なし | `?prev=` と `stack-atlas diff`、`build --with-viewer`、`docs/ci-example.yml`（実装済み） |
| ノード ID | 短い独自名 | `<kind>:<識別子>` 規約（実装済み） |
| 実リポジトリでの動作 | — | **未検証**（Phase 6）。Terraform / CDK / SAM などの抽出器、LOD、エディタ連携は未着手 |

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
    core/            抽出器の契約（src/types.ts）、マージ、overrides、flows、ルールエンジン（src/rules/）、buildGraph()、diff、memos
    cli/             stack-atlas コマンド（build / validate / serve / diff / init-flows）
    viewer/          Vite + TypeScript + three.js。graph.json だけを読む静的アプリ（core に依存しない）
  extractors/
    cdktf/           インフラ層（cdk.tf.json）
    nextjs-app/      画面層（App Router）
    ts-imports/      コンポーネント層・型層（ts-morph）
    api-link/        フロント → API の結線
    cache/           SWR / React Query / ISR / fetch のキャッシュ情報
    screenshots/     Playwright でスクショと regions
  examples/
    fixture-repo/    合成モノレポ（Phase 2〜5 の入力）
    race-site.graph.json
  docs/  prototype/  scripts/
```
