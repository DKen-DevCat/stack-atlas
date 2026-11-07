# 06. ロードマップ

## 結論

**表示部分を先に汎用化**し（Phase 1）、次に**ユーザーの実リポジトリ用の抽出器**を作る（Phase 2）。
画面（スクショ）・キャッシュ・フローはそのあとに段階的に足す。
各フェーズの最後で、ユーザーに実物を見せて方向を確認する。

## Phase 0 — リポジトリの準備

- [x] 未決事項 Q1（モノレポかどうか、パッケージマネージャ）をユーザーに確認 → pnpm モノレポ（docs/08 D1）
- [x] `docs/02-architecture.md` の推奨構成で雛形を作る（TypeScript、Vite、Vitest、ESLint）
- [x] `packages/schema/graph.schema.json` から TypeScript の型を作る（手書きか json-schema-to-typescript） → 手書き。`packages/schema/src/types.ts`
- [x] CI: lint、型チェック、`scripts/validate-graph.mjs` によるサンプル検証 → `.github/workflows/ci.yml`（`pnpm validate`）

**完了条件**: `pnpm build` と `pnpm test` が通る。サンプル graph.json の検証が CI で通る。

## Phase 1 — ビューアの汎用化

- [x] プロトタイプの描画コードを `packages/viewer` へ移し、graph.json から組み立てる形にする（モジュール構成は docs/08 §3.3）
- [x] 入力: `?graph=` パラメータ、ドラッグ＆ドロップ、ファイル選択（検証結果の一覧表示つき）
- [x] 画面ノードの判定を `screen` フィールドに変える（kind が page / layout なら screen がなくても画面）。スクショがなければプレースホルダ（ルート名と regions の枠）。スクショは graph.json 基準の相対パスで遅延読み込み
- [x] 自動レイアウト（重心ヒューリスティック＋層内の反発。`position` があれば優先）
- [x] ハイライト、フロー、キャッシュモード、パネル、メモ（localStorage のままで可）を `05-viewer-spec.md` どおりに実装する
- [x] 層の数が 4 以外でも動く（2〜6 層でテスト。e2e で 2・3・5・6 層を確認）
- [x] ハイライト規則（`closure`）のユニットテスト（`packages/viewer/src/graph/closure.test.ts`）

**完了条件**: `examples/race-site.graph.json` を読み込むと、プロトタイプと同等に見えて同じ操作ができる。
`position` を全部消しても、破綻しないレイアウトになる。

**達成状況**: 達成。`examples/race-site.graph.json` で確認（e2e と `docs/images/phase1-*.png`）。ハイライト色（Q3）は推奨案の 2 色で決定済み。

実装メモ（Phase 1）: ビューア本体・入力・検証表示・Playwright のスモークテスト（CI で実行）まで完了。スクリーンショットは `docs/images/phase1-*.png`。
後回しにしたもの: ラベルの間引き（LOD）・大規模 graph 向けの最適化（docs/08 §7）、孤立メモの一覧（Phase 5）、スクショの縮小（Phase 3）。
ユーザー確認待ち: ハイライト色（Q3）と見た目の方向（docs/08 §4「Phase 1 の途中で確認すること」）。

## Phase 2 — 実リポジトリへの適用（CDKtf ＋ Next.js ＋ TS）

- [x] 未決事項 Q2: 対象リポジトリの構成を確認する（Phase 6 で確認。構成は前提と違った）
- [x] 抽出器のインターフェース、マージ、overrides.yaml を `packages/core` に作る
- [x] 抽出器: `cdktf`、`nextjs-app`、`ts-imports`
- [x] CLI: `stack-atlas build <repo> -o graph.json`、`stack-atlas serve`
- [x] `api-link` の第一版（取りこぼしは overrides で補う）

**完了条件**: ユーザーの実リポジトリで graph.json が生成され、ビューアで「Lambda の下に Next の全ルート、その下に部品と型」が見える。
ホバーのハイライトが実際の import 関係と一致する（抜き取りで確認）。

