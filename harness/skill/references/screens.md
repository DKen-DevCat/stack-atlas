# 画面（screens・data-component・fixtures モード・regions.yaml）

配線図の画面の箱には、対象アプリの**ビルド成果物の HTML**（静的エクスポート）が描かれ、HTML の `data-component` の位置で部品が光る。エージェントが書いてよいのは設定（`screens.dir` を除く）と `regions.yaml` だけで、対象アプリのコードとビルドは**提案**にとどめる（SKILL.md の禁止事項 2・5）。

## 1. 設定（`stack-atlas.config.yaml` の `screens`）

```yaml
screens:
  repo: web              # 複数 repo なら
  from: dir              # next-export（next.config の distDir、既定 out）か dir
  dir: export            # from: dir のときの HTML のディレクトリ（repo 相対）。★変えない・足さない（提案だけ）
  routes:                # 動的ルートのサンプル（最初の 1 件の HTML を使う）
    "/items/[id]": ["sample-1"]
  # viewport: { width: 1280, height: 800 }
```

- **HTML がまだ repo に無いなら screens を足さない**: 足すと HTML の無い route が全部 strict のエラーになり、それを埋めるには対象アプリのビルドが要る（実行できない）。人に「静的エクスポートを作ってから screens を設定する」ことを提案する
- `screens.dir`・`screenshots.baseUrl`・`screenshots.storageState` は変えない（repo の外や実サイトを指しうるため）。変えたいときは提案
- 報告の `screens.routes[]` の `html: false` は strict のエラー。動的ルートなら、HTML にあるサンプルを `screens.routes` に書けば消える。HTML そのものが無ければ提案（§4）

## 2. カバー率と `data-component` の提案

`screens.routes[].coverage` は、その route からたどれる部品の数（`reachable`）のうち、HTML の `data-component` で測れた数（`dom`）と regions.yaml で補った数（`yaml`）。低い route では、部品のルート要素に `data-component="<部品名>"` を付けるよう提案する（コードは変えない）:

```
提案: data-component を付ける（画面 /calendar のカバー率 1/4）
- web/src/components/month-summary.tsx の <section> に data-component="MonthSummary"
- …
理由: 静的エクスポートの HTML で部品の位置を測るため（Stack Atlas の docs/10）
```

名前は `comp:<名前>` → `hook:<名前>` → 末尾一致の順に箱 id に解ける。hook は DOM を持たないので、その結果を表示している要素に hook 名を付ける。

## 3. データで描かれる部品（SPA 型）と fixtures モードの提案

ブラウザで fetch してから描く部品（`useEffect` の中の fetch、SWR）は、静的エクスポートの HTML には「読み込み中」の枠しか無く、`data-component` を付けても測れない。対処は 2 つ:

1. **fixtures モードのビルド**（対象アプリの変更。人がレビューして実行する）を提案する:

```
提案: fixtures モードの静的エクスポート（Stack Atlas の画面用。本番のビルドは変えない）
- 環境変数 STACK_ATLAS_FIXTURES=1 のとき、データ取得層（例: src/lib/fetcher）が固定のデータ（fixtures/*.json）を返す
- SWR なら fallbackData に同じ fixtures を渡し、初期描画で描き切る
- 実バックエンドには接続しない（ネットワーク無しでビルドが通ること）
- 出力先を screens.dir に設定する（人が設定する）
- CSS-in-JS（styled-components・emotion）は SSR のレジストリを足すか、無装飾を受け入れる
```

2. **regions.yaml**（§5）で部品の位置を手で補う（つなぎ。位置は概略）

## 4. HTML の無い route

`html: false` の route は、静的エクスポートが古い（route を足した後にビルドしていない）か、prerender されない route。対象アプリのビルドを人に提案する（`next build` で `output: 'export'` を作り直す、など）。補いでは埋まらないので、strict が通らないことと理由を DECISIONS.md の「提案」に書いて人に返す。

## 5. `regions.yaml`

`.stack-atlas/screens/<slug>.regions.yaml`。`<slug>` は graph.json の画面の箱の `screen.html`（`screens/<slug>/index.html`）の `<slug>`（`/` なら多くは `index`）。

```yaml
# .stack-atlas/screens/calendar.regions.yaml
- { ref: "comp:MonthSummary", x: 24, y: 120, w: 600, h: 96 }
- { ref: "comp:CalendarGrid", x: 24, y: 232, w: 600, h: 420 }
```

- 座標は screens の viewport（既定 1280×800）の左上が原点。はみ出す分は切り詰められる
- **HTML の data-component で測れる部品は書いても使われない**（計測が勝つ）。測れない部品だけを書く
- `ref` は箱 id（名前でもよい）。解けない ref は警告して捨てる
- 位置は HTML の構造と CSS から見積もった概略。DECISIONS.md に「概略」と書く
- graph.json の regions には `source: "yaml"` で入り、カバー率は計測と別に数えられる（報告の `coverage.yaml`）
