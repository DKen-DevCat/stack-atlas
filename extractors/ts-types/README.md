# @stack-atlas/extractor-ts-types

TS / TSX の**言語アダプタ**（Phase 8-2a。設計は `docs/17-design-adapters.md` §3.2・§7）。ts-morph が内蔵する TypeScript の型 API で、
関数の単位の箱（画面・部品・hook・関数）と口・項目・links、同じ言語の中の線を `PartialGraph.v2` に出す。v1 の nodes / edges は出さない（ts-imports が出す）。
依存は足さない（`import { ts } from 'ts-morph'`）。ts-imports の後に走り、その分類・ID・ts-morph の `Project` を共有する（`analyzeTsRepo`）。

## 箱と id

| 箱 | 判定 | id |
|---|---|---|
| 画面 | Next の page / layout の default export（nextjs-app の `listNextFiles`） | `route:/` / `layout:/`（kind screen） |
| 部品 | ts-imports の comp（.tsx の大文字の関数で JSX がある。構文で判定） | `comp:<名前>` |
| hook | ts-imports の hook | `hook:<名前>` |
| 関数 | それ以外の export された関数・アロー関数 | `fn:<名前>`（衝突は `fn:<file>~<名前>`） |
| オブジェクトのメソッド（8-2b） | export した const のオブジェクトリテラルで、プロパティが全部関数（メソッド・アロー関数・関数式）のものの各プロパティ（`export const api = { getRaces: () => … }`） | `fn:<オブジェクト>.<メソッド>`（`fn:api.getRaces`。衝突は `fn:<file>~<オブジェクト>.<メソッド>`） |

ファイルの export がその関数 1 つで、名前がファイルの lib 名と同じもの（`lib/fetcher/index.ts` の `fetcher`）は v1 の id（`lib:fetcher`、kind helper）のまま。
TS のハンドラは `handler:<名前>` のまま。関数の箱が v1 のファイルの箱（`lib:<file>`）の export を全部置き換えるときは `groups`（関数の箱 → v1 の箱）で知らせ、
パイプラインの mergeV2 がその v1 の箱を group にする。

オブジェクトのメソッドの箱は、呼び出し側の書き方（`api.getRaces(…)`）と同じ名前にする（サーバーの `handler:getRaces` と紛れない）。`meta.ts.exportName` は
オブジェクトの名前（`api`。その export を全部のメソッドの箱が置き換えるので、v1 の箱 `lib:apiClient` が group になる）。関数でないプロパティ（定数・スプレッド・
省略記法）が 1 つでもあるオブジェクトは箱にしない（v1 の箱のまま）。`api.getRaces` を呼ぶ・値として渡す参照は、オブジェクトの v1 の箱ではなくメソッドの箱へ向ける。

## 口・項目・links・線

- in: 引数（分割代入・props はフィールド）。引数の無い関数は `call`、props の無い部品は `props`、画面は `html`。呼び出しの戻りは `ret_<n>`
- out: 呼び出しは `call_<n>`（子は呼び先の引数名）、部品の描画は `render_<n>`（子は props）、関数・hook の戻り値は `return`
- 型: `wireType` は対応表（number / string / boolean / Date → datetime / 配列 / オブジェクト / ほか unknown）、`typeRef` は repo の中の名前付きの型、
  `optional`（`?`・既定値・`| undefined`）・`nullable`（`| null`）。子は既定 2 段・1 箱 200 項目まで（`adapters.depth` / `adapters.maxItems`）
- 線: `call_n.<引数> → 呼び先#in/<引数>`（call）、`呼び先#out/return → ret_n`（return、reply）、`render_n.<prop> → 子#in/<prop>`（render）。最も粗い単位（D41）。
  呼び出しでも描画でもない参照（定数・コールバック渡し）は箱の単位（`out/_ → in/_`）
- links: 引数・呼び出しの戻りを参照する式は exact、ローカル変数・useState 経由は crude。データ由来の link が無い `call_n` / `render_n` / `return` には起動の項目から crude
- HTTP の呼び出し（fetch・api-link のラッパー検出・`api.callers`）: `call_n` の `meta.http = { method, path }`、子の `meta.http`（`path` / `query` / `body`）。
  endpoint への線は合流の段（core の `join.ts`）が引く

## runtime

`'use client'` の閉包は browser、server component の閉包は server（`output: 'export'` なら build）、route.ts とハンドラの閉包は server。画面は browser（D54）。
2 つ以上の runtime から使われる箱は `<id>@<runtime>` に複製する（`meta.sharedOf`）。react の型が解けないときだけ最小の stub を足す（`react-stub.ts`）。
tsconfig の `extends` が解けないときは警告する。
