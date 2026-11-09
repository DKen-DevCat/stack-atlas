# CLAUDE.md — Stack Atlas

このリポジトリで作業する Claude への指示書。最初に読むこと。

## 結論（このプロジェクトは何か）

**Stack Atlas** は、リポジトリ（1 つでも複数でも）から「インフラ → 画面 → コンポーネント → 型」を抽出し、
層を Z 軸に積み重ねた 3D マップとして 1 画面で表示するツール。
ホバーで依存先・影響範囲が赤くハイライトされ、データフローとキャッシュの挙動がアニメーションで見え、ノードにメモを書ける。

現状: **Phase 0〜5（フィクスチャ `examples/fixture-repo/`）と Phase 7「どんな構成にもはめる」が完了**し、**Phase 6（実リポジトリへの適用）はグラフ生成まで完了**。
抽出器 14 個（files / cdktf / terraform / cloudformation / nextjs-app / ts-imports / ts-types / go / go-types / openapi / sql / api-link / cache / screenshots。ts-types と go-types は v2 の言語アダプタ）→ `graph.json` → ビューア、`stack-atlas` CLI（build / validate / serve / diff / init-flows）、メモ共有・差分表示・配信テンプレートまで動く。
ユーザーの実リポジトリ 2 つ（`damage-web`: Next 静的エクスポート → S3 + CloudFront、`damage-platform`: Go Lambda ×5 ＋ Terraform HCL ＋ OpenAPI ＋ SQL）で **149 ノード / 330 エッジ / エラー 0 / 警告 0**。
ビューアは 150〜250 ノードでも読めるよう、板の拡張・ラベルの LOD・検索・kind チップを実装済み。残りは実アプリのスクショ・flows の推敲・配信先。最初の単一 HTML プロトタイプ（`prototype/`）は参照用に残している。

## まず読む順番

1. `HANDOFF.md` — 現在地（§0）、経緯・決定事項・ユーザーの反応・未決事項（必読）
2. `docs/02-architecture.md` — アーキテクチャ（抽出器 → graph.json → ビューア）と実装状況
3. `docs/03-graph-schema.md` + `packages/schema/graph.schema.json` — 中間フォーマット
4. `docs/06-roadmap.md` — フェーズ別タスクと達成状況（Phase 6 の残りが次）
5. `docs/08-design-phase0-1.md` — Phase 0・1 の設計・決定事項 D1〜D8
6. `docs/09-design-phase2-5.md` — Phase 2〜5 の設計・決定事項 D9〜D13、設定ファイル（§3.3）
7. `docs/12-design-generalization.md` — Phase 6・7 の設計（複数 repo、Terraform / Go / OpenAPI / SQL、`classify` / `files` / `kinds`）、決定事項 D14〜D19、末尾に実装結果
8. `docs/13-apply-to-your-repo.md` — 実リポジトリへの適用ガイド（設定キー一覧、ID の規約、制限）
8'. **`docs/15-design-dataflow-model.md`** — Phase 8 の設計（箱・口・項目・線のモデル、たどる規則、表示の規則、分岐、型 API による抽出、D27〜D35）。`docs/14-design-harness.md` はハーネス配布・ビルド成果物の画面（層の節は docs/15 に置き換え）。モックは `prototype/dataflow-mock.html`
9. `docs/10-screenshots-guide.md`（`data-component` と screenshots の設定）、`docs/11-sharing.md`（メモ・差分・配信）、`docs/ci-example.yml`
10. 必要に応じて `docs/05-viewer-spec.md`（UI 仕様）、`docs/04-extractors.md`（抽出方法）、各 `extractors/*/README.md`

## 現在の状態と次のタスク

テストは `pnpm test` で 397 件、viewer の e2e は 20 件。`examples/fixture-poly/`（2 repo の合成）は 56 ノード / 95 エッジ / 2 フロー / エラー 0。
実リポジトリでは設定を**この公開リポジトリの外**（兄弟ディレクトリ。`repos: { web: ../damage-web, platform: ../damage-platform }`）に置いて build し、149 / 330 / エラー 0 / 警告 0 を確認した（内訳は `HANDOFF.md` §0）。

次にやること（`docs/06-roadmap.md` Phase 6 の未了）:

1. （完了）ビューアの大規模 graph 対応: 板の拡張、ラベル「すべて / 関連のみ / なし」と LOD、検索（`/`）、kind チップ
2. 実アプリのスクショ: サイトを起動し、`data-component` を付け、`screenshots`（`baseUrl` / `routes` / `storageState`）を書く
3. 実アプリの `flows.yaml`（`init-flows` で雛形は出る。文を直す）
4. 配信先（S3 + CloudFront か `serve`。Q5）と CI（`docs/ci-example.yml`）
5. 設定を `damage-web` にコミットするか、非公開の別ディレクトリに置くかをユーザーと決める
6. （完了）fixture-poly の end-to-end は CLI テストと CI で実行される（7-7）

## ユーザーについて

