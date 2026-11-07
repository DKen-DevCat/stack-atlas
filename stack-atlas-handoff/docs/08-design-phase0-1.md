# 08. 設計とタスクの洗い出し（Phase 0 → Phase 1）

作成: 2026-11-07（Git 連携セッション 1 回目）。引き継ぎ資料を読み、プロトタイプのコード 1073 行を確認したうえで書いた。

## 1. 結論

- **今やること**: Phase 0（リポジトリの雛形）と Phase 1（ビューアの汎用化）。抽出器（Phase 2）はまだ作らない。
- **設計の骨子**: pnpm モノレポ。`packages/schema`（型・検証）と `packages/viewer`（Vite + TypeScript + three.js）の 2 パッケージから始める。
  プロトタイプの 1 ファイルを「**純粋ロジック**（graph モデル・ハイライト・自動レイアウト）」と「**描画**（three.js）」と「**UI**（DOM）」に分け、純粋ロジックにユニットテストを付ける。
- **決めてほしいこと**は 5 つ（§6）。すべてに推奨案を付けた。異論がなければ推奨案で進める。
- Phase 1 の完了条件は引き継ぎどおり: **`examples/race-site.graph.json` を読み込むとプロトタイプと同等に見えて同じ操作ができ、`position` を全部消しても破綻しない**。

## 2. 全体像（どこを作るのか）

```
 解析対象リポジトリ ──▶ ① 抽出器 ──▶ ② graph.json ──▶ ③ ビューア ──▶ 画面
                        (Phase 2〜)    (スキーマ済)     (Phase 1 ★)
```

- ② は引き継ぎ時点でスキーマとサンプルがあり、検証も通っている。**契約は固まっている**ので、①と③は独立に作れる。
- ③ を先にやる理由: 動くものが既にあり（プロトタイプ）、移植と分離が中心で見通しがよい。実物を見せて方向を確認しやすい。
- ① は対象リポジトリ（未決事項 Q2）が分からないと手戻りが大きい。Phase 1 の途中で Q2 を確認し、Phase 2 の前に構成を見る。

## 3. 構造（設計）

### 3.1 リポジトリ構成

現状は `project-map/` の直下に `HANDOFF.md` と `stack-atlas-handoff/` があり、資料は後者の中にある。**ツール本体のコードはこのリポジトリに置く**前提で、次の形にする。

```
project-map/                      GitHub: DKen-DevCat/project-map
  package.json                    pnpm workspace のルート（scripts: build / test / lint / typecheck / validate）
  pnpm-workspace.yaml
  tsconfig.base.json
  .github/workflows/ci.yml        lint・typecheck・test・サンプル検証
  packages/
    schema/                       graph.json の TypeScript 型、JSON Schema、validate()（ajv）、参照整合性チェック
    viewer/                       Vite + TypeScript + three.js。静的ビルド
  docs/                           ← stack-atlas-handoff/docs を移動
  examples/                       ← 同上
  prototype/                      ← 同上（参照用。削除しない）
  scripts/                        ← 同上（validate-graph.mjs は packages/schema の CLI に置き換え、互換のため残す）
  CLAUDE.md  HANDOFF.md  README.md ← 同上。ルートの HANDOFF.md は中身が同一なので 1 つにする
```

- `stack-atlas-handoff/` を**ルートに展開する**（決定事項 D2）。理由: Claude Code は作業ディレクトリ直下の `CLAUDE.md` を読むため、資料はルートにある方が機能する。「handoff」という名前も恒久的なものではない。
- `packages/core`・`packages/cli`・`extractors/*` は Phase 2 で追加する。Phase 1 では空ディレクトリも作らない（空の雛形は腐る）。
- `schema/graph.schema.json` は `packages/schema/graph.schema.json` へ移す。CLAUDE.md の検証コマンドは `pnpm validate examples/race-site.graph.json` に書き換える。

### 3.2 packages/schema

