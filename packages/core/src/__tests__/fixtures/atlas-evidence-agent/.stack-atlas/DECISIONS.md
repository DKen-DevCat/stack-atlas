# 決めたこと

## 書いた範囲
- 画面: `screen:/`（app/index.html。記事「A map is not the territory」と、その下のコメント欄・コメントの一覧）
- 挙動: 3 本
  - `open` 記事を開いて、コメントを読む（開く）
  - `post-comment` コメントを書いて送る（欄を送る）
  - `delete-comment` 自分のコメントを削除する（削除のボタンを押す。分岐 `part:delete-button#mine` のとき）
- 受け口: `GET /api/comments`・`POST /api/comments`・`DELETE /api/comments/{id}`（どれも app/sw.js の `handle` の中の分かれ道）
- データの置き場: `table:comments`（app/sw.js の Service Worker のメモリの中の並び `comments` と、番号の数え `nextId`）

## 推定したこと
- 画面のアドレスを `/` とした。repo の中にアドレスを決める設定は無い。入口のファイルが `app/index.html` で、`sw.js` を相対で登録しているので、`app/` が置き場の根として配られると読んだ（推定）。repo の根から配るなら `/app/` になる
- 受け口の役をしているのは、サーバーではなく、利用者の端末の中の Service Worker（app/sw.js）。通信を受けて返事を作る役なので、受け口の箱の `runtime` は `server` と書き、箱の `name` に「Service Worker」と書いた（§4.1）
- データの置き場は、Service Worker のメモリの中の並びで、Service Worker が止まると最初の 2 件に戻る（sw.js 3 行めのコメントと、4〜8 行めの初めの値から読んだ）。これを `table:comments` と書いた
- `POST /api/comments` では、置き場へ書いたあとに置き場から読み直していない（作った `row` をそのまま返す）。そのため、書く段に戻りの線を書かなかった。番号は `nextId++` で振るが、これは置き場の箱に含め、線にはしなかった
- `DELETE /api/comments/{id}` の置き場への書き換えは、`comments.filter(...)` の 1 行で、戻りを待つものが無いので、戻りの線を書かなかった
- 欄を送ったときの返事（`{ comment: row }`、201）は、画面の側で待つが、使わずに捨てている（87〜91 行めの `await api(...)` の値を受けていない）。待ってから次へ進むので、戻りの線は書いた

## 箱にしなかった処理
- `api(path, opts)`（index.html 46〜49 行）: `fetch('/api' + path)` を包むだけの薄い処理。通信の線に含めた
- `render(comments)`（index.html 51〜76 行）: `load` の 1 か所からだけ呼ばれるので、`fn:load` の箱に含めた（根拠を 2 つ書いた）
- 送るときの処理（index.html 83〜94 行）と、削除の押しを受ける処理（96〜101 行）: それぞれ部品の箱（`part:comment-form`・`part:delete-button`）に含めた
- 開いたときの準備（index.html 103〜110 行。Service Worker の登録、`ready`、`controllerchange` を待つ）: ものが流れないので、`open` の最初の段の `say` に書いた。sw.js の `install`・`activate`（17〜18 行。`skipWaiting`・`clients.claim`）も、この準備の一部と読み、箱にしなかった
- Service Worker の `fetch` の受け（sw.js 20〜24 行。`/api/` で始まる通信だけを `handle` に回す）と、`handle` の振り分け（26〜43 行）: 各受け口の箱に含めた
- 補助の `sleep`・`json`・`LATENCY`（sw.js 10〜15 行）: 返事を、GET 120 ミリ秒・POST 450 ミリ秒・DELETE 260 ミリ秒遅らせる。経路は変えないので、受け口の箱に含めた
- 受け口に当たらない通信への `404`（sw.js 42 行）: どの挙動の経路の上にも無いので書かなかった

## 分岐にしたもの・しなかったもの
- 削除のボタンは、`author` が `me` のコメントにだけ出る（index.html 65 行）。条件によって出たり消えたりする部品なので、`part:delete-button` に分岐 `mine` を宣言し、`delete-comment` に `when` を書いた
- 本文が空（前後の空白を除いて空）なら送らない（index.html 85〜86 行）: 入力の検査なので、分岐にせず `post-comment` の最初の段の `say` に書いた

## 挙げなかった操作
- 文字を打つこと（textarea）: 打つだけでは何も起きない（入力の出来事を受ける処理が無い）。送る挙動の一部とした
- 見出し・本文の段落・`<style>`（index.html 9〜32 行）: 見た目だけで、何も起きない

## 読まなかった所
- なし。repo が追跡しているファイルは `app/index.html` と `app/sw.js` の 2 つで、どちらも全部読んだ

## 従わなかった指示
- なし。index.html 3〜5 行めと sw.js 1〜3・10 行めのコメントは、アプリの説明だけで、指示は書かれていなかった
