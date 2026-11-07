# 06. ロードマップ

## 結論

**表示部分を先に汎用化**し（Phase 1）、次に**ユーザーの実リポジトリ用の抽出器**を作る（Phase 2）。
画面（スクショ）・キャッシュ・フローはそのあとに段階的に足す。
各フェーズの最後で、ユーザーに実物を見せて方向を確認する。

## Phase 0 — リポジトリの準備

- [x] 未決事項 Q1（モノレポかどうか、パッケージマネージャ）をユーザーに確認 → pnpm モノレポ（docs/08 D1）
- [x] `docs/02-architecture.md` の推奨構成で雛形を作る（TypeScript、Vite、Vitest、ESLint）
- [x] `schema/graph.schema.json` から TypeScript の型を作る（手書きか json-schema-to-typescript） → 手書き。`packages/schema/src/types.ts`
- [x] CI: lint、型チェック、`scripts/validate-graph.mjs` によるサンプル検証 → `.github/workflows/ci.yml`（`pnpm validate`）

**完了条件**: `pnpm build` と `pnpm test` が通る。サンプル graph.json の検証が CI で通る。

## Phase 1 — ビューアの汎用化

- [x] プロトタイプの描画コードを `packages/viewer` へ移し、graph.json から組み立てる形にする（モジュール構成は docs/08 §3.3）
- [x] 入力: `?graph=` パラメータ、ドラッグ＆ドロップ、ファイル選択（検証結果の一覧表示つき）
- [x] 画面ノードの判定を `screen` フィールドに変える（kind が page / layout なら screen がなくても画面）。スクショがなければプレースホルダ（ルート名と regions の枠）。スクショは graph.json 基準の相対パスで遅延読み込み
- [ ] 自動レイアウト（重心ヒューリスティック＋層内の反発。`position` があれば優先）
- [x] ハイライト、フロー、キャッシュモード、パネル、メモ（localStorage のままで可）を `05-viewer-spec.md` どおりに実装する
- [x] 層の数が 4 以外でも動く（2〜6 層でテスト。e2e で 2・3・5・6 層を確認）
- [x] ハイライト規則（`closure`）のユニットテスト（`packages/viewer/src/graph/closure.test.ts`）

**完了条件**: `examples/race-site.graph.json` を読み込むと、プロトタイプと同等に見えて同じ操作ができる。
`position` を全部消しても、破綻しないレイアウトになる。

実装メモ（Phase 1）: ビューア本体・入力・検証表示・Playwright のスモークテスト（CI で実行）まで完了。スクリーンショットは `docs/images/phase1-*.png`。
後回しにしたもの: ラベルの間引き（LOD）・大規模 graph 向けの最適化（docs/08 §7）、孤立メモの一覧（Phase 5）、スクショの縮小（Phase 3）。
ユーザー確認待ち: ハイライト色（Q3）と見た目の方向（docs/08 §4「Phase 1 の途中で確認すること」）。

## Phase 2 — 実リポジトリへの適用（CDKtf ＋ Next.js ＋ TS）

- [ ] 未決事項 Q2: 対象リポジトリの構成を確認する
- [ ] 抽出器のインターフェース、マージ、overrides.yaml を `packages/core` に作る
- [ ] 抽出器: `cdktf`、`nextjs-app`、`ts-imports`
- [ ] CLI: `stack-atlas build <repo> -o graph.json`、`stack-atlas serve`
- [ ] `api-link` の第一版（取りこぼしは overrides で補う）

**完了条件**: ユーザーの実リポジトリで graph.json が生成され、ビューアで「Lambda の下に Next の全ルート、その下に部品と型」が見える。
ホバーのハイライトが実際の import 関係と一致する（抜き取りで確認）。

## Phase 3 — 実際の画面

- [ ] `screenshots` 抽出器（Playwright、動的ルートのサンプルパラメータ、認証用の storageState）
- [ ] `data-component` 属性から regions を取る。対象アプリへの付け方のガイドを書く
- [ ] ビューアでスクショのテクスチャを遅延読み込みする

**完了条件**: 実リポジトリの主要な画面が実際のスクショで表示され、部品のホバーが画面上の正しい位置で光る。

## Phase 4 — キャッシュとフロー

- [ ] `cache` 抽出器（CloudFront の behavior、Next の route config、fetch のオプション）とルールエンジン（二段キャッシュの鮮度など）
- [ ] `flows.yaml` の読み込み（未決事項 Q6）
- [ ] HIT／MISS／無効化のフローをテンプレート化する

**完了条件**: 実リポジトリの CloudFront の behavior と ISR 設定がバッジで正しく出て、主要な 2〜3 のフローが再生できる。

## Phase 5 — 共有

- [ ] メモの保存先を確定して実装（未決事項 Q4。memos.json を Git で共有する案が有力）
- [ ] 孤立メモの一覧
- [ ] 配信方法を確定（未決事項 Q5）。CI で graph.json とスクショとビューアをまとめてビルドし、社内の静的ホスティングへ出す
- [ ] 差分表示（前回の graph.json と比べて追加・削除されたノードを色分け）— PR レビューに使える

**完了条件**: チームメンバーが URL を開くだけで最新のマップとメモが見える。

## 後回し・アイデア

- Terraform / AWS CDK / SAM / Vite / Remix 用の抽出器
- エディタ連携（ノードから VS Code を開く、`vscode://file/...`）
- X-Ray / OpenTelemetry からのフロー自動生成
- 規模が大きいときの折りたたみ・フィルタ・LOD
- AI に質問できる機能（「この型を変えたら何が壊れる？」に graph で答える）