- フロントエンド寄りのエンジニア。Next.js / CloudFront / Lambda@Edge / CDKtf / CMS 連携を日常的に扱う。
- 職場で比較的大きな開発を主導しており、環境構築から担当。インフラ・バック・フロントはすべてコード管理されている。
  「ぶっちゃけ追いきれない」ので全体を 1 画面で見たい、というのが動機。
- 説明は **結論 → 全体像 → 構造 → 詳細** のトップダウンを好む。技術説明はまず「そのレイヤーがシステム全体のどこにあるか」から。
  ピンポイントなコード修正や短い確認は簡潔に。
- 日本語でやりとりする。

## 作業ルール

- 解析対象は業務コードになりうる。**ソースコードを外部 SaaS に送らない**。抽出もビューアもローカル／自前ホスティングで完結させる。
- **実リポジトリ（`damage-web` / `damage-platform`）の中身はこの公開リポジトリに入れない**: コード、リソース名、ルート、テーブル名、環境変数名、graph.json、スクショ、issues.json のいずれも。名前と件数だけ書いてよい。実リポジトリ用の config / overrides / flows は実リポジトリ側か非公開の兄弟ディレクトリに置く。
- 抽出器を書くときの規約: 設定セクションは `sectionFor(ctx, config.xxx)` で自分の repo かを判定する。kind は `classifyKind(ctx, file, defaultKind)` で決めてから ID の接頭辞を付ける（`applyClassify` は ID を変えないため）。`file` は repo 相対パスで返す（複数 repo の `<repo>/` はパイプラインが付ける。自分で付けるなら `repoFile()`）。推定で線を引いたら必ず warn に `推定` と「明示できるキー」を書く（D18）。
- ビューアは graph.json だけを入力にし、特定プロジェクトの知識をハードコードしない。**ビューアは `@stack-atlas/core` に依存しない**（依存してよいのは `@stack-atlas/schema` と `@stack-atlas/wiring` だけ。たどる規則・球の時刻・レイアウト前処理は wiring に置く。D44）。
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
  schema/                          ← graph.json の JSON Schema（正。v1 と v2）・型・validateGraph() / validateGraphV2()・検証 CLI
  wiring/                          ← 配線図の規則（v2 の索引・たどる・選ぶ・球の時刻・切れている線）。純 TS、schema にだけ依存
  core/                            ← 抽出器の契約（src/types.ts）、repo / classify / deploy / merge / overrides / flows / rules/ / buildGraph()（src/pipeline.ts）、diff、memos
  tf-graph/                        ← IaC 共通: Terraform JSON → infra ノード・エッジ・cache（cdktf / terraform / cloudformation が使う）
  cli/                             ← stack-atlas コマンド（src/commands/ に build / validate / serve / diff / init-flows）
  viewer/                          ← Vite + TypeScript + three.js の静的アプリ（src/graph・layout・scene・screen・ui、e2e/）
extractors/                        ← 14 個。CLI の順: files → cdktf → terraform → cloudformation → nextjs-app → ts-imports → ts-types → go → go-types → openapi → sql → api-link → cache → screenshots
  files/  cdktf/  terraform/  cloudformation/   ← glob → ノード、インフラ層（CDKtf / HCL / CDK・SAM・CFn）
  nextjs-app/  ts-imports/  ts-types/  go/  go-types/  ← 画面層、TS のコンポーネント／型層、TS と Go の言語アダプタ（v2 の口・項目・線）、Go のパッケージ
  openapi/  sql/                                ← 契約: endpoint: と schema:
  api-link/  cache/  screenshots/               ← フロント→API 結線・キャッシュ情報・スクショと regions（READMEあり、screenshots は docs/10）
examples/
  fixture-repo/                    ← 合成モノレポ（CDKtf ＋ Next on Lambda ＋ TS。config / overrides / flows / memos / 手書き cdk.tf.json / site/）。ワークスペース外
  fixture-poly/                    ← 合成 2 リポジトリ（web: Next 静的エクスポート、platform: Go ＋ Terraform HCL ＋ OpenAPI ＋ SQL）。ワークスペース外
  race-site.graph.json             ← 手書きサンプル（プロトタイプのデータ）
docs/
  01〜07                           ← ビジョン・アーキテクチャ・スキーマ・抽出器・ビューア仕様・ロードマップ・既存ツール
  08-design-phase0-1.md  09-design-phase2-5.md  12-design-generalization.md   ← 設計と決定事項、末尾に実装結果
  10-screenshots-guide.md  11-sharing.md  13-apply-to-your-repo.md  ci-example.yml   ← 利用ガイドと CI テンプレート
  images/                          ← プロトタイプと phase1-* / phase5-* のスクリーンショット
prototype/                         ← 単一 HTML のプロトタイプ（three.js r160。参照用）
scripts/                           ← export-prototype-data / validate-graph（互換ラッパ）/ sync-samples
```

主なコマンド: `pnpm atlas build examples/fixture-repo -o out --with-viewer --no-screenshots`（または `examples/fixture-poly`）→ `pnpm atlas serve out`、`pnpm validate <graph.json>`、`pnpm dev`（ビューア開発サーバ）。
