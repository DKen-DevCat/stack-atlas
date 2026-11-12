# CLAUDE.md — Stack Atlas

このリポジトリで作業する Claude への指示書。最初に読むこと。

> **2026-11-11: 要件を改めた。正は `docs/24-requirements-v2.md`。**
> Stack Atlas は「本物の画面を見ながら挙動を選ぶと、その経路だけが光り、データが流れる」道具に絞る。コードを読む仕事は、利用者の手元のエージェントが受け持つ。道具の中に、特定の言語やフレームワークを前提にした処理を持たない。共有用の静的な全体図と要件整理は Claude Whiteboards に任せる。
> **要件・仕様・完成条件・手順書に、言語やフレームワークの名前を書かない**（docs/24 §4）。
> 下の「結論」「現在の状態」「リポジトリ内容」は、今あるコードの説明としては正しい。ただし、進む向き（抽出器を足す・Phase 9-L の 9-L1 以降）は止めた。コードを読む抽出器は、エージェントが書きこむ道が動いたあとで捨てる（消す前にユーザーに確かめる）。設計は `docs/25-design-screen-first.md`、エージェントが書く図の形は `docs/26-atlas-files.md`（契約 v0）、ライブ（本物のアプリを操作しながら見る。`stack-atlas live`）の設計は `docs/27-design-live.md`。実装は Phase 10（docs/06）の順で進めている。新しい道のコードは `packages/core/src/atlas/` と `stack-atlas check`、エージェントに渡す手順書は `harness/guide/`（言語やフレームワークの名前を書かない。例に、試しの対象の答えを書かない。どちらもテストが確かめる）、試しは `prototype/live/`。

## 結論（このプロジェクトは何か）

**Stack Atlas** は、リポジトリ（1 つでも複数でも）から「インフラ → 画面 → コンポーネント → 型」を抽出し、
層を Z 軸に積み重ねた 3D マップとして 1 画面で表示するツール。
ホバーで依存先・影響範囲が赤くハイライトされ、データフローとキャッシュの挙動がアニメーションで見え、ノードにメモを書ける。

現状: **Phase 0〜5（フィクスチャ `examples/fixture-repo/`）と Phase 7「どんな構成にもはめる」が完了**し、**Phase 6（実リポジトリへの適用）はグラフ生成まで完了**。
抽出器 15 個（files / cdktf / terraform / cloudformation / nextjs-app / ts-imports / ts-types / go / go-types / openapi / sql / api-link / cache / screenshots / screens。ts-types と go-types は v2 の言語アダプタ、screens はビルド成果物の画面）→ `graph.json` → ビューア、`stack-atlas` CLI（build / validate / serve / diff / init-flows / init-views / init --skill）、メモ共有・差分表示・配信テンプレートまで動く。
**Phase 8**（箱・口・項目・線の graph.json v2 と配線図、ハーネス）は 8-0〜8-7 が済んだ（`docs/06` の Phase 8、`HANDOFF.md` §0 の 2026-11-10 追記）。v2 の graph.json は WebGL があれば 2 面（左に 3D の地図 = `projectMap` で写したもの、右に配線図。選択と球を写し合う。`docs/20` §7）で開き、v1 は今までどおり 3D の地図だけ。
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
8''. Phase 8 の設計と実装結果: `docs/16-graph-v2-contract.md`（graph.json v2 の契約）、`docs/17-design-adapters.md`（言語アダプタと合流）、`docs/18-design-wiring-viewer.md`（配線図ビューア・画面・views、D60〜D81）、`docs/20-design-map-link.md`（8-6 の 3D の地図 ⇄ 配線図の 2 面。§6 Q20 の決定、§7 実装結果、D106〜D113）。8-7 の「選択で作り直さず付け替える」と半分の幅の部品は `docs/18` §11（D114〜D122、§11.14 実装結果と実測）
8'''. **`docs/19-design-harness-v2.md`** — Phase 8-4 のハーネス（補いの `v2:`・手書きの部分グラフ・views.yaml・`build --dry-run --json` / `--strict`・`init --skill`・`init-views`、D67〜D105。§11 ドッグフード、§12 レビューの修正）。skill の本文は `harness/skill/`（SKILL.md と references/）、隙間を仕込んだ fixture は `examples/fixture-gaps/`、その正解表は §9（**正解表と参照解 `packages/cli/src/__tests__/fixtures/gaps-answers/` を fixture-gaps の中や skill に書かない**。ドッグフードのエージェントが読む）
8''''. **`docs/23-design-any-repo.md`** — Phase 9-L: どのリポジトリ・どの構成にもはめる（ファイル・構文（tree-sitter）・型（LSP）の 3 段、言語ごとの違いはデータ、レシピ、線の `confidence`、実行の許可、D170〜D183、Q27〜Q33）。`docs/22-design-one-model.md` — Phase 9: モデルを 1 つに（包含の木・地図は畳みの段・アダプタの自立・直す入力を 1 つ、D140〜D159、Q22〜Q26）。**判断の基準: 「見たことのない言語の repo でも動くか」**（2026-11-11: 9-L1 以降は中止。この基準は「道具が言語を選ばない」として docs/24 に引き継いだ）
9. `docs/10-screenshots-guide.md`（`data-component` と screenshots の設定）、`docs/11-sharing.md`（メモ・差分・配信）、`docs/ci-example.yml`
10. 必要に応じて `docs/05-viewer-spec.md`（UI 仕様）、`docs/04-extractors.md`（抽出方法）、各 `extractors/*/README.md`