| 成果物 | 内容 |
|---|---|
| `graph.schema.json` | 現行 v1 をそのまま移動 |
| `src/types.ts` | `Graph` `Layer` `Node` `Edge` `Flow` `Cache` `Screen` `Region` の TypeScript 型。**手書き**（json-schema-to-typescript は `anyOf` の kind が `string` に潰れて旨みがないため） |
| `src/validate.ts` | `validateGraph(json): { ok, errors }`。ajv でスキーマ検証 + 参照整合性（layer・edge の両端・region.ref・flow step・ID の重複） |
| `src/cli.ts` | `stack-atlas-validate <file>`。CI と `scripts/validate-graph.mjs` の後継 |
| テスト | サンプルが通る／壊したサンプル（未知 layer、存在しない ref、重複 ID）が落ちる |

ビューアはこのパッケージを import して、読み込み時に検証する。エラーは画面に一覧表示し、**参照エラーがあっても描画は続ける**（前方互換の方針どおり）。

### 3.3 packages/viewer — モジュール分割

プロトタイプの各ブロックを次のように割る。左が純粋ロジック（DOM・three.js に依存しない。Vitest でテスト）、右が副作用のある層。

```
src/
  graph/
    load.ts        入力: ?graph=URL、ドラッグ＆ドロップ、<input type=file>。検証して GraphModel へ
    model.ts       GraphModel: byId、out/inn の隣接リスト、layerIndex、isScreen、kind のメタ解決
    closure.ts     ハイライト規則 down(a) / up(a)、エッジの赤・橙判定        ★テスト
    kinds.ts       kind → 形・色・日本語名のレジストリ。未知 kind は汎用ボックス
  layout/
    auto.ts        自動レイアウト（§3.4）。position があれば固定              ★テスト
    plate.ts       層の板のサイズと層ごとの Y 座標（層数 N に依存）
  scene/
    renderer.ts    WebGLRenderer / CSS2DRenderer / camera / OrbitControls / resize / loop
    plates.ts      層の板・外枠・層ラベル
    nodes.ts       ボックスノード、画面ノード（pivot + frame + plane + CanvasTexture）、キャッシュの輪
    edges.ts       線のジオメトリ更新（層またぎは上の層の色、層内は弧）
    flow.ts        CatmullRom 曲線、粒子 7 個、進行ステップの算出
    camera.ts      focusOn / reset のイーズアウト
    picking.ts     レイキャスト。画面ノードは UV → regions
  screen/
    texture.ts     スクショ画像の遅延読み込み、プレースホルダ描画、region のハイライト重ね描き
  ui/
    topbar.ts      展開／重ねる、フロー切替（graph.flows から動的生成）、キャッシュ、視点リセット
    layerChips.ts  層チップ（graph.layers から動的生成）
    legend.ts
    panel.ts       詳細パネル（種類・名前・ファイル・スクショ欄・キャッシュ表・コード・関連チップ・メモ）
    flowPill.ts
    memos.ts       localStorage（Phase 1）。保存先は差し替え可能なインターフェースにしておく（Phase 5 で memos.json へ）
  state.ts         hoverId / selectedId / flowId / cacheOn / explode / layerVisible と applyState()
  main.ts
```

プロトタイプとの対応: `data` → `graph/*`、`three setup` → `scene/renderer.ts` + `plates.ts` + `nodes.ts` + `edges.ts`、`layout` → `layout/*` + `scene/edges.ts`、`highlight` → `graph/closure.ts` + `state.ts`、`fake screens` → `screen/texture.ts`（ダミー描画は捨て、プレースホルダに置き換え）、`panel` → `ui/panel.ts`、`data flow` → `scene/flow.ts`、`picking` → `scene/picking.ts`。

プロトタイプから**変える**点（引き継ぎ §5 の 5 項目に対応）:

