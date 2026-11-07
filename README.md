# Stack Atlas

インフラ → 画面 → コンポーネント → 型 を層として 3D に積み、1 画面で依存関係・データフロー・キャッシュを追えるようにするツール。

## 結論

リポジトリ（CDKtf ＋ Next.js App Router ＋ TypeScript）を解析して `graph.json` を作り、静的な 3D ビューアで開く。
ホバーで依存先（赤）と影響範囲（橙）が光り、データフロー（HIT / MISS / 無効化）とキャッシュ設定が見え、ノードにメモを書いてチームで共有できる。
解析もビューアもローカル／自前ホスティングで完結し、ソースコードを外部に送らない。
Phase 0〜5 はフィクスチャリポジトリ（`examples/fixture-repo/`）で完了済み。次は実リポジトリへの適用（[docs/06-roadmap.md](docs/06-roadmap.md) の Phase 6）。

## 全体像

```
 リポジトリ                    抽出器（スタック固有）                graph.json              ビューア（汎用）
┌─────────────┐   cdktf / nextjs-app / ts-imports      ┌────────────┐   ?graph=   ┌──────────────────┐
│ infra/ apps/ │ ─ api-link / cache / screenshots ───▶ │ nodes      │ ──────────▶ │ 3D 表示・ハイライト │
│ flows.yaml   │   ＋ overrides / flows / memos        │ edges      │             │ フロー・キャッシュ │
│ overrides…   │   （packages/core がマージ・検証）     │ flows      │             │ メモ・差分         │
└─────────────┘                                        └────────────┘             └──────────────────┘
```

ビューアは graph.json だけを読み、特定のスタックを知らない。スタック固有の処理はすべて抽出器に閉じる。詳細は [docs/02-architecture.md](docs/02-architecture.md)。

## クイックスタート

Node 22 と pnpm（`corepack enable`）が必要。フィクスチャを解析してビューアで開く。

```sh
pnpm install
pnpm build
pnpm atlas build examples/fixture-repo -o out --with-viewer --no-screenshots
pnpm atlas serve out        # → http://127.0.0.1:4173/ を開く
```

手書きサンプルをビューアの開発サーバで見る場合:

```sh
pnpm dev                    # → http://localhost:5173/?graph=samples/race-site.graph.json
```

## CLI

`pnpm atlas <コマンド>`（ビルド後は `stack-atlas <コマンド>`）。

| コマンド | 内容 |
|---|---|
| `build <repo> [-o <outDir>] [--with-viewer] [--no-screenshots] [-v]` | 解析して `graph.json` / `issues.json` / `memos.json`（と `shots/`、ビューア）を `outDir` に出す。検証エラーがあれば終了コード 1 |
| `validate <graph.json...>` | スキーマと参照整合性の検証（`pnpm validate <file>` でも可） |
| `serve <outDir> [--port 4173] [--host 127.0.0.1] [--repo <repo>]` | `outDir` を配信。`--repo` を付けるとビューアのメモ保存が `<repo>/.stack-atlas/memos.json` に書き戻される |
| `diff <prev.json> <next.json>` | 2 つの graph.json の追加・削除・変更を表示 |
| `init-flows <repo> [--out <file>] [--force]` | いまのグラフから `flows.yaml` の雛形（MISS / HIT / 無効化）を書く |

## 自分のリポジトリに適用する

解析対象のリポジトリ直下に次を置き、`stack-atlas build <repo> -o out --with-viewer` を実行する。

- `stack-atlas.config.yaml`: 抽出器の入力（`cdktf` / `next` / `ts` / `deploy` / `api` / `screenshots`）。キーは [docs/09-design-phase2-5.md](docs/09-design-phase2-5.md) §3.3、動く例は [examples/fixture-repo/stack-atlas.config.yaml](examples/fixture-repo/stack-atlas.config.yaml)
- `stack-atlas.overrides.yaml`: 静的解析で取れない結線の補正（`nodes` / `edges` / `remove` / `deploy`）
- `flows.yaml`: データフロー。`stack-atlas init-flows <repo>` で雛形を作って直す
- `data-component="Name"`: 画面の領域を取りたいコンポーネントのルート要素に付ける属性。[docs/10-screenshots-guide.md](docs/10-screenshots-guide.md)
- `.stack-atlas/memos.json`: チーム共有メモ（Git 管理）。共有・差分・配信は [docs/11-sharing.md](docs/11-sharing.md)、CI は [docs/ci-example.yml](docs/ci-example.yml)

## パッケージ

| パッケージ | 内容 |
|---|---|
| `packages/schema`（`@stack-atlas/schema`） | graph.json の JSON Schema・型・`validateGraph()`・検証 CLI |
| `packages/core`（`@stack-atlas/core`） | 抽出器の契約（`src/types.ts`）、マージ、overrides、flows、ルールエンジン、`buildGraph()` |
| `packages/cli`（`@stack-atlas/cli`） | `stack-atlas` コマンド |
| `packages/viewer`（`@stack-atlas/viewer`） | 3D ビューア（Vite + TypeScript + three.js）。core に依存しない静的アプリ |
| `extractors/cdktf` | インフラ層（`cdk.tf.json`）。CloudFront / API Gateway のキャッシュ情報も作る |
| `extractors/nextjs-app` | 画面層（App Router の route / layout、route segment config） |
| `extractors/ts-imports` | コンポーネント層・型層と `uses` エッジ（ts-morph） |
| `extractors/api-link` | フロント → API の結線（client ⇔ route_key ⇔ Lambda ⇔ ハンドラ） |
| `extractors/cache` | SWR / React Query、Lambda 上の ISR、server component の fetch のキャッシュ情報 |
| `extractors/screenshots` | Playwright で画面のスクショと `data-component` の領域を取る |

## テスト

```sh
pnpm test                                   # 全パッケージの Vitest（235 件）
pnpm lint && pnpm typecheck                 # ESLint と tsc
pnpm --filter @stack-atlas/viewer e2e       # Playwright のスモークテスト（18 件、3 件はスキップ。Chromium が必要）
DOCS_SCREENSHOTS=1 pnpm --filter @stack-atlas/viewer e2e docs-screenshots   # docs/images/ を撮り直す
```

初回は `pnpm --filter @stack-atlas/viewer exec playwright install chromium` が必要（`/opt/pw-browsers/chromium` があればそれを使う）。

## ギャラリー

| | |
|---|---|
| ![overview](docs/images/phase1-overview.png) | ![hover](docs/images/phase1-hover-component.png) |
| 層を積んだ全体像 | ResultTable を指すと、使う画面と型が光る |
| ![cache flow](docs/images/phase1-cache-flow.png) | ![diff](docs/images/phase5-diff.png) |
| キャッシュモードと「閲覧 MISS」フロー | 前回との差分（追加は緑、削除はゴースト） |

## 関連ドキュメント

[HANDOFF.md](HANDOFF.md)（経緯・決定事項・未決事項）、[CLAUDE.md](CLAUDE.md)（作業指示）、[docs/](docs/)（仕様）、[prototype/](prototype/)（最初の単一 HTML プロトタイプ。参照用）。