## 現在の状態と次のタスク

テストは `pnpm test` で 1684 件（skip 2。`STACK_ATLAS_REQUIRE_GO=1` で go の側も）、viewer の e2e は 71 件（skip 4。3D の地図の spec は手元のヘッドレスで止まる・遅いことがある。CI で実行。配線図だけを確かめる spec は `&pane=wiring`）。`examples/fixture-poly/`（2 repo の合成）は 56 ノード / 95 エッジ / 2 フロー / エラー 0。
実リポジトリでは設定を**この公開リポジトリの外**（兄弟ディレクトリ。`repos: { web: ../damage-web, platform: ../damage-platform }`）に置いて build し、149 / 330 / エラー 0 / 警告 0 を確認した（内訳は `HANDOFF.md` §0）。

次にやること（2026-11-11 から）: **docs/24 の要件 v2 の設計**（エージェントの書きこみ口・検査・画面から始めるビューア。docs/24 §7）。以下はそれより前の記録で、Phase 6 の残りのうち抽出器に依るものは進めない。

それより前の状態: ユーザーの判断待ち（Q17 エージェントを実リポジトリに当てるか、Q19 配線図の折りたたみ）。8-7（配線図の選択は付け替えるだけ）で fixture-poly はクリックから光るまで 50ms 以内になったが、合成 300 箱・実リポジトリの大きさは届いていない（docs/18 §11.14）。Phase 6 の残り:

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
- 抽出器を書くときの規約: 設定のパス・glob を読む前に `repoPath` / `confineRepoPath` / `globInRepo`（core。repo の外・外へ出るリンクを読まない）、walk はシンボリックリンクを辿らない（docs/19 §12、D102）。設定セクションは `sectionFor(ctx, config.xxx)` で自分の repo かを判定する。kind は `classifyKind(ctx, file, defaultKind)` で決めてから ID の接頭辞を付ける（`applyClassify` は ID を変えないため）。`file` は repo 相対パスで返す（複数 repo の `<repo>/` はパイプラインが付ける。自分で付けるなら `repoFile()`）。推定で線を引いたら必ず warn に `推定` と「明示できるキー」を書く（D18）。箱・型の `file` に出ないのに読んだファイル（型だけの TS・go.mod・.tfvars・next.config など）は `PartialGraph.read` で申告する（段 0 の報告が「読んだ」に数える。docs/23 §3.1・§11）。
- ビューアは graph.json だけを入力にし、特定プロジェクトの知識をハードコードしない。**ビューアは `@stack-atlas/core` に依存しない**（依存してよいのは `@stack-atlas/schema` と `@stack-atlas/wiring` だけ。たどる規則・球の時刻・レイアウト前処理は wiring に置く。D44）。
- スタック固有の処理はすべて抽出器（extractor）側に閉じ込める。
- 抽出器の契約は `packages/core/src/types.ts`。変えるときは core 側と各抽出器の両方を直す。
- graph.json を変えたら `packages/schema/graph.schema.json`・`packages/schema/src/types.ts`・`docs/03-graph-schema.md` を同時に更新し、
  `pnpm validate examples/race-site.graph.json` が通ること（型とスキーマのずれは `pnpm test` で検出される）。