**達成状況**: フィクスチャで達成（実リポジトリではない）。`stack-atlas build examples/fixture-repo` が graph.json（33 ノード、55 エッジ、3 フロー、検証エラー 0）を出し、race-site サンプルとの差はテストで固定。Q2 は未確認のため、実リポジトリでの確認は Phase 6。

## Phase 3 — 実際の画面

- [x] `screenshots` 抽出器（Playwright、動的ルートのサンプルパラメータ、認証用の storageState）
- [x] `data-component` 属性から regions を取る。対象アプリへの付け方のガイドを書く
- [x] ビューアでスクショのテクスチャを遅延読み込みする

**完了条件**: 実リポジトリの主要な画面が実際のスクショで表示され、部品のホバーが画面上の正しい位置で光る。

**達成状況**: フィクスチャの静的サイト（`examples/fixture-repo/site/`）で達成（e2e テストで regions を確認）。実アプリのスクショ（認証つき）は Phase 6。

## Phase 4 — キャッシュとフロー

- [x] `cache` 抽出器（CloudFront の behavior、Next の route config、fetch のオプション）とルールエンジン（二段キャッシュの鮮度など）
- [x] `flows.yaml` の読み込み（未決事項 Q6）
- [x] HIT／MISS／無効化のフローをテンプレート化する

**完了条件**: 実リポジトリの CloudFront の behavior と ISR 設定がバッジで正しく出て、主要な 2〜3 のフローが再生できる。

**達成状況**: フィクスチャで達成。CloudFront の behavior・ISR・SWR のバッジとルール、`flows.yaml`（miss / hit / invalidate）の再生を確認。実リポジトリの設定との一致は Phase 6。

## Phase 5 — 共有

- [x] メモの保存先を確定して実装（未決事項 Q4。memos.json を Git で共有する案が有力）
- [x] 孤立メモの一覧
- [x] 配信方法を確定（未決事項 Q5）。CI で graph.json とスクショとビューアをまとめてビルドし、社内の静的ホスティングへ出す
- [x] 差分表示（前回の graph.json と比べて追加・削除されたノードを色分け）— PR レビューに使える

**完了条件**: チームメンバーが URL を開くだけで最新のマップとメモが見える。

**達成状況**: ローカルで達成（`build --with-viewer` の出力を `serve` で配信し、メモ・孤立メモ・差分を確認）。S3 / CloudFront へのデプロイは `docs/ci-example.yml` のテンプレートまでで、実環境では未検証。配信先は未選定。

## Phase 6 — 実リポジトリへの適用

- [x] 未決事項 Q2 を確認する → `damage-web`（Next.js 16 App Router、静的エクスポート → S3 + CloudFront）＋ `damage-platform`（Go の Lambda ×5、素の Terraform HCL、Aurora、Cognito、EventBridge Scheduler、OpenAPI、SQL）。CDKtf ではなく、Next は Lambda 上ではなく、2 リポジトリ。前提が外れていたので Phase 7 で一般化した（`docs/12`）
- [x] `stack-atlas build <repo> -o out --with-viewer -v` を実行し、`detect()` と `stack-atlas.config.yaml` を合わせる
- [x] api-link の取りこぼし（`issues.json` の警告）を確認する → 取りこぼし 0（OpenAPI の 10 endpoint すべてが client の呼び出しと Go のハンドラに結べた）
- [ ] `screenshots` を設定する（`baseUrl`、動的ルートのサンプル、`storageState`）。対象アプリに `data-component` を付ける（`docs/10-screenshots-guide.md`）。起動したサイトが要る
- [x] キャッシュのバッジ: 静的エクスポート（`static export`）のバッジと CloudFront の behavior。実際の設定との突き合わせはユーザー確認待ち
- [ ] `stack-atlas init-flows` で雛形を作り、主要なフローを `flows.yaml` に書く（雛形は生成できる。実アプリの文は未作成）
- [ ] `docs/ci-example.yml` から CI を作り、配信先（S3 + CloudFront か `serve`）を決める（Q5）
- [x] 実リポジトリで出た差分を各抽出器の README に反映する（`docs/12` §6、`docs/13`）

