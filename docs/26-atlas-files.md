# 26. `.stack-atlas/` に書く図の形（契約 v0）

作成: 2026-11-12。**状態: v0。10-1 の試し（エージェントに書かせて正解表と比べる）のあとで固める。** 設計は docs/25 §3.1・§3.2・§3.4、要件は docs/24。決定の番号は docs/25 の続き（D210 から）。

利用者の手元のエージェントが、コードを読んで、この形で図を書く。道具（Stack Atlas）は、書かれたものを確かめるだけで、対象のコードの意味は読まない。

## 1. ファイル

| ファイル | 持ち主 | 中身 | いま |
|---|---|---|---|
| `graph/*.yaml` | エージェント | 箱・口・項目・線 | 10-1a で読む |
| `parts.yaml` | エージェント | 画面の部品（セレクタ → 箱） | 10-1a で読む |
| `behaviors.yaml` | エージェント | 挙動（始まりと、通る線の列） | 10-1a で読む |
| `reading.yaml` | エージェント | 読んだが箱にしなかった所・読まなかった所の申告 | まだ読まない（10-1b） |
| `atlas.yaml` | 人 | repo の名前と場所、画面の URL と状態 | まだ読まない（10-1b・10-2） |
| `state/` | 道具 | 根拠の指紋 | まだ無い（10-1b） |

置き場は、対象が 1 つの repo ならその中、複数の repo なら、それらを束ねるディレクトリ（docs/25 Q37）。

## 2. `graph/*.yaml` — 箱と線

```yaml
nodes:
  - id: "part:comment-form"        # 箱 id。`#` は使えない
    kind: component
    name: "コメント欄 ＋ Post Comment"
    runtime: browser
    file: app/index.html            # 根拠: どのファイルの
    line: 33                        #       何行めか
    ports:
      - id: out
        dir: out
        items:
          - id: comment
            name: comment
            type: object
            children:
              - { id: body, name: body, type: string }
wires:
  - { from: "part:comment-form#out/comment", to: "endpoint:POST /api/comments#in/body.comment", via: http }
  - { from: "endpoint:POST /api/comments#out/body.comment", to: "part:comment-form#in/created", via: http, reply: true }
```

- 箱・口・項目・線・型の形と語彙は、graph.json の契約（docs/16）と同じ。項目の参照は `<箱 id>#<口>/<項目>(.<子>)*`
- 意味のまとまりごとに、ファイルを分けてよい（64 ファイルまで）。同じ箱 id を 2 度書くと誤り
- `*.v2.yaml` は、古い読みこみ（抽出器の隙間を補う道。docs/19）のファイルなので、こちらの道では読まない（D212）
- 線の根拠（呼んでいる所のファイルと行）は、10-1b で足す（docs/25 D201）

## 3. `parts.yaml` — 画面の部品

```yaml
parts:
  - id: comment-form                # 部品の id（挙動から指す）
    name: "コメント欄 ＋ Post Comment"
    box: "part:comment-form"        # この部品を表す箱
    screen: "screen:/"              # この部品が出る画面の箱（kind: screen）
    selector: "#comment-form"       # 画面の中で、この部品に当たる要素
```

対象のコードに、道具のための印は足さない。セレクタは、コードを読めば書ける。

## 4. `behaviors.yaml` — 挙動

```yaml
behaviors:
  - id: post-comment
    name: "コメントを投稿する"
    screen: "screen:/"
    trigger: { action: submit, part: comment-form }   # action: open | click | submit | input | change
    steps:
      - send: [{ from: "part:comment-form#out/comment", to: "endpoint:POST /api/comments#in/body.comment" }]
        back: [{ from: "endpoint:POST /api/comments#out/body.comment", to: "part:comment-form#in/created" }]
      - send: [{ from: "endpoint:POST /api/comments#req/row", to: "table:comments#write/row" }]
        back: [{ from: "table:comments#read/row", to: "endpoint:POST /api/comments#res/row" }]
      - send: [{ from: "part:comment-form#out/reload", to: "fn:load#in/call" }]
        say: "投稿のあと、一覧を読み直す"       # 任意の補足
    result: { say: "一覧を読み直し、コメントが 1 つ増える。", part: comment-list }
    when: { "screen:/#logged_in": true }               # 任意。キーは "<箱 id>#<分岐 id>"
```

