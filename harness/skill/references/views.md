# views（`.stack-atlas/views.yaml`）

配線図の名前付きの始点。画面を開く・cron が動く・webhook が届く、のような「ここから流れを見たい」所を並べる。

```sh
stack-atlas init-views .        # .stack-atlas/views.yaml の雛形（始点の候補: 画面・trigger・利用者）。既存のファイルは上書きしない
```

雛形が既にあれば、そのファイルを直接直す。

## 形

```yaml
views:
  - id: today                      # 文字列（英小文字・数字・- にそろえると読みやすい）
    name: "今日の合計を見る"
    description: "任意"
    start: "actor:user"            # 箱 id
  - id: days-response
    name: "日別合計の応答から"
    start: "fn:internal/api.handleDays#out/totals"        # 項目の参照
  - id: cache-hit
    name: "CDN が HIT したとき"
    start: "actor:user"
    variants: { "infra:static_site/this#hit": true }      # キーは必ず "<箱 id>#<分岐 id>"
  - id: wire-start
    name: "線から"
    start: { from: "fn:a#out/x", to: "fn:b#in/x" }        # 線（graph にある線と同じ参照）
```

- トップは配列か `{ views: [...] }`。`id` と `name` は必須
- `start` が graph に無い、`variants` のキーの箱がその分岐を宣言していない view は落とされ、`build --strict` のエラー（`supplements` の kind `view`）
- `start` に group になった v1 の箱（`handler:…` など）を書くと、中の最初の関数の箱に置き換わる。はじめから `fn:` を書く
- 同じ `id` の view が flows.yaml から来ていれば、views.yaml が勝つ
- 補いで足した入口（外部の送り手 `external:…`、手書きの trigger）と、補いで足した分岐の組み合わせ（`"comp:PushToggle#push_v2": true`）の view を足す
- 要らない候補は消す（画面ごとに 1 つ、主な入口に 1 つが目安）
