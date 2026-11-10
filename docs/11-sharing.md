# 11. 共有ガイド（メモ・差分・配信）

## 結論

- **メモの正は解析対象リポジトリの `.stack-atlas/memos.json`**（Git で共有）。`stack-atlas build` が `out/memos.json` にコピーし、ビューアは graph.json と同じディレクトリの `memos.json` を読む。
- ビューアでの編集はまず**このブラウザ（localStorage）に保存**され、パネルに「ローカル（未保存）」と出る。共有するには
  - 「**memos.json を書き出す**」でダウンロードして `.stack-atlas/memos.json` に置いてコミットする、または
  - `stack-atlas serve out --repo <repo>` で開いて「**サーバーに保存**」を押す（リポジトリのファイルに直接書き戻す）。
- graph に無いノード ID のメモ（リネームで ID が変わったなど）は、トップバーの「**孤立メモ (N)**」から今のノードへ移すか削除する。
- **差分表示**は `?prev=<前回の graph.json>` を付けて開く（または「開く ▾ → 前回と比較…」）。追加は緑、削除は灰色のゴースト、変更は黄色。
- **配信**は `stack-atlas build <repo> -o out --with-viewer` の `out/` をそのまま静的ホスティングに置くだけ。GitHub Actions → S3 + CloudFront のテンプレートが `docs/ci-example.yml`。
- 外部 SaaS は使わない。抽出はローカル／自前の CI、配信は静的ファイルか社内の `stack-atlas serve`。

## 全体像

```
解析対象リポジトリ
  ├─ ソースコード ───────────────┐
  └─ .stack-atlas/memos.json ──┐ │   （Git で共有するメモ）
                                │ ▼
                     stack-atlas build <repo> -o out --with-viewer
                                │
                                ▼
out/
  ├─ index.html, assets/   ← ビューア（--with-viewer）
  ├─ graph.json            ← 抽出結果
  ├─ memos.json            ← .stack-atlas/memos.json のコピー
  └─ shots/                ← スクショ（screenshots 抽出器）
        │
        ├─ S3 + CloudFront（docs/ci-example.yml）     … 読むだけ。メモは書き出し → PR で反映
        └─ stack-atlas serve out --repo <repo>（社内） … 「サーバーに保存」で memos.json に書き戻せる
```

ビューアの中でのメモ:

```
共有メモ（memos.json、serve なら GET /api/memos）   ← 土台
  └─ このブラウザでの編集（localStorage）           ← ノード ID ごとに上書き（「ローカル（未保存）」）
       ├─「memos.json を書き出す」→ ダウンロード（共有＋ローカルを合わせたもの）
       └─「サーバーに保存」→ POST /api/memos → 成功すると「共有」に戻る
```

## 手順

### 1. メモを共有する（Git）

1. ビューアでノードを選び、パネルの「メモ」に書く（「ローカル（未保存）」と出る）。
2. 「memos.json を書き出す」を押すと `memos.json`（キー昇順の JSON）がダウンロードされる。
3. 解析対象リポジトリの `.stack-atlas/memos.json` を置き換えてコミットし、PR でレビューする。
4. 次の `stack-atlas build` で `out/memos.json` に反映され、ほかの人のビューアにも「共有」として出る。

書き出す JSON は「共有メモ ＋ このブラウザでの編集」を合わせたもの。ほかの人の編集とぶつかったら、通常の Git のマージで解決する。

### 2. メモを共有する（serve で直接書き戻す）

```bash
stack-atlas build ../my-app -o out --with-viewer
stack-atlas serve out --repo ../my-app      # http://127.0.0.1:4173/
```

- ビューアは同じオリジンの `GET /api/memos` が JSON を返すと、パネルに「サーバーに保存」を出す。
- 押すと `POST /api/memos`（`Content-Type: application/json`、本文は `{ "ノードID": "メモ" }`）で
  `<repo>/.stack-atlas/memos.json` と `out/memos.json` に書き込む。成功するとパネルの印が「共有」に戻る。
- `--repo` なしで serve すると書き込みは 405 になり、「このサーバーは書き込みに対応していません（--repo なしで serve）」と出る（読むだけ）。
- 書き込んだファイルはふつうに `git diff` / コミットする。

### 3. 孤立メモを片付ける

- ノードのリネーム・削除で ID が変わると、そのメモは graph に無い ID のまま残る。トップバーに「孤立メモ (N)」が出る。
- 一覧の各行で「移す…」→ 今のノード ID を選ぶ（候補が出る）→「移す」。移し先に既にメモがあれば改行で続ける。
- 要らなければ「削除」。どちらもローカル未保存になるので、最後に書き出すかサーバーに保存する。
- `stack-atlas build` も孤立メモを警告として出す（CLI 側）。

### 4. 前回との差分を見る

```
index.html?graph=graph.json&prev=prev/graph.json
index.html?graph=https://atlas.example.com/atlas/graph.json&prev=https://atlas.example.com/atlas/prev/graph.json
```

- `prev` は `graph` と同じく**ページの URL 基準**で解決する（相対パス・絶対 URL どちらでもよい）。別オリジンなら CORS の許可が要る。
- URL を使わずに、「開く ▾ → 前回と比較…」で手元の graph.json を選んでもよい（今の graph はそのまま）。
- トップバーに「差分 +A −R ~C」（追加・削除・変更ノード数）が出る。押すと色分けを切り替える。ツールチップにエッジの増減も出る。
- CLI の `stack-atlas diff a.json b.json` も同じ規則で差分を出す。