- **挙動は線を作らない。** `graph/` にある線の上に、名前と順番を載せるだけ。線は両端の組（`from`・`to`）で名指しする
- **1 段は、送る線の列と、返る線の列。** 送る線は、1 つの箱から 1 つの箱へ。返る線は、その逆向き。1 回の呼び出しが、引数ごとに線に分かれることがあるので、どちらも列にする
- **`action: open`** は、画面を開いたときの挙動。`part` は書かない。最初の段は、画面の箱から出る
- **同時に呼ぶ所**は、段の代わりに `{ parallel: [[段, …], [段, …]] }` と書く。どの列も、分かれる前の経路から始まる
- **始まりの部品は、別の画面の部品でもよい**（その画面に、押す所が無い挙動）

### 段のつながり（D210）

次の段は、**ここまでの経路の上の、どれかの箱から出る**。

- いちばん先の箱から出る: さらに奥を呼ぶ（例: 受け口 → データの置き場）
- 手前の箱から出る: 戻ってから、次を呼ぶ（例: 投稿のあと、同じ部品から一覧を読み直す）

経路は、始まりの箱（部品の箱。`open` なら画面の箱）から始まる。段が進むと、出る箱より先を捨てて、着く箱を足す。

設計レビューの案（docs/25 §11 高-2）は「段 n の着く箱が、段 n+1 の出る箱」だった。それだけだと、「戻ってから次を呼ぶ」が書けない。正解の図（投稿のあとの読み直し）を書いて、足りないとわかった。

## 5. check が見ること

```sh
stack-atlas check [<dir>] [--json]     # <dir>/.stack-atlas/ を検査する。エラーがあれば終了コード 1
```

| 検査 | 見ること |
|---|---|
| 形 | YAML として読めるか。ファイルと要素の形。箱・線・型の中身（graph.json の契約のスキーマ） |
| 参照 | 箱・口・項目・線が解けるか（graph.json の検証器と同じ規則）。部品の箱があるか、部品と挙動の `screen` が画面の箱か。id の重複 |
| 挙動 | 段の線がすべて図にあるか／`send` に戻りの線が無いか／`back` が `send` の逆向きか／段がつながっているか／最初の段が始まりから出ているか／`when` のキーは、箱が宣言した分岐か／始まりと `result` の部品があるか |

どれも、契約と、図の中の参照だけを見る。対象のコードは読まない。

**まだ見ないこと**（10-1b 以降）: 根拠（ファイルと行が実在し、そこに書いてあるか）、未読、古さ、部品が画面の中で見つかるか。**check が通ることは、図が正しいことではない。** 図が正しいかは、正解表と比べて確かめる（docs/25 §5）。

## 6. 上限と、読みの守り

- 読むのは、決まった名前のファイルだけ。シンボリックリンクは辿らない。1 ファイル 1MB まで。YAML の別名の展開は 100 まで（今の補いのファイルと同じ守り。`packages/core/src/local-files.ts`）
- 箱 2000・線 5000・部品 2000・挙動 500・1 つの挙動の段 64 まで

## 7. 実装（10-1a。2026-11-12）

| 場所 | 中身 |
|---|---|
| `packages/core/src/atlas/` | 形（`types.ts`）、読みこみ（`load.ts`）、検査（`check.ts`）。抽出器の道には依らない（読みの守りと、graph.json の検証器だけを使う） |
| `packages/cli/src/commands/check.ts` | `stack-atlas check` |
| `packages/core/src/__tests__/fixtures/atlas-live/` | サンプルのアプリ（`prototype/live/app`）の正解の図。手で書いた。箱 9・線 15・部品 3・挙動 3 |

決めたこと:

| # | 決定 | 理由 |
|---|---|---|
| D210 | 段のつながりは、「ここまでの経路の上の、どれかの箱から出る」 | 「戻ってから次を呼ぶ」を書けるようにする（§4） |
| D211 | 箱と線の検証は、graph.json の検証器をそのまま使う。全部のファイルを合わせてから掛け、指摘には「どのファイルの、どの箱・線か」を付ける | 契約を 2 つにしない。エージェントが直す所を探せるようにする |
| D212 | 新しい道のファイルは `graph/*.yaml`。古い道の `*.v2.yaml` は読まず、警告する | 2 つの道が並ぶ間（10-4 まで）、互いのファイルを読まない（docs/25 §3.7） |
| D213 | 線の根拠は、契約に足すまで書かせない（10-1b で、箱の根拠の行の範囲と一緒に決める） | graph.json のスキーマを、検査が要る分だけ 1 度に変える |
