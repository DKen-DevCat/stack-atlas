# 10. スクショ抽出器ガイド（screenshots）

## 結論

- 対象アプリの**各コンポーネントのルート要素に `data-component="コンポーネント名"`** を付け、`stack-atlas.config.yaml` に `screenshots.baseUrl` を書けば、`stack-atlas build` が各ルートのスクショ（`shots/<slug>.png`）と領域（`screen.regions`）を graph.json に入れる。
- 動的ルート（`/races/[id]` など）は `screenshots.routes` に**サンプルの値**を書く。書かないルートは撮らない（警告が出る）。
- ログインが要る画面は、Playwright の **storageState**（Cookie と localStorage の JSON）を作って `screenshots.storageState` に指定する。
- 撮るのは**ビューポート 1 枚だけ**（既定 1280×800）。ページ全体は撮らない。

## 全体像

```
nextjs-app 抽出器 ── route:/races/[id] などのノード
        │
        ▼
screenshots 抽出器
  1. route パターン → URL（動的セグメントは routes のサンプルで置換）
  2. Chromium（Playwright）で baseUrl + URL を開く（networkidle まで待つ）
  3. ビューポートのスクショ → <outDir>/shots/<slug>.png
  4. [data-component] の getBoundingClientRect() → ノード ID に解決 → regions
        │
        ▼
graph.json の route ノードに screen: { screenshot, width, height, regions } がマージされる
```

ビューアは、ハイライト中のノードと `regions[].ref` が一致する領域をスクショ上に枠で表示する（`docs/03-graph-schema.md` の screen）。

## 手順

### 1. 対象アプリに `data-component` を付ける

コンポーネントが描画する**一番外側の要素**に、export 名をそのまま付ける。

```tsx
export function ResultTable({ rows }: Props) {
  return (
    <table data-component="ResultTable">
      …
    </table>
  );
}
```

- 名前は `comp:<名前>` → `hook:<名前>` → `…:<名前>` で終わるノード ID の順に解決される。`data-component="comp:ResultTable"` のように ID をそのまま書いてもよい。
- **hook** は DOM を持たないので、その hook の結果を表示している要素に hook 名を付ける（例: `useSession` の結果でログインボタンを出す `<div data-component="useSession">`）。
- 同じ名前の要素が複数あれば（一覧のカードなど）、それぞれが別の領域になる。
- 解決できない名前は警告に出して捨てる（ビルドは止まらない）。
- 本番に属性を残したくなければ、`process.env.NEXT_PUBLIC_STACK_ATLAS` などで出し分ける。

### 2. 設定を書く

```yaml
# stack-atlas.config.yaml
screenshots:
  baseUrl: http://localhost:3000        # 必須。これが無いと抽出器は動かない
  viewport: { width: 1280, height: 800 } # 省略時 1280×800
  routes:                                # 動的ルートのサンプル
    "/races/[id]": ["42"]
    "/docs/[...slug]": ["guide/intro"]
  storageState: .stack-atlas/auth.json   # 省略可。ファイルが無ければ未ログインで撮る
  outDir: .stack-atlas/out               # 省略可。build の出力先（graph.json と同じ）そのものだけ
```

### 3. アプリを起動してビルドする

```sh
pnpm --filter web build && pnpm --filter web start   # 本番ビルドの方が安定する
stack-atlas build .                                   # スクショ不要なら --no-screenshots
```

## 詳細

### 設定キー

| キー | 既定 | 説明 |
|---|---|---|
| `baseUrl` | なし | 開く URL の先頭。パス付き（`http://host/app`）も可 |
| `viewport` | `1280×800` | ブラウザの大きさ = スクショの寸法 = regions の座標系。`deviceScaleFactor` は 1 固定 |
| `routes` | `{}` | ルートパターン → サンプル値の配列 |
| `storageState` | なし | Playwright の storageState JSON（config のあるディレクトリ基準） |
| `outDir` | build の出力先 | 出力先（config のあるディレクトリ基準の相対パス）。PNG は `<outDir>/shots/` に置く。**graph.json と同じディレクトリにする**（`screen.screenshot` は graph.json からの相対パス `shots/<slug>.png`）。`stack-atlas build` は build の出力先（`-o`、既定 `.stack-atlas/out`）そのものだけを受け付け、絶対パス・出力先の外（`..` で出るものも）・出力先の下のディレクトリは警告して出力先にする（解析対象の repo の設定で PNG を任意の場所に書かせない。2026-11-09（8-3b のレビュー）: 下のディレクトリも受け付けていたが、graph.json からの参照 `shots/<slug>.png` と合わず画像が開けなかった）。`shots/` やその中のシンボリックリンクがあれば書かない |
| `timeout` | `15000` | 1 ページの読み込み待ち（ms）。超えたらそのルートだけ飛ばす |

### 動的ルートのサンプル

| パターン | サンプル | 開く URL |
|---|---|---|
| `/races/[id]` | `"42"` | `/races/42` |
| `/docs/[...slug]` | `"guide/intro"` | `/docs/guide/intro` |
| `/u/[user]/p/[post]` | `"alice/9"`（`/` 区切りで順に当てはめる） | `/u/alice/p/9` |
| `/docs/[[...slug]]` | なし | `/docs` |
| 任意 | `"/races/42?tab=1"`（`/` 始まり） | そのまま |

- サンプルが複数あっても、今は**最初の 1 つだけ**撮る（残りはログに出す）。
- スクショのファイル名（slug）はパターンから作る: `/` → `index`、`/races/[id]` → `races-id`、`/admin/entry` → `admin-entry`。

### 認証（storageState）

ログイン後の Cookie / localStorage を Playwright で保存しておく。一度だけ手で実行する。

```js
// scripts/save-auth.mjs
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto('http://localhost:3000/login');
// 手でログインする（または page.fill / page.click で自動化する）
await page.waitForURL('**/admin/**', { timeout: 120_000 });
await page.context().storageState({ path: '.stack-atlas/auth.json' });
await browser.close();
```

- `.stack-atlas/auth.json` は秘密情報なので **`.gitignore` に入れる**。CI ではテスト用アカウントで同じスクリプトを自動実行して作る。
- すべてのルートを同じ storageState で撮る（ルートごとの切り替えは未対応）。

### 失敗したとき

- ページの読み込み失敗・タイムアウトは警告を出してそのルートだけ飛ばす。ビルド全体は止めない。
- HTTP エラー（404 など）は警告を出したうえで、そのまま撮る。
- Chromium は `playwright` パッケージ（1.63.0）のものを使う。入っていなければ `pnpm exec playwright install chromium`。

### Chromium のサンドボックス

Chromium は**サンドボックスありで起動する**（`chromiumSandbox: true`。2026-11-10、8-4 のセキュリティレビュー）。撮るページは解析対象の repo の設定（`baseUrl`）が決めるので、サンドボックスの無いブラウザで開かない。サンドボックスの使えない Linux（AppArmor で非特権のユーザー名前空間が止められている GitHub の ubuntu の runner など）では起動に失敗するので、**信頼できる baseUrl だけを撮るとき**に限り `STACK_ATLAS_CHROMIUM_NO_SANDBOX=1` で外す（警告が出る）。撮らないなら `--no-screenshots`。

### 制限

- ビューポート 1 枚のみ。スクロールしないと見えない要素は、見えている部分だけ領域にする（完全に外なら捨てる）。
- 1 ルートにつきサンプル 1 つ。
- `data-component` が無いアプリでは regions が空になる。React DevTools の fiber から推定する代替は未実装（開発ビルド限定で不安定なため後回し）。
- アニメーションや遅延読み込みは `networkidle` 以上は待たない。
