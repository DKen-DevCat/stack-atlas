# 14. 設計: 配布方法から逆算する（ハーネス配布・リクエスト深さの層・ビルド成果物の画面）

> **状態: 下書き（2026-11-07）。** この文書を書いた直後にユーザーと方向を見直し、「層を主軸にする」部分（§3.1・§3.2・§3.5 の層の割り当て）は `docs/15-design-dataflow-model.md`（箱・口・項目・線のモデル、形式 C）に置き換わった。ハーネス（§3.4）、ビルド成果物の画面とサニタイズ（§3.3）、ビューアの間隔と圧縮（§3.6・§4）、CLI（§3.7）は有効で、docs/15 のモデルの上に載せ直す。Q13〜Q18 は docs/15 のモックを見たあとに改めて確認する。

作成: 2026-11-07。実リポジトリ（`damage-web` ＋ `damage-platform`、149 ノード）の地図をユーザーが見た結果の要望から書いた。
`docs/12-design-generalization.md`（Phase 6・7）の続き。番号は D20〜、Q13〜。

ユーザーの要望（原文に近い形）:

> 1. 実画面をあげたくない。Playwright で画面取得するのではなく、コードを build して画面をここに直にあげたい。
> 2. キャッシュや、コンポーネントごとに階層も異なるはず。L2 と hooks が同じ層に書かれているが、実際にはキャッシュタイミングなどがありずれているはず。サーバーコンポーネントは API に近く、クライアントコンポーネントは画面に近い。
>    つまり、全てのアプリケーションに対応するというのは現実的でない。配布方法は CLAUDE.md みたいなハーネスにし、指定したコードごとに手元のエージェントがコードを探索してこのフォーマットに作り上げられる形にしたい。
> 3. 層の間隔をもっと広くして欲しい。

## 1. 結論

1. **配布物は「ハーネス」にする。** Claude Code の skill（`SKILL.md` ＋ 参照資料 ＋ テンプレート）を対象リポジトリに置き、ユーザー手元のエージェントがコードを探索して、**層の構成・ノードの割り当て・キャッシュ境界・画面の作り方・結線の補正**を設定ファイルに書く。
   既存の抽出器 12 本と CLI は捨てず、**エージェントが呼ぶ道具と、最後の検証器**に役割を変える。エージェントの成果物は graph.json そのものではなく **graph.json を再現できる設定**（`stack-atlas.config.yaml`・`.stack-atlas/graph/*.yaml`・`flows.yaml`）。だから CI の再生成はこれまでどおり決定的で、エージェントは要らない。
2. **Z 軸の意味を「利用者からの距離（どこで動くか）」に定義し直す。** 層の数と中身は固定 4 層ではなく、プロジェクトごとにエージェントが決める（目安 5〜8 層）。層と層の間は**キャッシュ境界**で、graph.json に `layers[].boundary` として持ち、ビューアが層の間に帯で描く。「hooks と部品は SWR のキャッシュで隔てられている」「クライアント部品は画面に近く、サーバー部品はデータに近い」が、この定義から自然に出る。
3. **画面はビルド成果物を直接載せる。** `next build`（静的エクスポートなら `out/**/*.html`）の HTML を集めて `screens/<slug>/index.html` として配信物に同梱し、ビューアが**ブラウザの中で** HTML をテクスチャにし、`data-component` の領域もその場で測る。Playwright・起動したサイト・認証（storageState）・実データは使わない。`screenshots` 抽出器はオプトインに格下げする。
4. **層の間隔を 7.5 → 12 にする**（スライダーで 10〜18）。広がった間に境界の帯とフローの粒子が入る。層が増えて背が高くなる分は、非表示にした層を間隔から除く「圧縮」で補う。

## 2. 全体像

```
対象リポジトリ（ユーザーの手元。例: damage-web ＋ damage-platform）
│
│  ① ハーネス = .claude/skills/stack-atlas/（SKILL.md・references/・templates/）
│     エージェント（Claude Code）が SKILL.md の手順でコードを探索し、判断を書く:
│       stack-atlas.config.yaml   層（layers＋boundary）・割り当て（classify）・画面（screens）・deploy / api.targets の固定
│       .stack-atlas/graph/*.yaml 抽出器が無いものの部分グラフ（手書きの nodes / edges）
│       flows.yaml                主要なデータフロー
│       .stack-atlas/DECISIONS.md なぜその層構成か、キャッシュ境界の根拠、抜き取り確認の結果
│
│  ② 道具 = stack-atlas CLI（決定的。CI でも同じ結果）
│       stack-atlas detect   → 構成の検出結果と、未割り当て・未結線の一覧（エージェントの入力）
│       stack-atlas build    → 抽出器 12 本 ＋ screens（ビルド成果物の HTML を集める）→ graph.json
│       stack-atlas validate --strict → 未割り当ての層・未解決の参照・画面の欠落を落とす
│       stack-atlas serve / build --with-viewer
▼
out/graph.json ＋ out/screens/<slug>/index.html（＋ CSS・画像）＋ viewer
▼
③ ビューア: N 層（間隔 12、圧縮あり）、層の間にキャッシュ境界の帯、画面は HTML をブラウザ内でテクスチャ化、
   パネルでは実 DOM（sandbox iframe）を表示してホバー連動
```

役割分担の原則: **機械で取れるものは機械で（抽出器）、判断はエージェントで（層・境界・結線・画面の作り方）、最後は機械で検証（validate --strict）**。
エージェントの判断は設定ファイルに残るので、人がレビューでき、次のコミットでは機械だけで再現できる。

## 3. 構造

### 3.1 Z 軸の意味と層の決め方（D20）

今は「インフラ / 画面 / コンポーネント・hooks / 型・API」の 4 層固定で、`kind` が層を決めている。これを **層 = 位置（利用者からの距離）、kind = 種類（形・色）** に分ける。graph.json はすでに `node.layer` を明示で持つので、変わるのは core の割り当て規則とハーネスの指針。