| # | プロトタイプ | 新実装 |
|---|---|---|
| 1 | `NODES` 等が直書き | graph.json を読む |
| 2 | 座標は手置き | `position` 省略時は自動レイアウト |
| 3 | `isScreen = n.L === 1` | `screen` フィールドがあるノードを画面として描く。`screen` がなくても kind が `page` / `layout` なら、プレースホルダ付きの画面として扱う（D4） |
| 4 | ページ ID ごとの Canvas 描画関数 | `screen.screenshot` を読む。なければプレースホルダ（ルート名＋regions の枠と ref 名） |
| 5 | 短い独自 ID | graph.json の ID をそのまま使う（表示は `name`） |
| 6 | `LAYERS[i].y` が定数、板が 41×20 固定、`layerVisible` が 4 要素固定 | 層数 N から Y を計算（間隔 7.5、中央寄せ）。板の幅はノード数に応じて広げる。配列は N 要素 |
| 7 | フロー 3 種がボタンに直書き | `graph.flows` からボタンを生成。`tone: cache-hit` は黄 |
| 8 | three.js を jsDelivr から、フォントを Google Fonts から読む | three.js は npm で同梱。フォントはシステムフォント優先にして外部依存を無くす（社内配信で外に出ない前提に合わせる） |
| 9 | パネルのキャッシュ表が `rows` | スキーマの `rules[]` を使う |

### 3.4 自動レイアウト（Phase 1 の新規設計）

入力: GraphModel。出力: `Map<nodeId, {x, z}>`。**決定的**（乱数を使わない）にする。生成のたびに配置が変わるとメモや差分表示で困るため。

1. **固定ノード**: `position` があるノードはそのまま。
2. **最上段**: 上に親がないので、連結成分ごとにまとめて x 方向に並べる。成分内は BFS 順。
3. **下の層へ順に**: ノード x = つながっている上の層のノード群の x の平均（重心ヒューリスティック）。親がないノードは末尾に置く。
4. **層内の重なり解消**: x でソートし、隣との最小間隔（kind の footprint から計算。画面ノードは幅 6.4、奥行きは傾き込みで約 4）を保つように 1 次元で押し広げる。列が板の幅を超えたら z 方向に段を増やす（画面ノードは 1 段 1 列が見やすい）。
5. **仕上げ**: 固定ノードと衝突する自由ノードだけ、反発を数十回かけてずらす。
6. 板の幅 = max(41, 必要幅 + 余白)。

受け入れ条件（テストで固定する）:
- 同じ入力なら同じ出力
- 層内でノードの footprint が重ならない
- 全ノードが板の中に収まる
- 子の x が親群の重心から一定以内（親が 1 つなら真下）
- `examples/race-site.graph.json` から `position` を全部消したものを目視で評価し、プロトタイプの手置きと「Lambda の真下に Next の画面群」が同程度に出ていること

### 3.5 ハイライト・フロー・キャッシュ・パネル

`docs/05-viewer-spec.md` どおり。設計上の注意だけ:

- `closure()` は GraphModel だけを引数にとる純関数にする。「型 `Race` を指すと全画面と Lambda まで光る」挙動をテストで固定する。
- エッジの赤・橙の判定（`dHit` / `uHit`）も `closure.ts` に出し、テストする。
- 優先順位（ハイライト ＞ フロー ＞ キャッシュ ＞ 通常）は `state.ts` の `applyState()` 1 か所で決める。
- 画面テクスチャの再描画は「ハイライト対象の集合が変わったとき」だけ行う（毎フレームではない）。

### 3.6 テスト・CI

| 種類 | 対象 | ツール |
|---|---|---|
| ユニット | closure、layout、model、validate | Vitest |
| スキーマ | `examples/*.graph.json` が通る | packages/schema の CLI |
| スモーク | ビューアを Vite で起動し、サンプルを読み込んで描画エラーがないこと。スクショ 1 枚を成果物として保存 | Playwright（環境に同梱済み） |
| 静的 | ESLint（typescript-eslint）、`tsc --noEmit` | |

