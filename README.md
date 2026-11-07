# Stack Atlas

インフラ → 画面 → コンポーネント → 型 を層として 3D に積み、1 画面で依存関係・データフロー・キャッシュを追えるようにするツール（開発初期）。

![overview](docs/images/01-overview.png)

- 引き継ぎの概要: [HANDOFF.md](HANDOFF.md)
- Claude 向けの作業指示: [CLAUDE.md](CLAUDE.md)
- 動くプロトタイプ: [prototype/](prototype/)
- 仕様: [docs/](docs/)

| | |
|---|---|
| ![hover](docs/images/02-hover-component.png) | ![cache](docs/images/03-cache-flow.png) |
| 画面内の ResultTable を指すと、同じ部品を使う画面と型が光る | キャッシュモードと「閲覧 MISS」フロー |

## 開発

Node 22 と pnpm（`corepack enable` で `package.json` の `packageManager` のバージョンが使われる）が必要。

```sh
pnpm install
pnpm dev                                  # ビューアの開発サーバ（packages/viewer、Vite）
pnpm build                                # 全パッケージをビルド。ビューアは packages/viewer/dist/ に静的ファイルが出る
pnpm test                                 # Vitest
pnpm lint && pnpm typecheck               # ESLint と tsc
pnpm validate examples/race-site.graph.json   # graph.json のスキーマ＋参照整合性チェック
```

| パッケージ | 内容 |
|---|---|
| `packages/schema`（`@stack-atlas/schema`） | graph.json の JSON Schema・TypeScript 型・`validateGraph()`・検証 CLI |
| `packages/viewer`（`@stack-atlas/viewer`） | 3D ビューア（Vite + TypeScript + three.js）。graph.json だけを入力に描画する静的アプリ |

## ビューアを使う

```sh
pnpm dev
# → http://localhost:5173/?graph=samples/race-site.graph.json
```

- **サンプル**: `examples/*.graph.json` は `scripts/sync-samples.mjs` が `packages/viewer/public/samples/` にコピーする（`pnpm dev`・`pnpm build` の前に自動で実行。コピー先は Git に入れない）。
  ビルド結果 `packages/viewer/dist/` にも `samples/` が入るので、`dist/` を置いた場所で `?graph=samples/race-site.graph.json` が開ける。
  開発サーバと `vite preview` では、リポジトリの `examples/` を `/examples/` でも配信している（`?graph=../../examples/race-site.graph.json` でも開ける）。
- **自分の graph.json を開く**（どれか）:
  1. URL で指定: `?graph=<graph.json の URL>`。相対パスはページ基準。graph.json 内の `screen.screenshot` は **graph.json の URL 基準**で読み込む。
     別オリジンに置くなら CORS の許可が必要。
  2. ファイルをページにドラッグ＆ドロップ
  3. トップバーの「開く」、または graph を指定せずに開いたときの「graph.json を選ぶ」

  ファイルから開いた場合は相対パスのスクリーンショットを読めないので、画面はプレースホルダ（ルート名と regions の枠）で描く。
- 読み込み時に `validateGraph()` で検証し、エラー（赤）・警告（黄）を一覧で出す。参照エラーがあっても読める範囲で描画を続ける。
- メモとスクショの差し替えはブラウザの localStorage に保存する（キーは `project.name`、なければ graph の URL／ファイル名ごと）。
- WebGL が使えない環境ではメッセージを出す。

### テスト

```sh
pnpm test                                  # Vitest（closure・model・load・state・layout など）
pnpm --filter @stack-atlas/viewer e2e      # Playwright のスモークテスト（ビルドして vite preview で配信）
DOCS_SCREENSHOTS=1 pnpm --filter @stack-atlas/viewer e2e docs-screenshots   # docs/images/phase1-*.png を撮り直す
```

e2e は Chromium をヘッドレスで使う（WebGL は SwiftShader）。初回は `pnpm --filter @stack-atlas/viewer exec playwright install chromium` が必要
（`/opt/pw-browsers/chromium` がある環境ではそれを使う）。スクリーンショットは `packages/viewer/e2e/__screenshots__/overview.png` に保存する（比較はしない）。

| | |
|---|---|
| ![phase1](docs/images/phase1-overview.png) | ![phase1 hover](docs/images/phase1-hover-component.png) |
| Phase 1 のビューアでサンプルを表示 | ResultTable を指したところ |
