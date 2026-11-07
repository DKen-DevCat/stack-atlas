# 引き継ぎ資料 — Stack Atlas

作成: 2026-11-07（チャットセッションから Git 連携セッションへの引き継ぎ）

## 0. 現在地（2026-11-07 Phase 6・7 後）

### 結論

Phase 0〜5 は **フィクスチャ（`examples/fixture-repo/`）に対して完了**。Q2 を確認したところ実リポジトリは前提（CDKtf ＋ Next on Lambda ＋ TS、単一 repo）と違ったので、**Phase 7「どんな構成にもはめる」**（`docs/12-design-generalization.md`）で複数 repo・Terraform HCL・CDK/SAM・Go・OpenAPI・SQL・`files` / `classify` / `kinds` に一般化し、**Phase 6 の実リポジトリへの適用はグラフ生成まで完了**した（149 ノード / 330 エッジ / エラー 0 / 警告 0）。
残りは、ビューアの大規模 graph 対応（**進行中**）、実アプリのスクショ・flows、配信先（Q5）、設定の置き場。使い方は `docs/13-apply-to-your-repo.md`。以降の §1〜§7 は引き継ぎ時点の記録（履歴）として残している。

**2026-11-08 追記（Phase 8）**: 実リポジトリの地図を見たユーザーの要望で、モデルを「箱・口・項目・線」に作り直すことになった（`docs/15-design-dataflow-model.md`、D27〜D35、承認済み）。配布（ハーネス）とビルド成果物の画面は `docs/14-design-harness.md`。モック `prototype/dataflow-mock.html`（6 版）で規則を検証した。次は `docs/06` の Phase 8（8-1 契約 → 8-2 抽出 → 8-3 配線図 → 8-4 ハーネス → 8-5 実リポジトリ → 8-6 地図）。

### フェーズごとに作ったもの

| Phase | 成果物 |
|---|---|
| 0 | pnpm モノレポ、`packages/schema`（JSON Schema・型・`validateGraph()`・検証 CLI）、CI |
| 1 | `packages/viewer`: graph.json 入力（`?graph=`・ドロップ・ファイル選択）、自動レイアウト、ハイライト、フロー、キャッシュモード、パネル、スクショ表示、スマホ幅、e2e |
| 2 | `packages/core`（契約・マージ・overrides・flows・層割り当て・`buildGraph()`）、`packages/cli`、`extractors/{cdktf,nextjs-app,ts-imports,api-link}`、`examples/fixture-repo/` |
| 3 | `extractors/screenshots`（Playwright、`data-component` → regions、storageState）、`docs/10-screenshots-guide.md` |
| 4 | `extractors/cache`、core のルールエンジン、`flows.yaml` の読み込み、`stack-atlas init-flows` |
| 5 | メモ共有（`memos.json`・`serve` の書き戻し・孤立メモ）、差分表示（`?prev=`・`stack-atlas diff`）、`build --with-viewer`、`docs/ci-example.yml`、`docs/11-sharing.md` |
| 7 | core の `repos` / `sectionFor` / `classify` / `files` / `kinds` / `deploy.*.{go,nodes}`、`packages/tf-graph`、`extractors/{files,terraform,cloudformation,go,openapi,sql}`、api-link / nextjs-app / ts-imports の一般化、`examples/fixture-poly/`、`docs/12`・`docs/13` |
| 6 | 実リポジトリ 2 つで build（設定は公開リポジトリの外）。推定（Lambda → Go 入口 ×5、DB、Function URL の呼び先）はすべて正解。ビューアで route → コンポーネント → fetcher → endpoint → Go ハンドラ → テーブルが点灯 |

### テスト（2026-11-07 実測）

- `pnpm test`: 379 件（schema 18 / core 86 / viewer 88 / cli 27 / tf-graph 12 / files 6 / cdktf 9 / terraform 9 / cloudformation 10 / nextjs-app 14 / ts-imports 10 / go 13 / openapi 8 / sql 9 / api-link 27 / cache 15 / screenshots 18）
- `pnpm --filter @stack-atlas/viewer e2e`: 18 件（Chromium が必要）
- `pnpm atlas build examples/fixture-poly -o out --no-screenshots`: 56 ノード / 95 エッジ / 2 フロー / エラー 0 / 警告 0
- 実リポジトリ（非公開）: 149 ノード / 330 エッジ / エラー 0 / 警告 0。terraform 16 / 22（module インスタンス 11、リソース 70、未解決の参照 0）、nextjs-app 6 / 6、ts-imports 78 / 188、go 19 / 50、openapi 27 / 21（endpoint 10、すべて client と Go ハンドラに結べた）、sql 7 / 14、api-link 7 / 30