層を決める原則（ハーネスの `references/layering.md` の中身。エージェントはこれに従う）:

| # | 原則 | 具体例 |
|---|---|---|
| L1 | **Z = 利用者からの距離。どこで動くか**（ブラウザ → エッジ → サーバー実行時 → データ）。import の向きではない | ブラウザで動く部品は上、Lambda で動く Go は下、DB は最下段 |
| L2 | **キャッシュが挟まる場所で層を分ける**。層の境界 = キャッシュ境界。キャッシュが挟まらない 2 種類は同じ層でよい | 部品と hooks は SWR のメモリキャッシュで隔てられる → 別の層 |
| L3 | **実行場所が変わる場所でも分ける**（ブラウザ / エッジ / サーバー / ビルド時 / データ） | 静的エクスポートのサーバー部品は「ビルド時」に動き、HTML として配られる → 画面の直下 |
| L4 | **インフラは載せているものの直上か同じ層に置く**（`deploy` 辺は 0〜1 層だけ下へ）。インフラだけの 1 層は作らない | S3 → route（直上）、Lambda Function URL → Go 入口（直上）、Aurora とテーブル（同じ層） |
| L5 | **区別の無い層は作らない**。ノードが 1〜2 個の層は隣に併合する。目安 5〜8 層、上限 10 | サーバー部品が無ければ `server-ui` 層は作らない。Lambda(Next) 1 個のために層は作らず配信層に入れる |
| L6 | **判断と根拠を `.stack-atlas/DECISIONS.md` に書く** | 「SWR の dedupingInterval 2s を境界 B2 とした」 |

参照スタック A（ユーザーの実構成: Next 静的エクスポート → S3 ＋ CloudFront、ブラウザから Lambda Function URL の Go API、Aurora）:

| # | id | 名前 | 入るもの | 下との境界（boundary） |
|---|---|---|---|---|
| 0 | delivery | 配信 | actor:user（`cache` にブラウザの HTTP キャッシュ）、CloudFront、CloudFront Function、S3(site) | CloudFront キャッシュ（behavior の TTL・キャッシュキー） |
| 1 | routes | 画面・ルート | route、layout（静的エクスポートの HTML） | ビルド時に静的生成（再生成はデプロイのみ）。キャッシュではなく「固定」の境界 |
| 2 | static-ui | 静的部品（ビルド時に描画） | `runtime: server` の component（サーバー部品。HTML に焼かれている） | — （描画のみ。hydration で下の層へ） |
| 3 | client-ui | クライアント部品 | `runtime: client` / `shared` の component、`unknown` の既定 | SWR / React Query のメモリキャッシュ（dedupe・stale） |
| 4 | client-data | クライアントのデータ取得 | hook、fetcher / request の lib、API client | API の HTTP キャッシュ（`Cache-Control`、CloudFront の API behavior があればそれ） |
| 5 | api-edge | API 基盤 | Lambda Function URL ×5、Cognito、EventBridge Scheduler | Lambda のウォームインスタンス（プロセス内キャッシュがあれば） |
| 6 | api | API 契約・ハンドラ | endpoint:、handler（Go `cmd/*`）、Go の lib パッケージ | — |
| 7 | data | 型・スキーマ・データ | type（OpenAPI schema・TS 型）、schema（SQL テーブル）、Aurora（テーブルと同じ層。L4）、Secrets Manager | — |

ブラウザの HTTP キャッシュは利用者と CloudFront の**間**にあり、両者は同じ層なので境界ではなく `actor:user` の `cache` に付ける（層の中のキャッシュはノードの属性、層の間のキャッシュは境界、という使い分け）。

参照スタック B（Phase 0〜5 の前提: Next on Lambda、SSR / ISR、API Gateway ＋ Lambda の TS API、DynamoDB）:

| # | id | 名前 | 入るもの | 下との境界 |
|---|---|---|---|---|
| 0 | delivery | 配信・アプリ基盤 | actor、CloudFront、Lambda@Edge、Lambda(Next)（1 個なので併合。L5） | CloudFront キャッシュ |
| 1 | routes | 画面・ルート | route、layout | Full Route Cache / ISR（`revalidate`） |
| 2 | client-ui | クライアント部品 | `runtime: client` / `shared` の component | SWR / React Query |
| 3 | client-data | クライアントのデータ取得 | hook、API client | API の HTTP キャッシュ |
| 4 | server-ui | サーバー部品・データ取得 | `runtime: server` の component、server action、fetch ラッパ | Data Cache（`fetch` の `revalidate` / `tags`、`unstable_cache`） |
| 5 | api-edge | API 基盤 | API Gateway、Lambda(API) | — |
| 6 | api | API 契約・ハンドラ | endpoint:（API Gateway の route_key）、handler、lib | — |
| 7 | data | 型・スキーマ・データ | type、schema、DynamoDB | — |

両方の表で、既知の kind（actor / infra / page / layout / component / hook / lib / type / schema / handler / endpoint / queue / db / cron / service）がすべてどこかの層に入ることを、テンプレート（`templates/stack-atlas.config.yaml`）の classify で保証する。

A と B で「サーバー部品」の位置が違う（A は画面の直下、B は API の近く）のは原則 L1・L3 の帰結で、**ユーザーの「サーバー部品は API に近い」は SSR のときの真実**、静的エクスポートでは「ビルド時に焼かれて HTML として配られる」のが真実。この違いを固定の規則で吸収できないことが、エージェントに層を決めさせる理由。

辺の向きについて: 原則 L1 は import の向きではないので、**上向きの辺は普通にある**（例: B のサーバー部品 L5 がクライアント部品 L3 を描画する `uses`）。ビューアは今も向きを問わず描く（層またぎは上の層の色）。`validate --strict` も向きは咎めない。

### 3.2 キャッシュ境界（D21）

