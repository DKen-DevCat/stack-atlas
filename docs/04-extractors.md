# 04. 抽出器（extractor）

## 結論

最初の対象スタックは **CDKtf ＋ Next.js（App Router、Lambda 上）＋ TypeScript**。
抽出器は関心ごとに分け、それぞれが部分グラフを返す。最も不安定なのは **フロント → API の結線**なので、規約と補正ファイルで補う前提にする。

## インターフェース案

```ts
interface Extractor {
  name: string;                        // "cdktf" など
  detect(repo: RepoContext): Promise<boolean>;  // このリポジトリに適用できるか
  extract(repo: RepoContext, config: unknown): Promise<PartialGraph>;
}
type PartialGraph = { layers?: Layer[]; nodes: Partial<Node>[]; edges: Edge[] };
```

- 部分ノードは ID で統合する。同じ ID なら後から来たフィールドで上書きせずマージする（例: ts-imports が `code` を、cache 抽出器が `cache` を足す）
- `meta.extractor` に、どの抽出器が出したノードかを記録しておくと調査しやすい

## 1. cdktf — インフラ層

**入力**: `cdktf synth` の出力 `cdktf.out/stacks/<stack>/cdk.tf.json`

- `resource.<type>.<logicalId>` をノードにする（`kind: infra`）。対象は表示する価値のある型に絞る:
  `aws_cloudfront_distribution`、`aws_lambda_function`、`aws_apigatewayv2_api`、`aws_dynamodb_table`、`aws_s3_bucket`、`aws_cognito_user_pool` など
- 各リソースの `"//": { "metadata": { "path": ... } }` に construct path が入っている → ID と、ソースファイルを推定する材料にする
- 属性値の中の参照 `${aws_lambda_function.xxx.arn}` を正規表現で拾ってエッジにする
  - CloudFront の origin → Lambda や S3: `flow`
  - Lambda@Edge の関連付け: `flow`
  - API Gateway の integration → Lambda: `flow`
- ソースファイルの位置は cdk.tf.json に入っていない。construct ID で `infra/` 以下を grep して `file` を埋める（取れなくても可）
- 将来は Terraform（`terraform show -json`）、AWS CDK（`cdk.out/*.template.json`）、SAM 用を別の抽出器として足す

## 2. nextjs-app — 画面層

**入力**: `app/` ディレクトリ

- `page.tsx` → `route:<URLパターン>`、`layout.tsx` → `layout:<パス>`
- ルートグループ `(group)` は URL から除く。動的セグメント `[id]`、`[...slug]` はそのまま表示
- パラレルルート `@slot`、インターセプトルートは最初は対象外でよい
- route segment config（`export const revalidate` / `dynamic`）を読んで cache 抽出器に渡す
- Lambda との結線（`deploy` エッジ）: Next の standalone 成果物を zip にしている Lambda を cdktf 抽出器の結果から特定し、全ルートへ `deploy` を張る
  （判定方法: `filename` に `.next/standalone` を含む、などの規約。設定ファイルで明示できるようにする）
- Pages Router（`pages/`）にも将来対応

## 3. ts-imports — コンポーネント層・型層

**入力**: `tsconfig.json`（ts-morph の `Project` で読む）

- 各ソースファイルの import 宣言を解決し、**シンボル単位**で `uses` エッジを張る（ファイル単位だと粗すぎる）
- 分類の目安:
  - `.tsx` から export された PascalCase の関数で、JSX を返すもの → `comp:`
  - `use` で始まる関数 → `hook:`
  - `type` / `interface` / zod スキーマ → `type:`
  - それ以外 → `lib:`
- 型参照（`RaceResult[]` など）も `uses` に含める。ハイライトで「このコンポーネントが使う型」を出すため
- `node_modules` の中は対象外。ワークスペース内パッケージ（`packages/types`）はたどる
- 層の割り当て: ルート → 画面層、comp / hook / lib → コンポーネント層、type / handler / schema → 型・API 層。設定で変えられるようにする

## 4. api-link — フロント → API の結線（最難関）

連鎖: **api client の呼び出し** ⇔ **URL パス** ⇔ **API Gateway の route_key**（`GET /races/{id}`）⇔ **integration** ⇔ **Lambda** ⇔ **ハンドラのファイル**