- コミット前に `pnpm lint && pnpm typecheck && pnpm test` を通す（`pnpm build` も CI と同じ）。ビューアを触ったら `pnpm --filter @stack-atlas/viewer e2e` も（CI で実行される。Chromium が必要）。
- フィクスチャ（`examples/fixture-repo/`・`fixture-poly/`・`fixture-gaps/`）はワークスペース外。ID の規約は `examples/fixture-repo/README.md`。
- `harness/skill/` を変えたら `harness/skill/VERSION` を上げる（`init --skill --update` と SKILL.md の版の確かめが使う）。skill の例に fixture-gaps の答えの id を書かない（`harness.test.ts` が確かめる）。
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
  wiring/                          ← 配線図の規則（v2 の索引・たどる・選ぶ・球の時刻・切れている線）と地図の射影（projectMap・litOnMap・mapFlow）、挙動の見せ方（behaviorView）、ライブの純粋な計算（src/live/。docs/27）。純 TS、schema にだけ依存
  core/                            ← 抽出器の契約（src/types.ts）、repo / classify / deploy / merge / overrides / flows / rules/ / buildGraph()（src/pipeline.ts）、diff、memos
  tf-graph/                        ← IaC 共通: Terraform JSON → infra ノード・エッジ・cache（cdktf / terraform / cloudformation が使う）
  cli/                             ← stack-atlas コマンド（src/commands/ に build / validate / serve / diff / init-flows / init-views / init-skill、harness.ts）
  viewer/                          ← Vite + TypeScript + three.js の静的アプリ（src/graph・layout・scene・screen・ui・wiring（配線図）・split（2 面）、e2e/）
harness/skill/                     ← Claude Code の skill（SKILL.md・references/・templates/・VERSION）。`init --skill` のコピー元（docs/19 §3.5）
extractors/                        ← 15 個。CLI の順: files → cdktf → terraform → cloudformation → nextjs-app → ts-imports → ts-types → go → go-types → openapi → sql → api-link → cache → screenshots → screens
  files/  cdktf/  terraform/  cloudformation/   ← glob → ノード、インフラ層（CDKtf / HCL / CDK・SAM・CFn）
  nextjs-app/  ts-imports/  ts-types/  go/  go-types/  ← 画面層、TS のコンポーネント／型層、TS と Go の言語アダプタ（v2 の口・項目・線）、Go のパッケージ
  openapi/  sql/                                ← 契約: endpoint: と schema:
  api-link/  cache/  screenshots/  screens/     ← フロント→API 結線・キャッシュ情報・スクショと regions（READMEあり、screenshots は docs/10）・ビルド成果物の画面（消毒。docs/18 §3.3）
examples/
  fixture-repo/                    ← 合成モノレポ（CDKtf ＋ Next on Lambda ＋ TS。config / overrides / flows / memos / 手書き cdk.tf.json / site/）。ワークスペース外
  fixture-poly/                    ← 合成 2 リポジトリ（web: Next 静的エクスポート、platform: Go ＋ Terraform HCL ＋ OpenAPI ＋ SQL）。ワークスペース外
  fixture-gaps/                    ← fixture-poly に隙間（外部 API・map の body・OpenAPI に無い webhook・機能フラグ・任意のクエリ・PHP）と注入の文を仕込んだもの（ハーネスの確かめ用。正解表は docs/19 §9）
  race-site.graph.json             ← 手書きサンプル（プロトタイプのデータ）
docs/
  01〜07                           ← ビジョン・アーキテクチャ・スキーマ・抽出器・ビューア仕様・ロードマップ・既存ツール
  08-design-phase0-1.md  09-design-phase2-5.md  12-design-generalization.md   ← 設計と決定事項、末尾に実装結果
  10-screenshots-guide.md  11-sharing.md  13-apply-to-your-repo.md  ci-example.yml   ← 利用ガイドと CI テンプレート
  images/                          ← プロトタイプと phase1-* / phase5-* のスクリーンショット
prototype/                         ← 単一 HTML のプロトタイプ（three.js r160。参照用）
scripts/                           ← export-prototype-data / validate-graph（互換ラッパ）/ sync-samples
```

主なコマンド: `pnpm atlas build examples/fixture-repo -o out --with-viewer --no-screenshots`（または `examples/fixture-poly`）→ `pnpm atlas serve out`、`pnpm validate <graph.json>`、`pnpm dev`（ビューア開発サーバ）。新しい道（docs/25・docs/26）: `pnpm atlas check <dir>`（`<dir>/.stack-atlas/` の図を検査する。`--json`）、`pnpm atlas bundle <dir> [-o <outDir>]`（図を 1 つの graph.json にまとめる。`serve` で開ける）。ハーネス: `pnpm atlas build <repo> --dry-run --json`（止まったときも `{ error }` の JSON）/ `--strict --no-screenshots`、`pnpm atlas validate --strict <graph.json>`、`pnpm atlas init --skill <dir> [--update]`、`pnpm atlas init-views <repo>`（docs/13 §3.6b）。