CI は GitHub Actions。Node 22、pnpm は `packageManager` フィールドで固定（corepack）。

## 4. 詳細（タスク一覧）

### Phase 0 — リポジトリの準備

| # | タスク | 完了の目安 |
|---|---|---|
| 0-1 | `stack-atlas-handoff/` をルートへ展開。重複する `HANDOFF.md` を 1 つにする。CLAUDE.md・README のパスを直す | `git mv` のみで履歴が追える |
| 0-2 | pnpm workspace の雛形（root package.json、pnpm-workspace.yaml、tsconfig.base.json、ESLint、Prettier、.gitignore、.editorconfig、`.nvmrc` 22） | `pnpm install` が通る |
| 0-3 | `packages/schema`: スキーマ移動、型、validate()、CLI、テスト | `pnpm validate examples/race-site.graph.json` が通る。壊したサンプルが落ちる |
| 0-4 | `scripts/validate-graph.mjs` を新 CLI への薄いラッパに差し替え | 既存コマンドも動く |
| 0-5 | CI（lint・typecheck・test・validate） | main と PR で緑 |
| 0-6 | `packages/viewer` の空の Vite アプリ（タイトルだけ） | `pnpm --filter viewer dev` で開ける |

### Phase 1 — ビューアの汎用化（この順で、常に動く状態を保つ）

| # | タスク | 依存 | 完了の目安 |
|---|---|---|---|
| 1-1 | `graph/load.ts` + `model.ts` + `kinds.ts`。`?graph=` でサンプルを読み、ノード数をコンソールに出す | 0-3 | 検証エラーが画面に出る |
| 1-2 | `scene/renderer.ts` + `plates.ts`。層 N 枚の板と層ラベル | 1-1 | 2〜6 層の graph で崩れない |
| 1-3 | `scene/nodes.ts`（ボックスのみ）+ `layout/plate.ts`。`position` 固定で配置 | 1-2 | サンプルのボックスがプロトタイプと同じ位置に出る |
| 1-4 | `scene/edges.ts`（層またぎ＝上の層の色、層内＝弧）+ 展開／重ねるのアニメーション | 1-3 | |
| 1-5 | `graph/closure.ts` + テスト + `state.ts` の applyState（ボックスだけ） | 1-1 | 型を指すと画面と Lambda まで光る |
| 1-6 | `scene/picking.ts` + ラベルのホバー／クリック + `ui/layerChips.ts` | 1-5 | |
| 1-7 | 画面ノード: `screen/texture.ts`（プレースホルダ）+ `scene/nodes.ts` の pivot/frame/plane + 傾き + 線の端点（上端／下端） | 1-4 | サンプルの 6 画面が regions の枠付きで出る |
| 1-8 | 画面上の regions のピック（UV → region）と regions のハイライト重ね描き | 1-6, 1-7 | 画面内の ResultTable を指すと他画面の同じ部品が光る |
| 1-9 | `screen.screenshot` の遅延読み込み（画像があれば差し替え） | 1-7 | 手で PNG を置いて確認 |
| 1-10 | `ui/panel.ts`（種類・名前・ファイル・コード・キャッシュ表・関連チップ・メモ）+ `ui/memos.ts`（localStorage）+ `scene/camera.ts` | 1-6 | |
| 1-11 | `scene/flow.ts` + `ui/flowPill.ts` + `ui/topbar.ts` のフロー切替（flows から生成） | 1-4 | 3 フローがプロトタイプと同じ動き |
| 1-12 | キャッシュモード（輪・バッジ・薄表示） | 1-10 | |
| 1-13 | `layout/auto.ts` + テスト。`position` を消したサンプルで目視評価 | 1-3 | §3.4 の受け入れ条件 |
| 1-14 | ドラッグ＆ドロップ／ファイル選択の入力、スマホ幅のレイアウト（`05-viewer-spec.md`） | 1-1 | iPhone 幅でパネルが下から出る |
| 1-15 | Playwright のスモークテスト、`docs/images` 相当のスクショを撮って比較 | 全部 | |
| 1-16 | README・CLAUDE.md の更新（起動方法、Phase 1 完了の記録） | 全部 | |

