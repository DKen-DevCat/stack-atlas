# 引き継ぎ資料 — Stack Atlas

作成: 2026-11-07（チャットセッションから Git 連携セッションへの引き継ぎ）

## 0. 現在地（2026-11-07 Git 連携セッション後）

### 結論

Phase 0〜5 は **フィクスチャリポジトリ（`examples/fixture-repo/`）に対して完了**した。実リポジトリ（Q2）が未確認のため、実物では一度も動かしていない。
次のゲートは **Q2（最初に解析する実リポジトリ）の確認**で、そこから Phase 6（`docs/06-roadmap.md`）に進む。以降の §1〜§7 は引き継ぎ時点の記録（履歴）として残している。

### フェーズごとに作ったもの

| Phase | 成果物 |
|---|---|
| 0 | pnpm モノレポ、`packages/schema`（JSON Schema・型・`validateGraph()`・検証 CLI）、CI |
| 1 | `packages/viewer`: graph.json 入力（`?graph=`・ドロップ・ファイル選択）、自動レイアウト、ハイライト、フロー、キャッシュモード、パネル、スクショ表示、スマホ幅、e2e |
| 2 | `packages/core`（契約・マージ・overrides・flows・層割り当て・`buildGraph()`）、`packages/cli`、`extractors/{cdktf,nextjs-app,ts-imports,api-link}`、`examples/fixture-repo/` |
| 3 | `extractors/screenshots`（Playwright、`data-component` → regions、storageState）、`docs/10-screenshots-guide.md` |
| 4 | `extractors/cache`、core のルールエンジン、`flows.yaml` の読み込み、`stack-atlas init-flows` |
| 5 | メモ共有（`memos.json`・`serve` の書き戻し・孤立メモ）、差分表示（`?prev=`・`stack-atlas diff`）、`build --with-viewer`、`docs/ci-example.yml`、`docs/11-sharing.md` |

### テスト（2026-11-07 実測）

- `pnpm test`: 235 件通過（schema 15 / core 50 / viewer 82 / cdktf 9 / nextjs-app 8 / api-link 12 / cache 14 / ts-imports 7 / screenshots 17 / cli 21）
- `pnpm --filter @stack-atlas/viewer e2e`: 18 件通過、3 件スキップ（約 30 秒。Chromium が必要）

### 動かし方

```sh
pnpm install && pnpm build
pnpm atlas build examples/fixture-repo -o out --with-viewer --no-screenshots
pnpm atlas serve out        # http://127.0.0.1:4173/
pnpm dev                    # ビューアの開発サーバ。?graph=samples/race-site.graph.json
```

コマンドの一覧と自分のリポジトリへの適用方法は `README.md`。

### 決定事項 D1〜D13

- D1〜D8（pnpm モノレポ、handoff のルート展開、画面ノードの判定、three.js 同梱、決定的な自動レイアウト、型は手書きでスキーマが正、検証エラーでも描画継続、メモの保存先を差し替え可能に）: `docs/08-design-phase0-1.md` §5
- D9〜D13（フィクスチャで Phase 2〜5 を完了、抽出器は順次実行、cdk.tf.json は手書き、設定は YAML 1 ファイル、メモの正は `.stack-atlas/memos.json`）: `docs/09-design-phase2-5.md` §5
- 設計からのずれは各文書末尾の「実装結果」を参照。

### 未決事項（更新後）

| # | 論点 | 状態 |
|---|---|---|
| Q1 / Q1' | リポジトリ構成・handoff の展開 | **決定済み（推奨案）**: pnpm モノレポ、ルートに展開（D1・D2） |
| Q2 | 最初に解析する実リポジトリ | **未決。ゲートになる項目**。構成を確認して Phase 6 へ |
| Q3 | ハイライト色 | **決定済み（推奨案）**: 赤（依存先）＋橙（影響範囲）の 2 色を維持 |
| Q4 | メモの保存先 | **実装済み**: `.stack-atlas/memos.json` を Git で共有（D13）。`serve --repo` で書き戻し、または JSON を書き出す |
| Q5 | 共有・ホスティング | 静的ビルド（`build --with-viewer`）＋ S3 / CloudFront 用の `docs/ci-example.yml`、またはローカル `serve` を**実装済み**。配信先は未選定 |
| Q6 | フロー定義 | **実装済み**: `flows.yaml` を人が書く＋ `init-flows` で雛形 |
| Q7 | 対象スタック | CDKtf ＋ Next.js App Router ＋ TypeScript は**実装済み**。Terraform / AWS CDK / SAM / Vite / Remix などは後回し |
| Q8 | プロダクト名 | **決定済み（推奨案）**: 当面「Stack Atlas」 |
| Q9 | 配信形態の仮置き | **決定済み（推奨案）**: 静的ビルド |

### 次にやること

`docs/06-roadmap.md` の Phase 6。Q2 の確認 → 実リポジトリで `stack-atlas build` → config / `detect()` の調整 → api-link の取りこぼしを overrides で補う → スクショ（storageState）→ キャッシュのバッジ確認 → flows → CI。

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
