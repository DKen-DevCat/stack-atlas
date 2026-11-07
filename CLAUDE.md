# CLAUDE.md — Stack Atlas

このリポジトリで作業する Claude への指示書。最初に読むこと。

## 結論（このプロジェクトは何か）

**Stack Atlas** は、リポジトリから「インフラ → 画面 → コンポーネント → 型」を抽出し、
層を Z 軸に積み重ねた 3D マップとして 1 画面で表示するツール。
ホバーで依存先・影響範囲が赤くハイライトされ、データフローとキャッシュの挙動がアニメーションで見え、ノードにメモを書ける。

現状は **単一 HTML のプロトタイプ**（`prototype/stack-atlas.html`）だけがあり、データは手書き。
次のゴールは **どんなプロジェクトにも適用できる汎用ツール** にすること。

## まず読む順番

1. `HANDOFF.md` — 経緯・決定事項・ユーザーの反応・未決事項（必読）
2. `docs/02-architecture.md` — 目標アーキテクチャ（抽出器 → graph.json → ビューア）
3. `docs/03-graph-schema.md` + `packages/schema/graph.schema.json` — 中間フォーマット
4. `docs/06-roadmap.md` — フェーズ別タスクと完了条件
5. `docs/08-design-phase0-1.md` — Phase 0・1 の設計、タスク一覧、決定事項（Git 連携セッションで作成）
6. 必要に応じて `docs/05-viewer-spec.md`（UI 仕様）、`docs/04-extractors.md`（抽出方法）

## 最初のタスク

`docs/06-roadmap.md` の **Phase 0 → Phase 1** から始める。
Phase 1 の完了条件は「`examples/race-site.graph.json` を読み込んだビューアが、プロトタイプと同等に描画される」こと。

着手前に `HANDOFF.md` の「未決事項」のうち Phase 1 に関係するもの（リポジトリ構成・パッケージマネージャ）をユーザーに確認する。

## ユーザーについて

- フロントエンド寄りのエンジニア。Next.js / CloudFront / Lambda@Edge / CDKtf / CMS 連携を日常的に扱う。
- 職場で比較的大きな開発を主導しており、環境構築から担当。インフラ・バック・フロントはすべてコード管理されている。
  「ぶっちゃけ追いきれない」ので全体を 1 画面で見たい、というのが動機。
- 説明は **結論 → 全体像 → 構造 → 詳細** のトップダウンを好む。技術説明はまず「そのレイヤーがシステム全体のどこにあるか」から。
  ピンポイントなコード修正や短い確認は簡潔に。
- 日本語でやりとりする。

## 作業ルール

- 解析対象は業務コードになりうる。**ソースコードを外部 SaaS に送らない**。抽出もビューアもローカル／自前ホスティングで完結させる。
- ビューアは graph.json だけを入力にし、特定プロジェクトの知識をハードコードしない。
- スタック固有の処理はすべて抽出器（extractor）側に閉じ込める。
- graph.json を変えたら `packages/schema/graph.schema.json`・`packages/schema/src/types.ts`・`docs/03-graph-schema.md` を同時に更新し、
  `pnpm validate examples/race-site.graph.json` が通ること（型とスキーマのずれは `pnpm test` で検出される）。
- コミット前に `pnpm lint && pnpm typecheck && pnpm test && pnpm build` を通す（CI と同じ）。
- プロトタイプ（`prototype/`）は参照用として残す。新実装で置き換えても削除しない。
- UI の文言は日本語。

## リポジトリ内容

```
CLAUDE.md                     ← これ
HANDOFF.md                    ← 経緯・決定事項・未決事項
README.md                     ← 概要と開発の始め方
package.json                  ← pnpm workspace のルート（build / test / lint / typecheck / format / validate）
pnpm-workspace.yaml
tsconfig.base.json            ← 各パッケージ共通の TypeScript 設定
eslint.config.js  .prettierrc  .editorconfig  .nvmrc(22)
.github/workflows/ci.yml      ← lint・typecheck・test・build・サンプル検証
packages/
  schema/                     ← @stack-atlas/schema
    graph.schema.json         ← JSON Schema (draft 2020-12)。これが正
    src/types.ts              ← graph.json の TypeScript 型（手書き）
    src/validate.ts           ← validateGraph()：スキーマ検証＋参照整合性チェック
    src/cli.ts                ← stack-atlas-validate <file...>（pnpm validate の実体）
  viewer/                     ← @stack-atlas/viewer（Vite + TypeScript + three.js。Phase 0 は空のアプリ）
docs/
  01-vision.md                ← ユーザーの元の要望と要件
  02-architecture.md          ← 目標アーキテクチャと現状の差分
  03-graph-schema.md          ← graph.json 仕様
  04-extractors.md            ← スタック別の抽出方法
  05-viewer-spec.md           ← ビューアの UI・インタラクション仕様（プロトタイプ準拠）
  06-roadmap.md               ← フェーズ別タスクと完了条件
  07-existing-tools.md        ← 既存ツール調査
  08-design-phase0-1.md       ← Phase 0・1 の設計とタスク一覧
  images/                     ← プロトタイプのスクリーンショット
prototype/
  stack-atlas.html            ← 動くプロトタイプ（three.js r160、単一ファイル。参照用）
  README.md
examples/race-site.graph.json ← プロトタイプのデータを graph.json に変換したもの
scripts/
  export-prototype-data.mjs   ← プロトタイプ → graph.json 変換
  validate-graph.mjs          ← 互換ラッパ（中身は packages/schema の CLI）
```