1-13 はプロトタイプ再現（1-1〜1-12）と独立なので、途中で並行して進めてよい。

### Phase 1 の途中で確認すること

- 1-8 が動いた時点で一度実物を見せ、**ハイライト色（Q3）**と見た目の方向を確認する。
- 1-12 まで終わったら **対象リポジトリ（Q2）**の構成を聞き、Phase 2 の抽出器の設計に入る。

## 5. 設計上の決定（この文書で決めたこと）

| # | 決定 | 理由 |
|---|---|---|
| D1 | pnpm モノレポ（workspaces）。Node 22 | 環境に pnpm 10 があり、schema / viewer / core / cli / extractors と分かれていく前提に合う |
| D2 | `stack-atlas-handoff/` をルートに展開する | CLAUDE.md がルートで読まれる。恒久的な名前ではない |
| D3 | 画面ノードの判定は `screen` フィールド。kind が `page` / `layout` で `screen` がない場合も画面扱い（プレースホルダ） | 抽出器がスクショを作れなくても画面層が「画面らしく」見える |
| D4 | three.js は npm 同梱、フォントはシステムフォント優先 | 社内配信で外部に出ない。オフラインでも動く |
| D5 | 自動レイアウトは決定的 | メモ・差分表示の安定のため |
| D6 | 型は手書き、JSON Schema が正。両者のずれはテストで検出 | 生成ツールの出力が使いにくい |
| D7 | 検証エラーがあっても描画は続ける（エラー一覧を表示） | 前方互換の方針 |
| D8 | メモは Phase 1 では localStorage。保存先はインターフェース越しに差し替え可能にする | Phase 5 で memos.json へ |

## 6. ユーザーに決めてほしいこと（推奨案付き）

| # | 論点 | 推奨 | 補足 |
|---|---|---|---|
| Q1 | リポジトリ構成とパッケージマネージャ | **pnpm モノレポ（D1）** | 単一パッケージでも始められるが、Phase 2 で分けることになる |
| Q1' | `stack-atlas-handoff/` をルートに展開してよいか | **展開する（D2）** | 履歴は `git mv` で追える |
| Q3 | ハイライト色 | **赤（依存先）＋橙（影響範囲）の 2 色を維持** | 「この部品を使う画面」と「この部品が使う型」を区別できるのは、変更の影響範囲を見るときに効く。全部赤にしたければ 1 定数の変更で済む |
| Q8 | プロダクト名 | **当面「Stack Atlas」のまま** | パッケージ名に入るので、変えるなら Phase 0 の前がよい |
| Q9（新） | ビューアの配信形態の仮置き | **静的ビルド（`dist/` を置くだけで動く）** | Q5（S3＋CloudFront か CLI の serve か）はまだ決めなくてよいが、静的ビルドならどちらにも対応できる |

Q2（最初に解析する実リポジトリ）は Phase 1 の途中で聞く。

## 7. リスクと注意点

- **CSS2D ラベルの DOM 数**: ノード数百で重くなる見込み。Phase 1 ではサンプル規模（32 ノード）なので対処しないが、ラベルの生成を 1 か所に閉じ込めておき、後で LOD や間引きを入れられるようにする。
- **自動レイアウトの見た目**: 手置きと同じ美しさにはならない。「破綻しない」を完了条件にし、細かい見た目は `position` で手直しできる逃げ道を残す。
- **スクショ画像の重さ**: 1280px の PNG が数十枚になるとテクスチャメモリを食う。Phase 1 では遅延読み込みのみ、縮小は Phase 3 で。
- **WebGL のない環境**: 社内 PC で WebGL が無効な場合がある。起動時に検出してメッセージを出す。