**完了条件**: 実リポジトリの graph.json がビューアで開け、ホバーのハイライトとキャッシュのバッジが抜き取りで実際と一致する。チームが URL でマップとメモを見られる。

**達成状況**: グラフの生成までは達成。設定（`repos` が両 repo を指す）を**この公開リポジトリの外**に置いて `stack-atlas build` を実行し、**149 ノード / 330 エッジ / エラー 0 / 警告 0**。内訳は terraform 16 / 22（module インスタンス 11、リソース 70、未解決の参照 0）、nextjs-app 6 / 6、ts-imports 78 / 188、go 19 / 50、openapi 27 / 21、sql 7 / 14、api-link 7 / 30。
Lambda → Go 入口の推定 5 件、DB の推定、Function URL の呼び先の推定はすべて当たっていた（各 `推定` の警告は `deploy` / `sql.db` / `api.targets` で固定できる）。
ビューアでは endpoint を指すと route → コンポーネント → fetcher → endpoint → Go ハンドラ → テーブルが点灯した。ただし 150 ノードではレイアウトが密で読みにくい（Phase 7 の進行中項目）。
未了: スクショ、実アプリの flows、配信先、設定をどこに置くか（`HANDOFF.md` §0）。

## Phase 7 — どんな構成にもはめる

実リポジトリが Phase 0〜5 の前提（CDKtf ＋ Next on Lambda ＋ TS の API、単一 repo）と違ったので、「前提に合わないと何も出ない」状態をやめる。
パーサのあるものは自動、無いものは設定（`files` / `classify` / `kinds`）、取れない結線は overrides。設計は `docs/12-design-generalization.md`、使い方は `docs/13-apply-to-your-repo.md`。

- [x] 7-1 core: `repos` / `sectionFor` / `file` 修飾、`classify` / `files` / `kinds`、`deploy.*.{go,nodes}`・`app: next` の一般化、schema の `kinds`、viewer の kind レジストリ
- [x] 7-2 infra: `packages/tf-graph`、`extractors/terraform`（HCL、module、参照解決、root 自動検出、tfvars）、`extractors/cloudformation`（CDK / SAM / CFn）、許可リストの拡大と `infra.{include,exclude,all}`
- [x] 7-3 backend / 結線: `extractors/go`、`extractors/openapi`、`extractors/sql`、api-link の一般化（`api.clients` / `callers` / `targets`、ラッパー検出、endpoint 照合）、nextjs-app の `output: 'export'` / Pages Router / `route.ts`
- [x] 7-4 fixture: `examples/fixture-poly/`（Go ＋ Terraform HCL ＋ Next 静的エクスポート ＋ OpenAPI ＋ SQL の合成 2 repo。56 ノード / 95 エッジ / 2 フロー / エラー 0）
- [x] 7-5 統合: 実リポジトリで build（上の結果）、docs 更新（`docs/12` §6、`docs/13`）
- [ ] 7-6 ビューアの大規模 graph 対応（**進行中**）: レイアウトの広がり、ラベルの間引き（LOD）、検索ボックス。実リポジトリ 149 ノードで密になったのが発端
- [ ] 7-7 fixture-poly の end-to-end（`pnpm atlas build examples/fixture-poly`）を CI に足す（未着手）

**完了条件**: 設定だけで CDKtf / Terraform / CDK / SAM、Next、Go、OpenAPI、SQL の構成が 1 つの graph.json になり、パーサの無いものも `files` で載る。

**達成状況**: 7-1〜7-5 は達成（テスト 379 件）。7-6 は進行中、7-7 は未着手。

## 後回し・アイデア

- React fiber からの regions（`data-component` を付けられない場合）
- Vite / Remix / Python / Java など他のスタック用の抽出器（Terraform / AWS CDK / SAM / Go は Phase 7 で実装済み。それ以外は `files` で載せられる）
- エディタ連携（ノードから VS Code を開く、`vscode://file/...`）
- X-Ray / OpenTelemetry からのフロー自動生成
- 規模が大きいときの折りたたみ・フィルタ（LOD・検索は Phase 7-6 で進行中）
- AI に質問できる機能（「この型を変えたら何が壊れる？」に graph で答える）