### 動かし方

```sh
pnpm install && pnpm build
pnpm atlas build examples/fixture-repo -o out --with-viewer --no-screenshots   # 1 repo（CDKtf）
pnpm atlas build examples/fixture-poly -o out --with-viewer --no-screenshots   # 2 repo（Go ＋ HCL ＋ Next 静的エクスポート）
pnpm atlas serve out        # http://127.0.0.1:4173/
pnpm dev                    # ビューアの開発サーバ。?graph=samples/race-site.graph.json
```

コマンドの一覧は `README.md`、自分のリポジトリへの適用方法は `docs/13-apply-to-your-repo.md`。

### 決定事項 D1〜D19

- D1〜D8（pnpm モノレポ、handoff のルート展開、画面ノードの判定、three.js 同梱、決定的な自動レイアウト、型は手書きでスキーマが正、検証エラーでも描画継続、メモの保存先を差し替え可能に）: `docs/08-design-phase0-1.md` §5
- D9〜D13（フィクスチャで Phase 2〜5 を完了、抽出器は順次実行、cdk.tf.json は手書き、設定は YAML 1 ファイル、メモの正は `.stack-atlas/memos.json`）: `docs/09-design-phase2-5.md` §5
- D14〜D19（`repos` と `<repo>/` 修飾、HCL は hcl2json で tf-graph へ、Go は toolchain なしのパッケージ単位、OpenAPI の `endpoint:` を結線の合流点に、推定は設定で上書きでき必ず warn、`files` / `classify` / `kinds` で最低保証）: `docs/12-design-generalization.md` §4
- 設計からのずれは各文書末尾の「実装結果」を参照（`docs/12` §6 に Terraform の ID 衝突規則、`meta.infra` と `meta.cdktf`、抽出器が外側のループ、`deploy` のエラー、openapi の重複排除、ラッパー検出など）。

### 未決事項（更新後）

| # | 論点 | 状態 |
|---|---|---|
| Q1 / Q1' | リポジトリ構成・handoff の展開 | **決定済み（推奨案）**: pnpm モノレポ、ルートに展開（D1・D2） |
| Q2 | 最初に解析する実リポジトリ | **確認済み**: `damage-web`（Next.js 16 App Router、`output: "export"` → S3 + CloudFront、ブラウザから fetcher 経由で Lambda Function URL を呼ぶ）＋ `damage-platform`（Go の Lambda ×5、素の Terraform HCL の `envs/{dev,prod}` と `modules/*`、Aurora、Cognito、EventBridge Scheduler、OpenAPI、SQL マイグレーション）。2 repo で、設定は非公開の兄弟ディレクトリに置いて build 済み（149 / 330 / エラー 0） |
| Q3 | ハイライト色 | **決定済み（推奨案）**: 赤（依存先）＋橙（影響範囲）の 2 色を維持 |
| Q4 | メモの保存先 | **実装済み**: `.stack-atlas/memos.json` を Git で共有（D13）。`serve --repo` で書き戻し、または JSON を書き出す |
| Q5 | 共有・ホスティング | 静的ビルド（`build --with-viewer`）＋ S3 / CloudFront 用の `docs/ci-example.yml`、またはローカル `serve` を**実装済み**。**配信先は未選定（残る論点）** |
| Q6 | フロー定義 | **実装済み**: `flows.yaml` を人が書く＋ `init-flows` で雛形 |
| Q7 | 対象スタック | CDKtf / Terraform HCL / AWS CDK・SAM・CFn、Next.js（App / Pages / 静的エクスポート）、TypeScript、Go、OpenAPI、SQL を**実装済み**（Phase 7）。それ以外は `files` / `classify` / `kinds` で載せる。Vite / Remix / Python などの専用抽出器は後回し |
| Q8 | プロダクト名 | **決定済み（推奨案）**: 当面「Stack Atlas」 |
| Q9 | 配信形態の仮置き | **決定済み（推奨案）**: 静的ビルド |
| Q10 | 実アプリのスクショ | **未決**: サイトを起動して `screenshots` を設定し、対象アプリに `data-component` を付ける（`docs/10`）。認証は `storageState` |
| Q11 | 実アプリの flows | **未決**: `init-flows` で雛形は出る（endpoint のホップと S3 の静的エクスポートにも対応）。文を実際の挙動に合わせて書く |
| Q12 | 設定の置き場 | **未決**: `damage-web/stack-atlas.config.yaml`（`repos.platform: ../damage-platform`）にコミットするか、非公開の兄弟ディレクトリのままにするか。この公開リポジトリには置かない |

