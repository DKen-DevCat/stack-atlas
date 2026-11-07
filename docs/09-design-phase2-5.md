# 09. 設計（Phase 2 → Phase 5）

作成: 2026-11-07。ユーザーから「承認なしで全フェーズ進めてよい」と指示を受けて書いた。
`docs/08-design-phase0-1.md` の続き。Phase 1 までの設計はそちら。

## 1. 結論

- **実リポジトリ（未決事項 Q2）はまだ無い**。そのため Phase 2〜5 は、サンプル構成（race-site）を模した **フィクスチャ用リポジトリ `examples/fixture-repo/`** を作り、それを解析して `examples/race-site.graph.json` と同等の graph.json が生成できることを完了条件にする。
- 実リポジトリが決まったら、抽出器の `detect()` と設定ファイル（`stack-atlas.config.yaml`）で差を吸収する。コードの変更は extractors 側に閉じる。
- パッケージは `packages/core`（抽出器の土台・マージ・補正・ルールエンジン）、`packages/cli`（`build` / `serve` / `validate`）、`extractors/*`（スタック固有）を足す。

## 2. 全体像

```
examples/fixture-repo/                stack-atlas build <repo> -o out/
 ├─ infra/ (CDKtf の TS + cdktf.out の cdk.tf.json)   ─┐
 ├─ apps/web (Next.js App Router 風のファイル群)        │ extractors: cdktf / nextjs-app / ts-imports /
 ├─ apps/api (ハンドラ)                                 │             api-link / cache / screenshots
 ├─ packages/types                                      ┘
 ├─ stack-atlas.config.yaml     ← 対象ディレクトリ、層の割り当て、Lambda とアプリの対応、スクショ設定
 ├─ stack-atlas.overrides.yaml  ← 静的解析で取れない結線の補正
 ├─ flows.yaml                  ← データフロー定義
 └─ .stack-atlas/memos.json     ← チーム共有メモ（Phase 5）
                                          │
                                          ▼  core: merge → overrides → flows → cache rules → validate
                                 out/graph.json + out/shots/*.png + out/memos.json
                                          │
                                          ▼  stack-atlas serve out/   または  静的ホスティング
                                 viewer（Phase 1 の成果物）
```

## 3. 構造

### 3.1 追加パッケージ

| パッケージ | 役割 |
|---|---|
| `packages/core` (`@stack-atlas/core`) | `Extractor` インターフェース、`RepoContext`、`PartialGraph`、マージ、`overrides.yaml`・`flows.yaml` の適用、層の割り当て、キャッシュのルールエンジン、`buildGraph()` パイプライン |
| `packages/cli` (`@stack-atlas/cli`, bin `stack-atlas`) | `build <repo> [-o out] [--config ...]`、`serve <out> [--port]`、`validate <graph.json>` |
| `extractors/cdktf` | `cdktf.out/stacks/*/cdk.tf.json` → `infra:*` ノードと `flow` エッジ、CloudFront の cache behavior |
| `extractors/nextjs-app` | `app/**/page.tsx` / `layout.tsx` → `route:*` / `layout:*`。route segment config を `meta` に |
| `extractors/ts-imports` | ts-morph で シンボル単位の `uses` エッジ。`comp:` / `hook:` / `lib:` / `type:` / `handler:` / `schema:` の分類 |
| `extractors/api-link` | api client の URL リテラル ⇔ API Gateway の route_key ⇔ integration ⇔ Lambda ⇔ ハンドラ。`http` エッジ |
| `extractors/cache` | 各ノードの `cache` フィールドを生成（CloudFront behavior、`revalidate` / `dynamic`、`fetch` の `next` オプション、SWR） |
| `extractors/screenshots` | Playwright で各 `route:` を開いてスクショと `data-component` の領域を取る |

### 3.2 core のインターフェース

