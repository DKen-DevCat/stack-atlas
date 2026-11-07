# @stack-atlas/extractor-ts-imports

ts-morph で TypeScript を読み、**コンポーネント層・型層**のノード（`comp:` / `hook:` / `lib:` / `type:` / `handler:` / `schema:`）と、シンボル単位の `uses` エッジを作る抽出器。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `ts.tsconfig` | `tsconfig.json` | 読む tsconfig の配列（tsconfig ごとに ts-morph の `Project`）。`next.tsconfig` も足す |
| `next.appDir` | nextjs-app と同じ探索 | page / layout をノードにせず、その import を `route:` / `layout:` からの `uses` にする |
| `deploy.*.handlers` | | この glob に合うファイルの関数 export は `handler:` |

リポジトリ外・`node_modules`・`.d.ts` は対象外。解決できない import（react / next / swr / zod など）は debug ログを出して無視。

## 分類（export された宣言を上から順に判定）

1. `handlers/` ディレクトリ（か `deploy.*.handlers`）の関数 → `handler:<export 名>`
2. `type` / `interface`: `db/` ディレクトリにある、または名前が `Item` で終わる → `schema:`、それ以外 → `type:`
3. `z.` で始まる呼び出しで初期化した const（zod）→ `type:`（`symbolKind: 'zod'`。同名の `type X = z.infer<…>` と 1 ノードにまとめる）
4. `use` + 大文字で始まる関数 → `hook:`
5. `.tsx` / `.jsx` の PascalCase の関数（`memo(() => …)` も可）で、本体に JSX がある → `comp:`
6. それ以外 → `lib:<ファイル名の camelCase>`（ファイル単位で 1 ノード。`index.ts` は親ディレクトリ名、`src` / `lib` などは飛ばす）

同じ ID が複数ファイルに出たら `comp:<path>#<Name>`（lib は `lib:<path>`）にする。`meta.ts: { exportName, symbolKind }`。

## uses エッジ

- import の指定子を ts-morph で解決し、`export *` / `export { X } from` の再エクスポートは宣言元までたどる（`@race/types` → `packages/types/src/race.ts` の `Race`）。
- ノードごとに、宣言の中で使われている識別子（同じファイルの非 export のヘルパーは推移的に）を見て、import した名前を使っていればエッジにする。同じファイルの別 export を使っている場合もエッジ。
- route / layout ファイルはファイル単位（import すべて）。

## 制限

- 識別子は名前で照合する（シャドーイングは考慮しない）。動的 `import()`・`require` は見ない。
- Lambda のエントリファイル（例: `apps/api/src/index.ts` の `handler`）も `lib:` になる。不要なら overrides の `remove` で消す。