### 次にやること

ビューアの大規模 graph 対応（レイアウトの広がり・ラベルの LOD・検索。Phase 7-6、**進行中**）→ 実アプリのスクショ（Q10）→ flows（Q11）→ 配信先と CI（Q5）→ 設定の置き場（Q12）→ fixture-poly の e2e を CI に（7-7）。

---

## 1. 結論

- 「Figma に 3D を足したような、スタックからコードまで 1 画面で追える共有スペース」のプロトタイプを作り、ユーザーから高評価を得た。
- 特に好評だったのは **データフローの可視化**。**キャッシュの可視化**は「実務で使える」と評価された。
- 既存ツールで同じことができるものは見つからなかった（`docs/07-existing-tools.md`）。
- 現状のプロトタイプは**データ手書きの専用品**。次は **汎用化**: 抽出器 → `graph.json` → ビューア の 3 部品に分離する。
- 中間フォーマット `graph.json` のスキーマ案と、プロトタイプのデータを変換したサンプルは作成済み・検証済み。

## 2. 経緯（時系列）

| # | ユーザーの要望 | 対応 |
|---|---|---|
| 1 | Figma に 3D 機能を持たせたようなサービスはないか。スタックからコードまで 1 画面で追いたい。Lambda の下（Z 軸）に Next があり、さらに全画面が展開され、カーソルを合わせると型定義や共通パーツが赤くハイライトされる。メモも書きたい。イメージ合わせのためにアーティファクトで作って。連結はリポジトリからコードを引けばいけると思う（インフラ・バック・フロント全部コード管理） | 既存ツールを調査し、該当なしと報告。4 層（インフラ／画面／コンポーネント／型・API）の 3D プロトタイプを作成 |
| 2 | 「マジで神。データフローが見えるのが最高」。キャッシュも表現できたら実務で使える。画面は箱ではなく実際の画面（スクショ）にしたい（アーティファクトはダミー画面で OK）。層をまたぐ線は上の層の色にして、どこからどこへつながるか分かりやすくしたい | 画面ノードを Canvas 描画のダミー画面に変更（画面内パーツにもホバー可、実スクショ差し替え可）。キャッシュモードと HIT／MISS／入稿→反映フローを追加。層またぎの線を上の層の色に変更 |
| 3 | どんなプロジェクトにも適用できるようにしたい。すでにそうなっているか？ | 「なっていない」と回答。3 部品への分離と graph.json 案を提示 |
| 4 | Git 連携の別セッションに引き継ぐので資料一式を作って | 本資料 |

公開済みアーティファクト（ユーザーのみ閲覧可）: https://claude.ai/artifact/LqsDADHL96TNLpJStLtcA1
中身は `prototype/stack-atlas.html` と同一。

## 3. 決定事項（ユーザー合意済み、または要望として明示されたもの）

- 層は Z 軸（three.js では Y 軸）に積む。上から **インフラ → 画面・ルート → コンポーネント・hooks → 型・API ハンドラ**。
- ホバーで関連ハイライト。**赤 = 依存先**（使っている型・部品）、**橙 = 影響範囲**（それを使う画面・部品）。
  ユーザーの元の要望は「赤くハイライト」。2 色に分けた点について明確な異論はないが、確認はしていない（未決事項参照）。
- **層をまたぐ線は上の層の色**で描く（ユーザー要望）。同じ層内の線は種類別の色。
- 画面ノードは**実際の画面（スクショ）**で表示する。コンポーネント領域をスクショ上に重ねてハイライトする。
- データフローは層をまたいで粒子が流れるアニメーション。キャッシュ HIT／MISS の違いが分かること。
- ノードにメモを書ける（チーム共有スペースが最終目標）。
- 連結はリポジトリのコード解析で自動化する（ユーザーの想定どおり）。

## 4. 現状の成果物

- `prototype/stack-atlas.html` — 動くプロトタイプ。three.js r160（jsDelivr）、OrbitControls、CSS2DRenderer。ビルド不要。
  - 機能: レイヤー展開／重ね、フロー 3 種、キャッシュモード、層の表示切替、パネル（コード抜粋・依存・キャッシュ・メモ・スクショ差し替え）、画面内パーツのホバー
  - メモとスクショは localStorage に保存（ブラウザ単位で共有されない）