```ts
interface RepoContext { root: string; config: StackAtlasConfig; log: Logger }
interface Extractor {
  name: string;
  detect(ctx: RepoContext): Promise<boolean>;
  extract(ctx: RepoContext, upstream: PartialGraph): Promise<PartialGraph>; // 先行する抽出器の結果を参照できる
}
type PartialGraph = { layers?: Layer[]; nodes: PartialNode[]; edges: Edge[]; flows?: Flow[] };
```

- 抽出器は**順番に**走る（cdktf → nextjs-app → ts-imports → api-link → cache → screenshots）。後続は `upstream` を読める（api-link が cdktf のルートを見る、など）。
- **マージ**: 同じ ID のノードはフィールドを deep merge。`meta.extractors` に出した抽出器名を配列で残す。エッジは `(from, to, kind)` で重複排除。
- **overrides.yaml**: `nodes`（追加・上書き）、`edges`（追加）、`remove`（ノード ID / エッジの削除）、`deploy`（Lambda → 中身の一括 deploy エッジ）。
- **flows.yaml**: `steps` は `[node, text]` の配列か `{node, text}`。ノード ID が存在しない場合はエラーで止める（フローは人が書くので厳密に）。
- **層の割り当て**: `config.layers` で `kind` → `layer` の対応を宣言。既定は infra→`infra`、route/layout→`routes`、comp/hook/lib→`components`、type/handler/schema→`types`。
- **ルールエンジン（cache）**: マージ後に走る。`rules/*.ts` に 1 判定 1 ファイル。例: 「route が ISR で、上の CloudFront behavior に s-maxage がある → 最悪鮮度 = 両者の和」を `note` に書く。
- 最後に `@stack-atlas/schema` の `validateGraph` で検証し、エラーがあれば exit 1。

### 3.3 設定ファイル `stack-atlas.config.yaml`

```yaml
project: { name: race-results }
layers:                      # 省略可。既定の 4 層
  - { id: infra, name: インフラ, color: "#ff9f43" }
  - ...
cdktf: { out: infra/cdktf.out, sourceDir: infra }
next: { appDir: apps/web/app, tsconfig: apps/web/tsconfig.json }
ts: { tsconfig: [apps/web/tsconfig.json, apps/api/tsconfig.json, packages/types/tsconfig.json] }
deploy:                      # Lambda とアプリの対応（規約で推定できないときの明示）
  infra:web/next: { app: next }                 # この Lambda に Next の全ルートが載る
  infra:api/api:  { handlers: apps/api/src/handlers/**/*.ts }
api: { client: apps/web/lib/apiClient.ts }
screenshots:
  baseUrl: http://localhost:3000
  viewport: { width: 1280, height: 800 }
  routes: { "/races/[id]": ["42"] }
  storageState: .stack-atlas/auth.json         # 認証が必要なルート用
```

### 3.4 フィクスチャ用リポジトリ `examples/fixture-repo/`

- race-site サンプルと同じ構成を、**本物の TypeScript ファイル**で用意する。Next.js や React は依存として install しない（ts-morph は解決できない import を外部として無視する）。
- `infra/cdktf.out/stacks/web/cdk.tf.json` は手書きで用意する（cdktf synth はプロバイダのダウンロードが必要で重い）。construct path の `//` メタデータも入れる。
- スクショ用に `examples/fixture-repo/site/` に静的 HTML（各ルートに対応するページ、`data-component` 属性付き）を置き、テスト時に静的サーバで配信して screenshots 抽出器を end-to-end で検証する。
- ワークスペースの typecheck / lint の対象からは外す（`.eslintignore` 相当、tsconfig の exclude）。

### 3.5 Phase 5（共有）

