# CLAUDE.md — Stack Atlas

このリポジトリで作業する Claude への指示書。最初に読むこと。

## 結論（このプロジェクトは何か）

**Stack Atlas** は、リポジトリから「インフラ → 画面 → コンポーネント → 型」を抽出し、
層を Z 軸に積み重ねた 3D マップとして 1 画面で表示するツール。
ホバーで依存先・影響範囲が赤くハイライトされ、データフローとキャッシュの挙動がアニメーションで見え、ノードにメモを書ける。

現状は **Phase 0〜5 がフィクスチャリポジトリ（`examples/fixture-repo/`）に対して完了**している。
抽出器 → `graph.json` → ビューアの 3 部品、`stack-atlas` CLI（build / validate / serve / diff / init-flows）、メモ共有・差分表示・配信テンプレートまで動く。
次のゴールは **ユーザーの実リポジトリへの適用**（未決事項 Q2）。最初の単一 HTML プロトタイプ（`prototype/`）は参照用に残している。

## まず読む順番

1. `HANDOFF.md` — 現在地（§0）、経緯・決定事項・ユーザーの反応・未決事項（必読）
2. `docs/02-architecture.md` — アーキテクチャ（抽出器 → graph.json → ビューア）と実装状況
3. `docs/03-graph-schema.md` + `packages/schema/graph.schema.json` — 中間フォーマット
4. `docs/06-roadmap.md` — フェーズ別タスクと達成状況（Phase 6 が次）
5. `docs/08-design-phase0-1.md` — Phase 0・1 の設計・決定事項 D1〜D8
6. `docs/09-design-phase2-5.md` — Phase 2〜5 の設計・決定事項 D9〜D13、設定ファイル（§3.3）
7. `docs/10-screenshots-guide.md`（`data-component` と screenshots の設定）、`docs/11-sharing.md`（メモ・差分・配信）、`docs/ci-example.yml`
8. 必要に応じて `docs/05-viewer-spec.md`（UI 仕様）、`docs/04-extractors.md`（抽出方法）、各 `extractors/*/README.md`

## 現在の状態と次のタスク

Phase 0〜5 はフィクスチャに対して完了している（テストは `pnpm test` で 253 件、viewer の e2e は 18 件通過・3 件スキップ）。
**実リポジトリでは一度も動かしていない**。次は Phase 6（`docs/06-roadmap.md`）。着手前に最初に確認すること:

1. 未決事項 Q2: 対象リポジトリの構成（モノレポか、infra / web / api の分け方、CDKtf の synth 出力の有無、Next の `app/` の場所）
2. `stack-atlas build <repo> -o out --verbose` を実行し、`detect()` と config（`cdktf.out` / `next.appDir` / `ts.tsconfig` / `deploy` / `api.client`）が合っているか
3. api-link の取りこぼし（`build` の警告）を `stack-atlas.overrides.yaml` で補う
4. CloudFront の behavior と ISR 設定のバッジが実際の設定と一致するか（cache 抽出器とルール）
5. スクショ（`storageState` で認証、`data-component` の付与）、`flows.yaml`、CI（`docs/ci-example.yml`）
6. 配信先（S3 + CloudFront か `serve`）をユーザーと決める（Q5 は静的ビルドまで実装済みで、配信先は未選定）

## ユーザーについて

- フロントエンド寄りのエンジニア。Next.js / CloudFront / Lambda@Edge / CDKtf / CMS 連携を日常的に扱う。
- 職場で比較的大きな開発を主導しており、環境構築から担当。インフラ・バック・フロントはすべてコード管理されている。
  「ぶっちゃけ追いきれない」ので全体を 1 画面で見たい、というのが動機。
- 説明は **結論 → 全体像 → 構造 → 詳細** のトップダウンを好む。技術説明はまず「そのレイヤーがシステム全体のどこにあるか」から。
  ピンポイントなコード修正や短い確認は簡潔に。
- 日本語でやりとりする。

## 作業ルール

- 解析対象は業務コードになりうる。**ソースコードを外部 SaaS に送らない**。抽出もビューアもローカル／自前ホスティングで完結させる。
- ビューアは graph.json だけを入力にし、特定プロジェクトの知識をハードコードしない。**ビューアは `@stack-atlas/core` に依存しない**（`@stack-atlas/schema` だけ）。
- スタック固有の処理はすべて抽出器（extractor）側に閉じ込める。
- 抽出器の契約は `packages/core/src/types.ts`。変えるときは core 側と各抽出器の両方を直す。
- graph.json を変えたら `packages/schema/graph.schema.json`・`packages/schema/src/types.ts`・`docs/03-graph-schema.md` を同時に更新し、
  `pnpm validate examples/race-site.graph.json` が通ること（型とスキーマのずれは `pnpm test` で検出される）。
- コミット前に `pnpm lint && pnpm typecheck && pnpm test` を通す（`pnpm build` も CI と同じ）。ビューアを触ったら `pnpm --filter @stack-atlas/viewer e2e` も（CI で実行される。Chromium が必要）。
- フィクスチャ（`examples/fixture-repo/`）はワークスペース外。ID の規約は `examples/fixture-repo/README.md`。
- プロトタイプ（`prototype/`）は参照用として残す。新実装で置き換えても削除しない。
- UI の文言は日本語。

## リポジトリ内容

```
CLAUDE.md  HANDOFF.md  README.md   ← 作業指示・経緯と現在地・front page
package.json  pnpm-workspace.yaml  ← pnpm workspace のルート（build / test / lint / typecheck / validate / atlas / dev）
tsconfig.base.json  eslint.config.js  .prettierrc  .editorconfig  .nvmrc(22)
.github/workflows/ci.yml           ← lint・typecheck・test・build・サンプル検証・e2e
packages/
  schema/                          ← graph.json の JSON Schema（正）・型・validateGraph()・検証 CLI
  core/                            ← 抽出器の契約（src/types.ts）、merge / overrides / flows / rules/ / buildGraph()（src/pipeline.ts）、diff、memos
  cli/                             ← stack-atlas コマンド（src/commands/ に build / validate / serve / diff / init-flows）
  viewer/                          ← Vite + TypeScript + three.js の静的アプリ（src/graph・layout・scene・screen・ui、e2e/）
extractors/
  cdktf/  nextjs-app/  ts-imports/  ← インフラ層・画面層・コンポーネント／型層
  api-link/  cache/  screenshots/  ← フロント→API 結線・キャッシュ情報・スクショと regions（READMEあり、screenshots は docs/10）
examples/
  fixture-repo/                    ← 合成モノレポ（config / overrides / flows / memos / 手書き cdk.tf.json / site/）。ワークスペース外
  race-site.graph.json             ← 手書きサンプル（プロトタイプのデータ）
docs/
  01〜07                           ← ビジョン・アーキテクチャ・スキーマ・抽出器・ビューア仕様・ロードマップ・既存ツール
  08-design-phase0-1.md  09-design-phase2-5.md   ← 設計と決定事項、末尾に実装結果
  10-screenshots-guide.md  11-sharing.md  ci-example.yml   ← 利用ガイドと CI テンプレート
  images/                          ← プロトタイプと phase1-* / phase5-* のスクリーンショット
prototype/                         ← 単一 HTML のプロトタイプ（three.js r160。参照用）
scripts/                           ← export-prototype-data / validate-graph（互換ラッパ）/ sync-samples
```

主なコマンド: `pnpm atlas build examples/fixture-repo -o out --with-viewer --no-screenshots` → `pnpm atlas serve out`、`pnpm validate <graph.json>`、`pnpm dev`（ビューア開発サーバ）。