- `packages/schema/graph.schema.json` — 中間フォーマットの JSON Schema 案（v1）
- `examples/race-site.graph.json` — プロトタイプのデータを変換したサンプル（32 ノード、52 エッジ、3 フロー）。スキーマ検証済み
- `scripts/export-prototype-data.mjs` — 上記の変換スクリプト（プロトタイプを修正したら再生成可能）
- `scripts/validate-graph.mjs` — スキーマ＋参照整合性チェック
- `docs/images/` — プロトタイプのスクリーンショット

## 5. プロトタイプの汎用化を妨げている箇所

詳細は `docs/02-architecture.md`。要点:

1. データ（`NODES` / `EDGES` / `CACHE` / `FLOWS`）が HTML に直書き → graph.json 読み込みに置き換え
2. ノード座標（x, z）が手置き → 自動レイアウトが必要
3. 「L1 が画面」という前提がコードにある（`n.isScreen = n.L === 1`）→ `kind` か `screen` フィールドで判定
4. ダミー画面はページ ID ごとの Canvas 描画関数 → 実スクショ＋regions に置き換え（スクショがないときのプレースホルダは必要）
5. ノード ID がプロジェクト固有の短い名前 → `<kind>:<識別子>` 規約へ（サンプルは変換済み）

## 6. 未決事項（ユーザーに確認すること）

| # | 論点 | 選択肢・補足 | 関係フェーズ |
|---|---|---|---|
| Q1 | このツール自体のリポジトリ構成 | モノレポ（pnpm workspaces 推奨）か単一パッケージか。パッケージマネージャ | Phase 0 |
| Q2 | 最初に解析する実リポジトリ | ユーザーが主導している開発のリポジトリを想定。構成（モノレポか、infra/web/api の分け方）を確認 | Phase 2 |
| Q3 | ハイライト色 | 赤＋橙の 2 色のままか、全部赤か | Phase 1 |
| Q4 | メモの保存先 | 案: 解析対象リポジトリ内の `.stack-atlas/memos.json` に置いて Git で共有。ほかに自前 API、Notion など | Phase 5 |
| Q5 | 共有・ホスティング方法 | 社内向けの静的サイト（S3＋CloudFront）を CI で更新、ローカルの CLI（`stack-atlas serve`）など。業務コードが含まれるので外部 SaaS は避ける | Phase 5 |
| Q6 | フロー定義の書き方 | 自動推定は難しいので、まずは人が YAML で書く案。ステップのノード ID だけ書けば経路は graph から補完 | Phase 4 |
| Q7 | 対象スタックの優先順位 | 初期は CDKtf ＋ Next.js（App Router、Lambda 上で動かす）＋ TypeScript。次に Terraform / AWS CDK / SAM、Vite / Remix など | Phase 2〜 |
| Q8 | プロダクト名 | 仮称「Stack Atlas」（プロトタイプ作成時に Claude が付けた名前。ユーザー未確認） | — |

## 7. 注意点・ハマりどころ（調査済み）

- CDKtf の `cdk.tf.json` にはソースファイルの位置が入っていない。`//` メタデータの construct path は取れるので、そこから `infra/` 以下を grep して対応付ける
- Lambda → アプリのつながりは、`filename`（zip のパス）や `handler` からビルド成果物を逆引きする。規約で補う必要が出るはず
- フロント → API のつながり（api client の URL ⇔ API Gateway の route_key ⇔ integration ⇔ Lambda ⇔ ハンドラのファイル）が最も不安定。静的解析だけでは漏れるので、規約か手書きの補正ファイル（`stack-atlas.overrides.yaml` 案）で補う
- スクショの領域座標は、対象アプリ側でコンポーネントのルート要素に `data-component="Name"` を付けてもらい、Playwright で `getBoundingClientRect()` を取得する方式を推奨
- キャッシュの内容はプロトタイプでは手書き。抽出元は CloudFront の cache behavior（`cdk.tf.json`）と、Next.js の route segment config（`revalidate`、`dynamic`）、`fetch` の `next.revalidate` / `tags`、SWR のオプションなど
- プロトタイプのキャッシュ注意書き（例: Lambda の /tmp に置いた ISR はインスタンスごと、ISR と CDN の二段構えで最大約 120 秒古くなる）は**サンプル構成に対する一般論**。実プロジェクトでは設定から判定すること