キャッシュは今、ノードの `cache` フィールド（バッジ・ルール・注意）として個々に付いている。これに加えて **層と層の間** に境界を置く。

graph.json の追加（すべて任意。`version` は 1 のまま、後方互換）:

```jsonc
"layers": [
  { "id": "client-ui", "name": "クライアント部品", "color": "#a78bfa",
    "boundary": {                       // この層と「次の層」の間に挟まるもの
      "name": "SWR のメモリキャッシュ",
      "cache": { "tone": "ok", "badge": "SWR dedupe 2s",
                 "rules": [{ "key": "dedupingInterval", "value": "2000ms" }],
                 "note": "タブごと。リロードで消える" },
      "nodes": ["lib:src/lib/swr-config"]   // 境界を実装・設定しているノード（任意）
    } },
  { "id": "routes", "name": "画面・ルート",
    "boundary": { "name": "ビルド時に静的生成", "cache": { "tone": "info", "badge": "build time" } } }
]
```

- `boundary.cache` は既存の `Cache` 型をそのまま使う（tone・badge・rules・note。色は既存の `TONE_COLORS`）。キャッシュではない境界（ビルド時の固定、ネットワーク境界）は `cache` 無しで `name` だけでもよい
- schema は `additionalProperties: false` なので、`boundary` / `screen.html` / `screen.source` は schema・`types.ts`・`types.test.ts`（今は layer / screen のキーを比べていないので比較に加える）・docs/03 を同時に直す。互換の主張は「**新しいビューアは古い graph.json を読める**」に限る（古いビューアは新しい graph.json を検証エラーにする。`version` は 1 のまま）
- `boundary.nodes` は、その境界を設定しているノード。帯をクリックするとそれらが選択され、パネルにルールが出る
- **二重化を避ける**: `cache` を書かず `nodes` だけ書いた境界は、ビューアが `nodes[0]` の `cache` を帯に使う（CloudFront の behavior は `infra:cloudfront` の `cache` にすでにあるので、境界では参照するだけでよい）。`cache` を書けばそれが優先
- ビューア: 層の間に **薄い帯**（板より小さい、tone の色、不透明度 0.12）と `badge` のラベルを描く。位置は層間の中央ではなく **上の層の画面上端 ＋ 余白 1.0**（§4。中央だと間隔が狭いとき画面と重なる）。キャッシュモード中は帯を強調し、ホバーで `note` を出す。境界の無い層間には何も描かない
- 非表示の層の境界: 連続して非表示の区間があるとき、その区間の **直上の表示中の層の帯だけ** を描き、区間内の層の帯は描かない（圧縮で層が消えても、表示中の 2 層の間に帯が 2 枚以上重ならない）
- 出どころ: 境界は少ない（1 プロジェクトで 3〜6 個）ので **エージェントが `config.layers[].boundary` に書く**。cdktf / terraform（CloudFront behavior）・cache 抽出器（SWR）がすでに取っているノードの `cache` を、エージェントが境界に要約する形
- 後回し: フローの粒子が境界で止まって戻る（HIT）表現。`flows.steps` に `boundary:<layerId>` を許す案。今回は入れない

### 3.3 画面はビルド成果物（D22・D25）

#### 契約（graph.json）

```jsonc
"screen": {
  "html": "screens/items-id/index.html",   // 追加。graph.json からの相対パス。自己完結の HTML（script 無し）
  "source": "next-export",                 // 追加。next-export | next-build | dir | wireframe | screenshot
  "width": 1280, "height": 800,            // 既存。html のときはビューポート（描画と regions の座標系）
  "screenshot": "shots/x.png",             // 既存。html と両方あれば html を優先
  "regions": [...]                         // 既存。html のときは省略可（ビューアが data-component から測る）
}
```

#### 集める側（新しい抽出器 `screens`。`screenshots` と排他ではなく、既定はこちら）

```yaml
screens:
  repo: web
  from: next-export            # next-export（out/）| next-build（.next/server/app/**.html。prerender されたルートだけ）| dir（任意のディレクトリ）
  dir: out                     # from に応じた既定。next-export は next.config の distDir / out
  routes: { "/items/[id]": ["sample-1"] }   # 動的ルートのサンプル（generateStaticParams の値から選ぶ）
  viewport: { width: 1280, height: 800 }
  publicDir: public            # 画像などの参照先
  build: null                  # 省略時はビルドしない（CI は既存の成果物を使う）。"pnpm build" と書くと実行する
```

処理:

1. nextjs-app が出した `route:` ごとに HTML ファイルを決める（`/` → `out/index.html`、`/items/[id]` → `out/items/sample-1.html` か `out/items/sample-1/index.html`。Pages Router も同じ規則）。そのために nextjs-app の設定読み取り（`files.ts` の `readNextOutput`。今は `output` だけ）を **`trailingSlash` / `basePath` / `assetPrefix` / `distDir`** まで広げる
2. HTML を `out/screens/<slug>/index.html` に写す。このとき **許可リスト方式でサニタイズ**する: 残すタグ・属性・URL スキーム（`data:` と相対パス）を列挙し、それ以外を落とす。落ちるもの: `<script>`、`<noscript>`（**`allow-scripts` 無しの sandbox では `<noscript>` の中身が描画される**。GTM の `<noscript><iframe>` が定番）、`<iframe>` / `<object>` / `<embed>`、`<form>`、`<link rel=preload|modulepreload|preconnect|dns-prefetch|prefetch>`、`<meta http-equiv>`、インラインのイベント属性、外部 URL を持つ `src` / `href` / `srcset` / CSS `url()`。先頭に `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'none'">` を注入する
3. 相対化できる参照（`/_next/static/css/*.css`、`/_next/static/media/*`（`next/font`）、`public/` の画像。静的エクスポートの `next/image` は `unoptimized`）を `out/screens/_assets/` に写し、相対パスに書き換える。**外部 URL が残ったら `validate --strict` でエラー**（D25）
4. route ごとに **regions のカバー率**（HTML で解決できた `data-component` の数 ÷ その route から `uses` でたどれる comp / hook の数）を `issues.json` に出す。0 なら警告「regions が取れません。`docs/10` の `data-component` を付けてください」（ビルドは止めない）
5. HTML が無いルート（サンプルの無い動的ルート、`next-build` で prerender されていないルート）は、`.stack-atlas/screens/<slug>.html` があればそれを `source: wireframe` として使い、無ければ今までどおりプレースホルダ
6. HTML はあるが部品が描かれていないルート（下記の SPA 型）は、`.stack-atlas/screens/<slug>.regions.yaml`（エージェントが書く概略の矩形。`ref` と `x y w h`）があれば `screen.regions` に入れ、ビューアの計測より優先する

