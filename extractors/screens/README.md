# @stack-atlas/extractor-screens

ビルド成果物の HTML を route ごとに写し、**許可リストで消毒**して `<出力先>/screens/<slug>/index.html` に置く抽出器（Phase 8-3b。設計は `docs/18-design-wiring-viewer.md` §3.3・D62・D63）。
route の箱に `screen = { html, width, height, source }` を付ける（v1・v2）。ビューアは `allow-scripts` 無しの sandbox の iframe で縮小して描く。依存は足さない（HTML と CSS の字句解析は自前）。

## 設定

```yaml
screens:
  repo: web            # 複数 repo のときの対象
  from: next-export    # next-export（next.config の distDir、既定 out）| dir（任意のディレクトリ）
  dir: export          # from: dir では必須。next-export では distDir を上書き
  routes: { "/items/[id]": ["sample-1"] }   # 動的ルートのサンプル（最初の 1 件）
  viewport: { width: 1280, height: 800 }
  publicDir: public    # `/` で始まる参照の 2 つ目の探し先（next-export の既定は next.config のディレクトリの public）
```

書き出し先は build の出力先（CLI が `screens.outDir` に入れる）。設定ファイルの `screens.outDir` は読まない（repo の設定で出力先の外に書かせない）。
next.config の `trailingSlash`（`/a` → `a/index.html` を先に）・`basePath`・`assetPrefix`（パスでも URL でも）は、`from` に関係なく読む。

## 処理

| 段 | ファイル | 内容 |
|---|---|---|
| route → HTML | `index.ts` | `/` → `index.html`、`/a` → `a.html` / `a/index.html`。動的ルートは `routes` のサンプル。無ければ何もしない（プレースホルダ） |
| 字句と木 | `html.ts`・`entities.ts` | HTML の字句（タグ・属性・コメント・doctype・生テキストの要素）。終了タグを省ける要素以外で閉じていない要素は `broken` |
| 消毒 | `sanitize.ts` | 木から書き直す。doctype → `<head>` の最初の子に CSP の meta → charset。要素・属性の許可リスト、`on*`、URL の属性の判定 |
| CSS | `css.ts` | `<style>`・`style` 属性・写す CSS ファイル。`@import`・`image-set()`・外部の `url()` を落とし、`<` を書き出さない |
| URL | `urls.ts` | 文字参照・エスケープを解いた後、空白・制御文字を除き、`\` を `/` にしてから scheme を見る。相対と画像・フォントの `data:` だけ |
| 資産 | `assets.ts`・`fsafe.ts` | export と public の中だけ（realpath）、シンボリックリンクは辿らない、拡張子の許可リスト、名前は内容のハッシュ（`screens/_assets/<hash>.<ext>`）。SVG はファイルにせず、画像として読む所（img の src・srcset、CSS の url() など）に `data:image/svg+xml;base64` で埋め込む（1 ファイル 256 KB まで、1 つの画面の HTML・CSS ファイルに合計 2 MB まで。超えたら入れずに info）。消毒した HTML・CSS が 10 MB を超えたら書かない（警告） |
| カバー率 | `coverage.ts` | 解けた data-component ÷ route（と包む layout）から uses でたどれる comp / hook |

`issues.json` には route ごとに「消毒で落としたもの」（外部・危険な URL か `@import` があれば warning、ほかは info）と regions のカバー率（0 なら warning）、
写した CSS ファイルごとに落としたものを出す。

`stack-atlas build` は抽出器に出力先の中の一時ディレクトリ（`.screens-staging-*`）を渡し、build が成功して graph.json を書くときに、
前回の `screens/`（印 `screens/.stack-atlas-screens` があるもの）と入れ替える（失敗した build は前回の `screens/` を残す）。
出力先の `screens/` が印の無いディレクトリなら、画面を書かずに警告する（消しも上書きもしない。抽出器を直接呼んだときも同じ）。
`issues.json` と要約に出す文字列の制御文字（C0・DEL・C1・双方向の上書き）は `\u{1b}` の形にする。

## 落とすもの

`script` `noscript` `iframe` `object` `embed` `base` `meta[http-equiv]` `svg` `math` `template` `title` `textarea` `xmp` `noembed` `noframes` `plaintext`、
許可リストに無い要素（カスタム要素 `a-b` は残す）、コメント・CDATA、閉じていない要素、`<link>` の `rel=stylesheet` 以外、`on*`、
許可リストに無い属性（`ping` `formaction` `action` `data` `xlink:href` などの URL の属性も）、外部・危険な URL、`@import`・`image-set()`・`image()`・`element()`・`expression()`、`behavior`・`-moz-binding`。
`<html>` の外と `<head>` より前のものは、CSP より前に来るので落とす。`<head>` が無い文書は画面を出さない。

`<form>` は落とさず `<div>` に書き換える（中身の入力の見た目と `data-component` を残す。属性は div の許可リストなので `action` `method` `enctype` `target` `novalidate` `autocomplete` `name` は落ち、
中の input・button の `formaction` `form` なども許可リストに無いので落ちる）。送信は CSP の `form-action 'none'` と sandbox（`allow-forms` 無し）でも止まる。