- **メモ**: `.stack-atlas/memos.json`（解析対象リポジトリ内、Git 共有）が正。`build` が `out/memos.json` にコピーし、ビューアは graph.json と同じディレクトリの `memos.json` を読む。ビューア上の編集は localStorage に持ち、「memos.json を書き出す」ボタンで JSON をダウンロードできる。`serve` 中は `POST /api/memos` でリポジトリ内のファイルに直接書き戻す。
- **孤立メモ**: memos.json のキーが graph.json に無いものを一覧表示（削除・移し替え可）。
- **差分**: `?prev=<前回の graph.json>` を与えると、追加ノードを緑、削除ノードを灰（ゴースト）で表示。CLI に `stack-atlas diff a.json b.json` も付ける。
- **配信**: `build` の `--with-viewer` でビューアの `dist/` を `out/` に同梱し、`out/` をそのまま S3 などに置けば動く形にする。GitHub Actions のテンプレートを `docs/ci-example.yml` に置く。

## 4. 詳細（タスク）

### Phase 2 — core / cli / 基本の抽出器

| # | タスク | 完了の目安 |
|---|---|---|
| 2-1 | `examples/fixture-repo/` を作る（infra の TS と cdk.tf.json、apps/web、apps/api、packages/types、config / overrides / flows） | ファイルが揃い、ts-morph で読める |
| 2-2 | `packages/core`: 型、config 読み込み（yaml）、マージ、overrides、flows、層の割り当て、`buildGraph()`。ユニットテスト | |
| 2-3 | `extractors/cdktf` + テスト（フィクスチャの cdk.tf.json） | `infra:*` 9 ノードと `flow` エッジ |
| 2-4 | `extractors/nextjs-app` + テスト | `route:/`, `route:/races/[id]`, `route:/admin/entry` など、`layout:/` |
| 2-5 | `extractors/ts-imports` + テスト | comp / hook / lib / type / handler / schema と `uses` エッジ。`code` 抜粋と `file` / `line` |
| 2-6 | `extractors/api-link` + テスト | `lib:apiClient → handler:*` の `http`、`infra:apigw → infra:lambdaApi` との整合 |
| 2-7 | `packages/cli`: `build`、`validate`、`serve`（静的配信） | `stack-atlas build examples/fixture-repo -o out/` が graph.json を出し、validate が通る |
| 2-8 | 生成した graph.json をビューアで開き、race-site サンプルと見比べる（ノード・エッジの差分をテストで固定） | 差分が説明できる範囲 |

### Phase 3 — スクショ

| # | タスク |
|---|---|
| 3-1 | `extractors/screenshots`（Playwright、`routes` のサンプルパラメータ、`storageState`、`data-component` → regions） |
| 3-2 | フィクスチャの静的サイトで end-to-end テスト（静的サーバを起動 → 抽出 → regions が期待どおり） |
| 3-3 | `docs/10-screenshots-guide.md`: 対象アプリへの `data-component` の付け方 |

### Phase 4 — キャッシュとフロー

| # | タスク |
|---|---|
| 4-1 | `extractors/cache`: CloudFront behavior、route segment config、`fetch` の `next` オプション、SWR |
| 4-2 | core のルールエンジン（二段キャッシュの最悪鮮度、Lambda 上のファイルシステム ISR の警告、Cookie がキャッシュキーに入る警告） |
| 4-3 | `flows.yaml` の読み込み（2-2 に含める）とテンプレート（`stack-atlas init-flows` で HIT / MISS / 無効化の雛形を書き出す） |

### Phase 5 — 共有

| # | タスク |
|---|---|
| 5-1 | memos.json の読み込み・書き出し・`serve` の書き戻し API、孤立メモ一覧 |
| 5-2 | 差分表示（`?prev=`）と `stack-atlas diff` |
| 5-3 | `build --with-viewer`、`docs/ci-example.yml` |
| 5-4 | README・CLAUDE.md・ロードマップの更新 |

## 5. 決定事項