**実データ非混入（D25）**: ハーネスは「画面のためのビルドは実バックエンドに接続しない」を規約にする（静的エクスポートでビルド時 `fetch` があるなら、ネットワーク無しで失敗させて気づく）。

**SPA 型の限界（レビューで判明）**: 実構成 A はブラウザから fetch する SPA 型で、静的エクスポートの HTML は `useEffect` で fetch する部品の**初期描画しか含まない**（fixture-poly の `today-island.tsx` は `<p data-component="TodayIsland">読み込み中</p>` だけで、`TotalCard` / `EntryList` は HTML に存在しない）。つまり **データに依存する部品の領域は HTML から取れない**。認証ガード（未ログインは spinner）も同じ。対処は 3 段:

| 段 | 方法 | 取れるもの | 対象アプリへの変更 |
|---|---|---|---|
| (a) | 静的エクスポートの HTML そのまま | レイアウト・ナビ・静的部品・データ部品の「読み込み中」の枠 | なし |
| (b) | **fixtures モードでビルド**: データ取得層（fetcher / SWR の `fetcher`）を環境変数で固定データに差し替え、初期描画で描き切る（`useEffect` の fetch は SSG では走らないので、SWR の `fallbackData` か fixtures を返す fetcher を SSG 時に通す） | データ部品の領域まで | あり（人がレビュー） |
| (c) | エージェントが `.stack-atlas/screens/<slug>.regions.yaml` に概略の矩形を書く | ハイライトの位置だけ | なし |

既定は (a) で、カバー率が低い route を `issues.json` が挙げ、ハーネスがエージェントに (b) を提案させる（(b) は Phase 8 の範囲に入れる。後回しにしない）。(c) は (b) ができないときのつなぎ。

`screenshots` 抽出器は残すが、`screens` が有効なら動かさない（`extractors.screenshots: true` で明示したときだけ）。

#### 描く側（ビューア）

`ScreenCanvas` に `html` モードを足す。PNG のときの流れ（遅延読み込み → ベース画像 → ハイライト重ね描き）は同じで、ベース画像の作り方だけ違う。

1. 非表示の iframe（`position: fixed; left: -10000px`、`width/height` = viewport、`sandbox="allow-same-origin"`。`allow-scripts` は付けない）に `screen.html` を読む
2. `load` 後、`contentDocument.fonts.ready` と画像の読み込みを待つ（上限 3 秒）
3. `[data-component]` を `getBoundingClientRect()` で測り、名前をノード ID に解決する（`comp:<名>` → `hook:<名>` → 末尾一致。screenshots 抽出器と同じ規則をビューアに持つ）→ `regions`。graph.json に `regions` があればそれを優先
4. SVG `foreignObject` 方式で `documentElement` をラスタライズして canvas に描く（外部 CSS と画像を data URL に内包してから `<svg><foreignObject>` に入れ、`Image` → `drawImage`）。ライブラリは `modern-screenshot`（`domToCanvas`。MIT、外部通信なし。iframe の `ownerDocument` を扱える）を第一候補。`next/font` の data URL を画面ごとに埋め込み直さないよう、フォントの内包結果は画面間で共有する。**依存追加は確認を取る**（Q14）
5. `drawImage` の直後に `getImageData(0, 0, 1, 1)` を try/catch して**汚染（tainted）を検査**し、汚れていればプレースホルダに戻してから `needsUpdate` を立てる（Safari は WebGL へのアップロード時に非同期で失敗するため、先に検査する）
6. iframe を外す。同時に走らせるのは 2 枚まで、視点に近い画面から。結果はノードごとにメモリに持つ
7. ラスタライズに失敗したら、プレースホルダに `regions` の枠だけ描く。**3 で測った領域は生きているので、ホバーは効く**

パネル（画面ノードを選んだとき）: 「画面」タブに **実 DOM** を `sandbox="allow-same-origin"` の iframe で表示する（パネル幅に `transform: scale`）。親から `contentDocument` に `mouseover` / `click` を付け、`[data-component]` の上に来たら 3D 側のホバー・選択に流す。アンカーのクリックと Enter は `preventDefault`（sandbox でも iframe 自身の遷移は起きるため）。`<form>` はサニタイズで落としており、`allow-forms` も付けない。

CSS-in-JS（styled-components / emotion）は SSR レジストリが無いと静的 HTML が無装飾になる。`references/screens.md` に、その場合は (b) fixtures モードのビルドにレジストリを足すか無装飾を受け入れるかを書く。Tailwind や CSS Modules は CSS ファイルとして出るので問題ない。

安全性: HTML はビルド時に `<script>` を落とし、実行時も `allow-scripts` 無しの sandbox に入れる。`allow-same-origin` は領域の計測に必要で、読む HTML は graph.json と同じ出所（自分のビルド成果物を自分の配信元から読む）。`/security-review` の対象（Phase 8 の PR）。

#### 画面の大きさ

`SCREEN_W = 6.4`、比率は 768:480 固定だったが、`screen.width/height` の比率で描く（1280×800 = 16:10 なら高さ 4.0）。`SCREEN_FOOTPRINT` もそれに合わせる。

