# @stack-atlas/extractor-cache

先行の抽出器（cdktf / nextjs-app / ts-imports / api-link）が作ったノードに **`cache`** を足す抽出器。
すでに `cache` のあるノード（CloudFront・HTTP API・ISR の route・api client など）は触らず、`{ id, cache }` の部分ノードだけを出す。

## 対象

| ノード | 情報源 | cache |
|---|---|---|
| `hook:*`（`file` あり） | `useSWR` / `useSWRInfinite` / `useSWRImmutable` / `useQuery` / `useInfiniteQuery` などの呼び出しとオプション。`meta.ts.exportName` の関数の中だけを見る | `ok`、バッジ `SWR 2s`（dedupingInterval）/ `React Query stale 5m`（staleTime）。rules はオプション（ミリ秒は `2秒` などに）。`refreshInterval` / `refetchInterval` が無ければ `なし` |
| `infra:*`（`meta.deployApp: 'next'`） | next.config.{js,mjs,cjs,ts,mts} の `cacheHandler` / `experimental.incrementalCacheHandlerPath` / `cacheMaxMemorySize` / `isrMemoryCacheSize` / `output` | 無ければ `warn`「ISR /tmp」＋ core の `LAMBDA_FS_ISR_NOTE`、あれば `ok`「ISR custom handler」 |
| `route:*` / `layout:*`（`file` あり） | `fetch(url, { cache, next: { revalidate, tags } })` | `no-store` / `revalidate: 0` があれば `off`、それ以外は `info`（`fetch 300s`） |

データ取得ライブラリを呼ばない hook には何も付けない。

## next.config の場所

`config.next.appDir` の親（`src/app` ならさらに親）→ route / layout の `file` の `app/` の親 → リポジトリ直下、の順に探す。
見つからなければ何も出さない（core のルール `lambda-fs-isr` が既定の warn を付ける）。

## detect

`detect` には upstream が渡らないので、config に `next` / `ts` / `deploy` があるか、直下に next.config があるか、
直下の package.json が swr / react-query / next に依存していれば true。upstream に対象ノードが無ければ空の結果を返す。

## 制限

- 構文だけを見る（型解決はしない）。オプションを変数に入れて渡す・独自ラッパー経由の呼び出しは読まない。
- 1 つの hook で複数回呼んでいれば最初の呼び出しを表示し、note に回数を書く。
- route の cache は nextjs-app（`revalidate` / `dynamic`）が優先。fetch の分は cache の無い route にだけ付ける。