`docs/ci-example.yml` は、配信のたびに今の graph.json を `prev/graph.json` に退避するので、上の 1 行目の URL で「前回のデプロイからの変化」が見える。

### 5. 配信する

**S3 + CloudFront**（`docs/ci-example.yml`）

1. テンプレートを解析対象リポジトリの `.github/workflows/stack-atlas.yml` にコピーし、`<...>` を置き換える。
2. AWS 側: S3 バケット（非公開）＋ CloudFront（OAC で S3 を読む）＋ GitHub OIDC で引き受ける IAM ロール
   （`s3:PutObject` / `s3:GetObject` / `s3:ListBucket` / `s3:DeleteObject` と `cloudfront:CreateInvalidation`）。
3. main への push ごとに `build --with-viewer` → S3 同期 → CloudFront 無効化。URL はジョブのサマリに出る。
4. 社内限定にするなら CloudFront に認証（Lambda@Edge・署名付き Cookie）か WAF の IP 制限を付ける。

**社内ホストで serve**

```bash
stack-atlas serve out --host 0.0.0.0 --port 4173 --repo /srv/my-app --allowed-host atlas.internal
```

- `/` は `index.html?graph=./graph.json` にリダイレクトされる。
- `--repo` を付けると「サーバーに保存」が使える。誰でも書き込めるので、社内ネットワーク内か、前段に認証を置く。
- ブラウザがアドレスバーに入れる名前（`atlas.internal` など）は `--allowed-host` で許可する。許可していない Host ヘッダは 403 になる（下記「セキュリティ」）。

## 詳細

### ビューアの読み込み順

1. `?graph=` の graph.json と `?prev=` の graph.json を並行して取得する。`prev` が読めなくても描画は続け、警告を一覧に出す。
2. graph.json と同じディレクトリの `memos.json` を取得する（404 は無視）。
3. graph.json がページと同じオリジンなら `GET /api/memos` も試す。JSON が返れば serve 中とみなし、その内容を共有メモの正にする（memos.json より優先）。返らなければ（静的ホスティング・404・HTML が返る）無視する。
4. ファイル選択・ドロップで開いた graph.json には共有メモは無い（ローカルのメモだけ）。

ブラウザは 404 の取得を開発者ツールのコンソールに「Failed to load resource」と出すが、`memos.json` と `/api/memos` は「あれば読む」ものなので問題ない。

### メモの状態

| パネルの印 | 意味 |
|---|---|
| 共有 | memos.json（または API）の内容のまま |
| ローカル（未保存） | このブラウザで書き換えた・消した。書き出すか保存するまで共有されない |
| （なし） | メモが無い |

- ローカルの編集は従来どおり `localStorage` の `stack-atlas-memos:<project.name>` に、共有メモをローカルで消したことは `stack-atlas-memos-deleted:<project.name>` に持つ。
- 共有と同じ文面に戻すと、ローカルの上書きは消える（印も「共有」に戻る）。
- 「サーバーに保存」に成功すると、保存した内容が新しい共有メモになり、ローカルの上書きはすべて消える。

### 差分の規則

`packages/core/src/diff.ts` と同じ（ビューアは `src/graph/diff.ts` に同じ規則を持つ）。

| 対象 | 判定 |
|---|---|
| 追加ノード | 今の graph にだけある ID。ラベルに緑の「追加」、箱に緑の輪郭（画面ノードはフレーム） |
| 削除ノード | 前回にだけある ID。今の graph の同じ層に灰色の半透明の箱（ゴースト）と「削除」ラベル。前回のレイアウト位置を基準に、今のノードと重ならないよう横にずらす。層ごと消えたノードは描かない |
| 変更ノード | 両方にあり、`file` `kind` `layer` `name` `cache.badge` のどれかが違う。黄色の「変更」。ツールチップとパネルに変わったフィールド（前 → 後） |
| 追加エッジ | from・to・kind の組が今の graph にだけある。通常どおり描く |
| 削除エッジ | 前回にだけある。灰色の破線（端がゴーストでもよい） |

表示の優先順位は「ハイライト ＞ フロー ＞ キャッシュ ＞ 差分 ＞ 通常」（`src/state.ts` の `computeVisuals`）。
ホバー・選択中やフロー再生中、キャッシュ表示中は差分の色を出さず、ゴーストと破線も薄くする。

### セキュリティ

- ソースコードは CI のランナー（またはローカル）の中だけで解析する。外部 SaaS に送らない。
- 配信物は静的ファイル（HTML・JS・graph.json・memos.json・PNG）だけ。graph.json にはコード抜粋（`code`）とファイルパスが入るので、**社内限定の場所に置く**。
- `serve --repo` の書き込みは `Content-Type: application/json` の POST だけを受け付ける（他サイトからの単純なフォーム送信で書き換えられないように）。認証は持たないので、公開ネットワークには出さない。
- `serve` は Host ヘッダがループバック（`localhost` / `127.0.0.1` / `::1`）・`--host`・`--allowed-host` のどれでもなければ 403 を返す。DNS リバインディング（攻撃者のドメインを 127.0.0.1 に解決し直し、そのページから同一オリジンとして graph.json を読んだりメモを書き換えたりする手口。Vite の CVE-2025-24010 と同型）への対策。