### 3.4 ハーネス（D23・D24）

#### 配布の形

- `@stack-atlas/cli`（npm）に `init --skill` を足す。対象リポジトリ（複数 repo なら設定を置くディレクトリ）に `.claude/skills/stack-atlas/` を**コピー**し、`stack-atlas.config.yaml` の雛形と `.stack-atlas/` を作る。既存ファイルは上書きしない
- skill の正本はこのリポジトリの `harness/skill/`。Claude Code の plugin（marketplace）化は、コピー方式が安定したあと（Q16）
- `templates/` は **fixture-poly から作る**。実リポジトリの設定・名前は写さない（CLAUDE.md の非公開ルール）。`init --skill` はコピーする一方向で、対象リポジトリから何かを読み戻すことはない
- `SKILL.md` は Markdown なので、他のエージェント（AGENTS.md 系）からも参照できる。Claude Code 固有の記法は使わない

#### 構成

```
harness/skill/
  SKILL.md                 手順（下記 8 ステップ）。短く、判断の規則は references/ に送る
  references/
    layering.md            §3.1 の原則 L1〜L6 と参照スタック A・B。層構成の決め方と DECISIONS.md の書式
    boundaries.md          キャッシュ境界の読み取り方（CloudFront behavior / ISR・Full Route Cache / Data Cache / SWR・React Query / ブラウザ HTTP）と tone の付け方
    screens.md             §3.3。ビルド成果物の場所、サンプルの選び方、data-component の付け方、禁止事項（実サイト・認証・実データ）
    classify.md            割り当て規則（§3.5）の書き方と、よくある割り当て表
    graph-files.md         `.stack-atlas/graph/*.yaml` の書式（抽出器が無いものを部分グラフとして書く）
    ids.md                 ID 規約（docs/03 の抜粋）
    flows.md               flows.yaml の書き方（init-flows の雛形をどう直すか）
    checklist.md           完了条件と抜き取り確認の手順
  templates/
    stack-atlas.config.yaml   層・境界・classify・screens の雛形（参照スタック A）
    DECISIONS.md
    graph/README.md
```

#### 手順（SKILL.md の骨子）

1. **検出**: `stack-atlas detect <dir> --json` を実行し、見つかった構成（IaC・フレームワーク・言語・契約）、動く抽出器、`推定` の一覧を読む。足りない設定キー（`repos`・`next.appDir`・`go.entries` など）を埋める
2. **層を決める**: `references/layering.md` の原則で層構成を決め、`config.layers`（id・name・color・boundary）に書く。根拠を `.stack-atlas/DECISIONS.md` に書く。参照スタック A・B に近ければそれを出発点にする
3. **割り当てる**: `stack-atlas build --dry-run` を回し、`issues.json` の「未割り当て」（既定の層にしか置けなかったノード）を `classify`（§3.5）で解消する。抽出器の無いもの（例: 外部 SaaS、cron の中身）は `.stack-atlas/graph/*.yaml` に部分グラフとして書く
4. **結線を固定する**: `推定` を確かめ、当たっていれば `deploy` / `api.targets` / `sql.db` に書いて固定（D18）。足りない線は overrides
5. **境界を書く**: 各層の `boundary`。出どころ（CloudFront behavior、SWR の設定、`revalidate`）を `boundary.nodes` に挙げる
6. **画面**: `screens` を設定し、`stack-atlas build` で `out/screens/` ができることを確かめる。`data-component` が無ければ、付ける変更を提案する（対象リポジトリへの変更なので人がレビューする）
7. **フロー**: `stack-atlas init-flows` の雛形を、実際の挙動に合わせて直す（境界を通る場所に HIT / MISS の文を書く）
8. **検証**: `stack-atlas validate out/graph.json --strict` が通ること。ノードを 3 つ抜き取り（画面 1・部品 1・API 1）、ハイライトされる依存先がコードと一致するか確かめて DECISIONS.md に書く。最後に `serve` で見せる

**再生成**: 以降のコミットでは CI が `stack-atlas build` → `validate --strict` を機械だけで回す。strict が落ちたとき（新しいノードが未割り当て、画面の欠落）だけ `/stack-atlas update` でエージェントを呼び、`issues.json` の項目だけを直す。

**ドッグフード**: `examples/fixture-poly/` にハーネスを当てて、参照スタック A の 8 層構成の設定を作り、それを fixture-poly の正式な設定にする。これが N 層・境界・HTML 画面の e2e フィクスチャになる（CI で LLM は呼ばない。ハーネス自体の実走は手で行い、結果と所要時間を docs に書く）。

**「ソースコードを外部 SaaS に送らない」との関係（Q17）**: ハーネスはユーザー手元の Claude Code が読むので、コードはユーザーが契約しているモデル API に送られる（今も業務コードで Claude Code を使っているので、新しい露出ではない）。ビューア・CLI・配信物はこれまでどおりローカル完結。CLAUDE.md の文言は「抽出・ビューア・配信物はローカル完結。エージェントはユーザーの判断で使う」に直す。

### 3.5 割り当て規則の拡張（core）

`classify` は今 `glob → kind / layer`。層が「どこで動くか」になるので、glob だけでは足りない（同じディレクトリにサーバー部品とクライアント部品が混ざる）。条件を足す:

```yaml
classify:                                     # 上から順、最初に合ったもの（既存どおり）
  - { glob: "src/components/**", runtime: client, layer: client-ui }
  - { glob: "src/components/**", runtime: server, layer: static-ui }
  - { kind: hook, layer: client-data }
  - { glob: "src/lib/fetcher/**", layer: client-data }
  - { kind: infra, resource: "aws_cloudfront_*", layer: delivery }
  - { kind: infra, resource: "aws_s3_bucket", layer: delivery }
  - { kind: infra, resource: "aws_lambda_*", layer: api-edge }
  - { kind: [endpoint, handler], layer: api }
  - { kind: [type, schema], layer: data }
  - { kind: infra, resource: "aws_rds_*", layer: data }
  - { kind: component, runtime: [shared, unknown], layer: client-ui }   # 既定行（必須。strict で未割り当てにしない）
```

| 条件 | 対象 | 出どころ |
|---|---|---|
| `glob` | repo 相対パス（既存） | |
| `kind` | 文字列か配列 | |
| `runtime` | `client` / `server` / `shared` | ts-imports が `meta.runtime` に出す（下記） |
| `resource` | インフラのリソース型の glob | tf-graph の `meta.infra.type` |
| `id` | ノード ID の glob | |
| `repo` | 既存 | |

**matcher の書き換え**: 今の `findClassifyRule`（`classify.ts`）は `glob` 必須で、`applyClassify` は `file` の無いノードを飛ばす。そのままでは `{ kind: infra, resource: … }` の規則は一度も当たらない。`glob` を省略可にし、`file` の無いノードも `kind` / `resource` / `id` / `runtime` で照合する。ただし **`kind` を変えられるのは `glob` の規則だけ**（ID の接頭辞を決める `classifyKind()` はファイルを読む時点で呼ばれ、そのとき分かるのは glob だけ）。`runtime` / `resource` / `id` の条件は `layer` だけを変える。

**ts-imports の `meta.runtime`**（App Router のときだけ付ける）:

| 値 | 条件 |
|---|---|
| `client` | ファイル先頭に `'use client'`、または `'use client'` のファイルから（推移的に）import されている。hook は常に `client` |
| `server` | App Router の `app/` から（推移的に）到達でき、`client` に該当しない |
| `shared` | `client` と `server` の両方の条件に当たる（両側から import される型・変換関数） |
| `unknown` | どこからも import されていない（孤立）。strict で報告 |

Pages Router は全部品が hydrate されるので `runtime` を付けず、classify は glob と kind で書く。静的エクスポート（App Router）の `server` は「ビルド時に描画」の意味で、層の名前はエージェントが付ける。テンプレートの classify は末尾に **`shared` と `unknown` の既定行**（例: `client-ui`）を必ず持つ。

**未割り当ての検出**: 層の id を見比べる方法では判定できない（参照スタック A の `routes` は既定 4 層の `routes` と同じ id で、classify 漏れの page が既定で落ちても区別がつかない）。そこで `assignLayers`（`layers.ts`）が **割り当ての出どころ**（`classify` の規則 / `config.layerOf` / `kinds[].layer` / `DEFAULT_LAYER_OF`）を返すようにし、「`config.layers` が既定でない ∧ 出どころが `DEFAULT_LAYER_OF`」を `未割り当て` として `issues.json` に出す。`validate --strict` ではエラー。導入期（ハーネスを当てた直後の数コミット）は CI では警告にとどめ、落ち着いたら `--strict` に切り替える手順をハーネスに書く（未分類ディレクトリへの 1 ファイル追加で CI が止まるのを避ける）。

**`.stack-atlas/graph/*.yaml`**: `nodes` / `edges` / `flows` を持つ部分グラフ。**overrides と同じ段（classify のあと）で適用し、yaml の値が勝つ**（今のマージは「先に出た値が勝つ」なので、抽出器と同じ id を書いても黙って負ける。これを避ける）。未知の id への辺は overrides と同じくエラー。overrides は「補正」、graph/ は「記述」で、1 ファイルに数十ノード書くことを想定し、関心ごとに分けられるようにする。

### 3.6 ビューアの変更

| 項目 | 今 | 変更 |
|---|---|---|
| 層の間隔 | `LAYER_GAP = 7.5`（奥行き 20 超で少し広げる） | 既定 **12**。トップバーに間隔スライダー（**10**〜18。§4）、`?gap=` でも指定。`layerGapFor` の奥行き補正は残す。`sceneScaleFor` の分母は定数 7.5 ではなく**選んだ gap**にし、間隔を変えてもカメラの基準距離が変わらないようにする |
| 非表示の層 | Y は固定で、板と中身だけ消える | **圧縮**: 表示中の層だけで Y を並べ直す（アニメーション付き）。`layerY(index, count)` を `layerY(rank, visibleCount)` にし、layerIndex → rank の写像を state に持つ（`ghosts.ts` など layerIndex を使う箇所も rank 経由にする）。`app.ts` の `sceneScale` は `readonly` で fog・far・maxDistance・ラベル LOD の閾値に生成時に焼き込まれているので、`renderer.setSceneScale()` を足して圧縮のたびに更新する。層が 8 つあっても、見たい 3 層だけなら高さは 2 間隔分 |
| 層の数 | 2〜6 で確認 | 2〜10。既定の色は 10 色の順序付きパレット（上が暖色、下が寒色）。層チップは縦スクロール |
| 境界 | なし | §3.2 の帯。クリックで `boundary.nodes` を選択、パネルに `cache` の表 |
| 画面 | PNG テクスチャか プレースホルダ | §3.3 の HTML モードを追加。PNG は残す |
| パネル | スクショ差し替え | 「画面」タブに実 DOM（sandbox iframe）、ホバー連動 |
| カメラ | `sceneScaleFor(plate, 層数, gap)` | 圧縮後の層数と gap で計算。視点リセットは表示中の層の高さに合わせる |

ビューアは引き続き graph.json だけを読む（`boundary`・`screen.html` は schema の追加）。core には依存しない。

### 3.7 CLI の変更

- `detect <dir> [--json]`: 検出結果（構成・動く抽出器・`推定`・未割り当て）を出す。`build -v` の情報をエージェントが読める形にしたもの
- `build --dry-run`: 抽出とマージまで行い、graph.json を書かずに `issues.json` 相当を出す
- `validate --strict`: 未割り当て・未解決の参照・`screen.html` の欠落・`boundary.nodes` の未解決をエラーにする
- `init --skill`: §3.4
- `screens` 抽出器の登録（順序: … → screenshots の前）。`screens` があるとき screenshots は明示有効化のみ

## 4. 数値の根拠: 層の間隔

3D 空間の寸法（`packages/viewer/src/layout/plate.ts`、`scene/nodes.ts`）から計算した。

| 量 | 値 | 出どころ |
|---|---|---|
| 画面ノードの高さ | 4.0（16:10 で 6.4 幅） | `SCREEN_W × 800/1280` |
| 展開時の画面の傾き | 板から約 60°（`-π/2 + 1.05 rad`） | `nodes.ts:162` |
| 画面の上端の高さ（層の Y から） | pivot が y − 0.33、そこから 4.0 × sin 60° ≈ 3.46 → **約 3.5** | `nodes.ts:162` 付近 |
| 板の下げ幅 | 0.4（層の Y より下にあるので上方向の計算には入れない） | `plates.ts:44` |
| ラベル（CSS2D）の高さ | 約 0.8（視点リセット位置で約 25px/単位、ラベル 20px）。**sceneScale 1 のとき**。カメラが遠くなるとこの値は大きくなる | `labelWidthOf` の換算 |
| 境界の帯 ＋ ラベル | 約 1.2 | 新規 |
| 帯の上下の余白 | 1.0 × 2 | 新規（帯が画面やラベルに触れない） |

- 今の 7.5: 画面の上端から次の層の Y まで 7.5 − 3.5 = **4.0**。ラベル 0.8 を引くと 3.2 で、帯 1.2 ＋ 余白 2.0 = 3.2 がぎりぎり。粒子の移動が見える余地が無い
- 必要量: 3.5 ＋ 0.8 ＋ 3.2 = **7.5** が最低。粒子が「層の間を移動している」と分かるには、帯の上下に粒子の移動距離がもう 1.5 ずつ欲しい → **10.5**。帯は層間の中央ではなく「画面上端 ＋ 余白 1.0」に置く（中央だと gap 8 で画面に重なる）
- 既定 **12** にし、スライダーの下限は帯が収まる **10**、上限 18。`sceneScaleFor` の分母を選んだ gap にするので、間隔を変えてもカメラは層数と板の大きさだけで決まる（今の式のままだと gap 12・4 層で基準距離が 1.6 倍遠くなり、ラベルの見かけの高さが 0.8 → 1.3 になる）
- 8 層（参照スタック A）では高さ 7 × 12 = 84 で、今の 4 層（22.5）の 3.7 倍。視点リセットの距離が伸びてノードが小さくなるのは避けられないので、**圧縮**（非表示の層を間隔から除く）と既存の LOD で補う。8 層すべてを一度に読む場面は少なく、「配信〜クライアント」「クライアント〜API」のように 3〜4 層ずつ見る想定
- Phase 8-2 の**最初に** fixture-poly の 8 層構成を描いて実測し、既定値と下限を確定する（スクショを `docs/images/phase8-*.png` に残す）

## 5. タスク（Phase 8）

| # | 内容 | 完了の目安 |
|---|---|---|
| 8-1 schema / core | `layers[].boundary`、`screen.html` / `source`（`types.test.ts` の比較対象に追加）、`classify` の matcher 書き換え（glob 省略可、`kind` / `runtime` / `resource` / `id`）、ts-imports の `meta.runtime`（App Router のみ、推移的 import、`shared` / `unknown`）、`.stack-atlas/graph/*.yaml`（overrides と同じ段、yaml が勝つ）、割り当ての出どころと未割り当ての検出、`validate --strict` | schema・型・docs/03 が揃い、`pnpm validate` と既存テストが通る。fixture-poly の 8 層設定で未割り当て 0 |
| 8-2 viewer | 間隔 12 とスライダー、圧縮、10 層パレット、境界の帯、HTML 画面（iframe 計測 → ラスタライズ → テクスチャ）、パネルの実 DOM とホバー連動、カメラ | fixture-poly の 8 層・境界 5 つ・HTML 画面 4 枚が描け、e2e で領域ホバーが通る。`docs/images/phase8-*.png` |
| 8-3 screens 抽出器 | `next-export` / `next-build` / `dir`、許可リスト方式のサニタイズと CSP の注入、asset の収集、Next 設定（`trailingSlash` / `basePath` / `assetPrefix` / `distDir`）、サンプルの解決、カバー率、wireframe と `regions.yaml` のフォールバック、fixtures モードの手引き（`references/screens.md`）、screenshots のオプトイン化 | fixture-poly の `web/out/`（静的エクスポートの成果物をフィクスチャとして置く。`<noscript>` と外部 URL を含む HTML を入れてサニタイズを固定）から `out/screens/` ができ、外部 URL が 0 |
| 8-4 ハーネス | `harness/skill/`（SKILL.md・references・templates）、`init --skill`、`detect --json`、`build --dry-run`。fixture-poly にハーネスを当てる（手動）→ 設定を fixture-poly の正式な設定にする | 手動の実走で、参照スタック A と同じ層構成が出て `validate --strict` が通る。所要時間と直した箇所を docs に書く |
| 8-5 実リポジトリ | ユーザーの手元で `init --skill` → `/stack-atlas`。結果は非公開。件数と所要時間だけ docs に書く | 8 層前後の地図がビューアで開け、画面が HTML から出て、境界の帯が実際のキャッシュ設定と一致する |
| 8-6 docs | docs/02・03・05・06・13、HANDOFF、CLAUDE.md（Q17 の文言）、README の「使い方」をハーネス前提に書き直す | |

順序: 8-1 → 8-2 と 8-3 は並行 → 8-4 → 8-5 → 8-6。8-1 と 8-2 の PR は `/security-review` の対象（iframe・HTML の取り込み）。

## 6. 決定事項（提案。ユーザーの確認待ち）

| # | 決定 | 理由 |
|---|---|---|
| D20 | Z 軸 = 利用者からの距離（どこで動くか）。層の数と中身はプロジェクトごとに決め、kind は形と色だけを決める | 「hooks と部品のキャッシュのずれ」「サーバー部品とクライアント部品の位置」は実行場所の違い。固定 4 層では表せない |
| D21 | キャッシュ境界を `layers[].boundary` として graph.json に持ち、層の間に帯で描く | キャッシュは「ノードの属性」より「層の間に挟まるもの」として見たほうが、HIT / MISS の経路と一致する |
| D22 | 画面はビルド成果物の HTML。ビューアがブラウザ内で領域を測りテクスチャ化する。Playwright はオプトイン。SPA 型でデータ部品が HTML に無いときは fixtures モードのビルド（対象アプリの変更）か `regions.yaml` で補う | 実サイト・認証・実データを使わない。利用者側の CI から Chromium が消える（このリポジトリの viewer e2e は残る） |
| D23 | 配布はハーネス（skill）。抽出器と CLI はエージェントの道具と検証器 | 層の判断はプロジェクトごと。判断はエージェント、列挙と検証は機械 |
| D24 | エージェントの成果物は graph.json ではなく、それを再現する設定（config・graph/*.yaml・flows・DECISIONS.md） | CI は決定的に再生成でき、判断は人がレビューできる |
| D25 | 画面のビルドは実バックエンドに接続しない。HTML は許可リストでサニタイズし（`<noscript>`・外部 URL も落とす）、CSP を注入して sandbox で表示する。外部 URL が残れば strict でエラー | 実データ非混入・外部通信なし。ビューアに任意コードを持ち込まない |
| D26 | 層の間隔 12（10〜18 可変）、非表示の層は間隔から除く。カメラの基準距離は間隔に依存させない | §4 の計算。層が増えても見たい層だけ寄せて読める |

## 7. 未決事項（ユーザーに確認すること）

| # | 論点 | 選択肢 | 推奨 |
|---|---|---|---|
| Q13 | 画面の中身 | (a) 静的エクスポートの HTML そのまま（データ部品は「読み込み中」の枠だけ。領域はほぼ取れない）／(b) fixtures モードでビルド（データ取得層を差し替える。対象アプリへの変更が要る）／(c) エージェントが書く概略の矩形（`regions.yaml`）やワイヤーフレーム | **(a) を既定にしてカバー率を出し、実構成 A のようにデータ部品が多いアプリでは (b) を Phase 8 で入れる**。(c) はつなぎ。(b) の対象アプリへの変更を許容できるかが論点 |
| Q14 | ラスタライズの依存追加 | `modern-screenshot`（foreignObject 方式、MIT）／自前実装／ラスタライズせず CSS3D の実 iframe を 3D に置く | **`modern-screenshot`**。CSS3D は WebGL の線と前後関係が取れず却下 |
| Q15 | インフラノードの置き場 | 載せているものの直上に分散（原則 L4）／従来どおり 1 層にまとめる | **分散**。「Lambda の下に Next」の見え方は保たれ、deploy 辺が短くなる |
| Q16 | 配布形態 | `init --skill` でコピー／Claude Code plugin／両方 | **まずコピー**。plugin は安定後 |
| Q17 | 「外部 SaaS に送らない」の読み替え | エージェント経由でコードがモデル API に行くことを許容し CLAUDE.md を直す／許容しない（ハーネス案を取り下げる） | **許容**（今も Claude Code を業務コードに使っている） |
| Q18 | 層の間隔の既定 | 12 を既定にして実測で確定／別の値 | **12**（下限 10）、Phase 8-2 の最初に実測して確定 |

## 8. 設計レビューの記録

2026-11-07、設計を書いた直後に独立したレビューを 1 回掛けた（グローバルルール「設計のレビューはコードを書く前に 1 回」）。「必ず直す」8 件はすべて本文に反映した:

1. SPA 型の静的エクスポートではデータ部品が HTML に無い（fixture-poly の `today-island.tsx` で確認）→ §3.3 にカバー率と 3 段の対処、D22・Q13 を改訂
2. `<script>` 除去だけでは `<noscript>` の GTM iframe や外部 URL が残る → 許可リスト方式のサニタイズ、CSP、strict での外部 URL 検査（D25）
3. 未割り当ての検出が層 id の比較では曖昧 → 割り当ての出どころ（provenance）で判定（§3.5）
4. `runtime` の規則が Pages Router で誤り、`shared` / 孤立の行き先が無い、今の matcher は glob 必須で `file` 無しノードを飛ばす → §3.5 の表と matcher の書き換え
5. §4 の計算が sceneScale = 1 前提で、gap 12 では 4 層でもカメラが 1.6 倍遠くなる。帯を中央に置くと gap 8 で画面に重なる → `sceneScaleFor` の分母を gap に、帯は画面上端基準、下限 10
6. 圧縮が `app.ts` の `readonly sceneScale` と `layerY(index)` と噛み合わない → rank 写像と `setSceneScale()`（§3.6）、非表示層の帯の規則（§3.2）
7. `.stack-atlas/graph/*.yaml` が今のマージでは黙って負ける → overrides と同じ段で yaml が勝つ（§3.5）
8. 原則 L4・L5 と参照スタック表の矛盾（Lambda(Next) 1 個の層、Aurora の位置、ブラウザ HTTP キャッシュの位置、B に endpoint が無い）→ L4 を「直上か同層」に緩め、表を改訂（§3.1）

「あれば良い」も反映した: Safari の汚染検査、Next 設定の読み取り範囲、schema の互換の主張の限定と `types.test.ts`、`boundary.nodes` 参照による二重化の回避、導入期は strict を警告に、テンプレートは fixture-poly から作る、`<form>` と Enter の扱い。

## 9. 実装結果

（Phase 8 の実装後に書く）