- api client 側: `fetch` や `get("/races/" + id)` の第 1 引数を、文字列リテラルとテンプレートから抽出してパスパターンにする
- API Gateway 側: cdktf 抽出器の結果から `aws_apigatewayv2_route.route_key` と integration を取る
- Lambda → ハンドラ: `handler: "index.handler"` とバンドルのエントリポイントからファイルを特定する
- 取りこぼしは `stack-atlas.overrides.yaml` で補う:

```yaml
edges:
  - { from: lib:apiClient, to: handler:getRaces, kind: http }
deploy:
  infra:lambdaApi: [handler:getRaces, handler:postResult]
```

## 5. cache — キャッシュ情報

| 対象ノード | 情報源 | 判定の例 |
|---|---|---|
| CloudFront | `cdk.tf.json` の cache behavior（path pattern、cache policy、TTL） | `/admin/*` が CachingDisabled → off。キャッシュキーに Cookie が入っている → warn |
| Lambda（Next） | Next の設定（`incrementalCache` / `cacheHandler`） | ファイルシステムキャッシュのまま Lambda で動かしている → warn（インスタンス間で共有されない） |
| route | `revalidate` / `dynamic` / `generateStaticParams` | `revalidate` あり → ISR。`force-dynamic` → no-store |
| api client | `fetch` の `next.revalidate` / `tags` / `cache` | |
| hook | SWR / React Query のオプション | |
| API Gateway | API の種類 | HTTP API → キャッシュなし（off） |

二段キャッシュ（ISR ＋ CDN の s-maxage）の最悪鮮度など、複数ノードにまたがる判定は、マージ後に「ルールエンジン」として実行するのがよい。

**実装メモ（Phase 4）**

- CloudFront / HTTP API / Lambda@Edge は `extractors/cdktf`、route の `revalidate` / `dynamic` は `extractors/nextjs-app`、api client の fetch は `extractors/api-link` が作る。
- `extractors/cache` は残り（hook の SWR / React Query のオプション、`meta.deployApp: 'next'` の Lambda の next.config の `cacheHandler` / `isrMemoryCacheSize`、cache の無い route の `fetch` オプション）を、cache の無いノードにだけ足す。詳細は `extractors/cache/README.md`。
- core のルール（`packages/core/src/rules/`、`DEFAULT_RULES` の順に適用）: `lambda-fs-isr`（cache が無い Next の Lambda に ISR /tmp）→ `two-tier-staleness`（ISR + CDN の最悪鮮度）→ `cookie-cache-key`（CDN のキャッシュキーに Cookie → warn と note）→ `no-store-behind-cdn`（force-dynamic の route に当たる CDN behavior がキャッシュ有効 → warn と note）。

## 6. screenshots — 画面のスクショと領域

- **Playwright** で各 `route:` を開いてスクショを撮る
  - 動的ルートのサンプルパラメータは設定で与える: `routes: { "/races/[id]": ["42"] }`
  - 認証が必要なルートは、ログイン済みの storageState を使う
- 領域: 対象アプリのコンポーネントのルート要素に `data-component="ResultTable"` を付けてもらい、`getBoundingClientRect()` を集めて `regions` にする
  - 付けられない場合の代替: React DevTools の fiber を読む（開発ビルドのみ。不安定なので後回し）
- 出力: `shots/<route>.png` と `screen.regions`。デスクトップ幅（1280px など）で固定する

## 7. flows — データフロー

- 自動推定は難しいので、**人が `flows.yaml` に書く**のが現実的（未決事項 Q6）

```yaml
- id: miss
  name: 閲覧 MISS
  steps:
    - [actor:user, /races/42 をリクエスト]
    - [infra:cloudfront, MISS → オリジンへ]
    - [route:/races/[id], ISR 再生成]
```

- 将来案: X-Ray や OpenTelemetry のトレースからステップ列を作る

**実装メモ（Phase 4）**: `stack-atlas init-flows <repo> [--out <file>] [--force]` が、いまのグラフ（スクショなしの build）から
CloudFront → Lambda（Next）→ route の経路を探して `miss` / `hit`（tone: cache-hit）/ `invalidate` の雛形を書く。
ノード ID は実在するものだけを使う（MISS の API 部分は route から `uses` をたどった先の `http` エッジ → ハンドラを載せた Lambda → その手前の API Gateway → Lambda の参照するテーブル。hook はクライアントで動くので MISS ではたどらない）。
経路が無ければ 2 ステップの最小の雛形。既存の flows.yaml は `--force` が無ければ上書きしない。