| # | 決定 | 理由 |
|---|---|---|
| D9 | 実リポジトリが無いので、フィクスチャ用リポジトリで Phase 2〜5 を完了させる | ユーザーの指示（承認なしで進める）。実リポジトリ適用時の差分は config と detect で吸収 |
| D10 | 抽出器は順番に走り、後続が先行の結果を読める | api-link が cdktf と nextjs-app の結果を必要とする |
| D11 | cdk.tf.json は手書きで用意し、cdktf synth は CI で動かさない | プロバイダのダウンロードが重く、ネットワークに依存する |
| D12 | 設定は YAML 1 ファイル（`stack-atlas.config.yaml`）。overrides と flows は別ファイル | 生成の入力と人の補正を分ける |
| D13 | メモの正は `.stack-atlas/memos.json`。ビューアからの保存は `serve` 経由か JSON ダウンロード | 業務コードと同じリポジトリで Git 管理し、外部 SaaS を使わない |

## 6. 実装結果

Phase 2〜5 はフィクスチャ（`examples/fixture-repo/`）に対して完了した。`stack-atlas build examples/fixture-repo` は 33 ノード・55 エッジ・3 フロー、検証エラー 0 件。
テストは全体で 235 件（core 50、cli 21、cdktf 9、nextjs-app 8、ts-imports 7、api-link 12、cache 14、screenshots 17）。設計からずれた点:

- **`applyDeployConfig`**: `config.deploy`（Lambda とアプリ・ハンドラの対応）は抽出器ごとに解釈せず、core の `applyDeployConfig`（`packages/core/src/deploy.ts`）がマージ後にまとめて `deploy` エッジと `meta.deployApp` を付ける。cdktf と nextjs-app も同じキーを読む。
- **キャッシュ情報の出どころ**: `cache` 抽出器だけが作るのではなく、CloudFront・HTTP API・Lambda@Edge は cdktf、route の ISR・dynamic は nextjs-app、api client の `fetch` オプションは api-link が作る。`cache` 抽出器は残りを埋める（hook の SWR / React Query、Lambda 上の ISR、server component の fetch）。`cache` のあるノードには触らない。
- **hook のキャッシュの tone**: SWR / React Query の設定は `ok`（`warn` や `info` にはしない）。route の fetch は `info`、`no-store` は `off`。
- **screenshots の出力先**: `config.screenshots.outDir` の既定は `.stack-atlas/out`。CLI の `build` は `outDir` を `-o` と同じにし、PNG を `<outDir>/shots/<slug>.png`、`screen.screenshot` を `shots/<slug>.png`（graph.json 基準の相対パス）にする。`--no-screenshots` で抽出器を飛ばせる。スクショ失敗時はそのルートだけ飛ばす。README は無く、使い方は `docs/10-screenshots-guide.md`。
- **`detect()` に upstream が渡らない**: `detect(repo)` は先行の抽出器の結果を見られない。cache 抽出器は config のキーや直下の `next.config` / package.json の依存で判定し、`extract` で upstream に対象ノードが無ければ空を返す。
- **api-link の自己完結**: cdk.tf.json を自分で読み直す（`aws_apigatewayv2_route` / `integration`）。上流のノードがあれば ID を引き、無ければ `handler:` / `lib:` を自分で作る。REST API・ALB は未対応。
- **`init-flows` コマンド**: 設計の 4-3 どおり。いまのグラフから `miss` / `hit` / `invalidate` を作る。ノード ID は実在するものだけ。既存ファイルは `--force` が無ければ上書きしない。
- **ルールエンジン**: `lambda-fs-isr` → `two-tier-staleness` → `cookie-cache-key` → `no-store-behind-cdn` の順（`DEFAULT_RULES`）。
- **差分表示のゴースト**: 削除ノードは今の graph の同じ層に灰色の箱で置く。前回のレイアウト位置を基準に、今のノードと重ならないよう横にずらす。ホバー・フロー・キャッシュ表示中は薄くする（`docs/11-sharing.md`）。
- **ts-imports**: Lambda のエントリファイル（`apps/api/src/index.ts`）も `lib:` になる。不要なら overrides の `remove` で消す。
- **未検証**: 実リポジトリ（Q2）。差分は config と `detect()` で吸収する想定（D9）で、Phase 6 で確認する。
