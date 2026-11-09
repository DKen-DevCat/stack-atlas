# 手書きの部分グラフ（`.stack-atlas/graph/*.v2.yaml`）

アダプタが箱を出さないもの（外部 API、アダプタの無い言語の handler、webhook の送り手、cron・キューの中身）を、graph.json v2 と同じ形の箱で書く。build は**手書きの言語アダプタ `hand`** として、合流の前に混ぜる（報告の `checked.hand`、ファイルごとの結果は `supplements` の kind `hand`）。

## 1. ファイルの形

- 置き場は `.stack-atlas/graph/<名前>.v2.yaml`（末尾が `.v2.yaml` のものだけ読む。`.yml` は読まない）。意味のまとまりごとに 1 ファイル（`external.v2.yaml`、`legacy-php.v2.yaml` など）
- トップは `{ nodes: [...], wires?: [...], types?: [...] }`。箱・線・型の形は `model.md` §1（docs/16）
- 新しい箱は `runtime` が必須（推せない）。`kind`・`ports` も要る。`links` を書かないと「全 in → 全 out」の不透明な箱になる
- 足した箱には `meta.by: "hand"` と `meta.handFile` が付く。形の誤り（schema・箱の中の参照）はファイルごと捨てられ、解けない補い（strict のエラー）になる
- 上限: 64 ファイル・1 ファイル 1MB・箱 2000・項目 20000（全部のファイルの合計）、YAML の別名 100。シンボリックリンクは読まない
- 箱 id が言語アダプタ・契約の箱と同じなら**アダプタが勝つ**: 効くのは「アダプタの項目に子が無いか unknown のとき」の子の追加だけ。links・variants は無視される（overrides の `v2:` で書く）。新しい箱には、既存と重ならない id を付ける
- 線（`wires`）は手書きの箱どうしなら書いてよい。**アダプタの箱へつなぐ線は overrides の v2.wires に書く**（reason が残り、番号の項目を意味の参照・指紋で指せ、結果が報告に出る）

## 2. 外部 API の箱

```yaml
# .stack-atlas/graph/external.v2.yaml
nodes:
  - id: "external:fx-api"
    kind: external
    name: "為替 API（api.fx.example）"
    runtime: external
    ports:
      - id: in
        dir: in
        items:
          - { id: path, name: "GET /v2/rates", type: string, wireType: string }
      - id: out
        dir: out
        items:
          - id: body
            name: body
            type: Rates
            wireType: object
            children:
              - { id: base, name: base, type: string, wireType: string }
              - { id: rate, name: rate, type: number, wireType: number }
    links:
      - { from: in/path, to: out/body, confidence: crude }
```

呼び出し側からの線は overrides に書く（`supplements.md` §4.2 の例: 呼び出しの項目のパスの子 → `external:fx-api#in/path`、`out/body` → 呼び出し元の `ret_n`（`reply: true`））。項目は、呼び出し側のコードが読む応答のフィールドだけでよい。URL のホスト名は書いてよいが、鍵・トークンは書かない。

## 3. アダプタの無い言語の handler（`meta.route`）

`meta.route`（`"GET /export"` か `{ method, path }`）を書くと、合流の段が自動で結ぶ:

- OpenAPI に同じ endpoint があれば `endpoint#req/<役割> → handler#in/<その役割の項目>`、応答は `handler#out/<応答> → endpoint#res/body`
- OpenAPI に無ければ、そのパスを呼ぶ呼び出しと**直接**結ぶ: `call_n.<役割の子> → handler#in/<その役割の項目>`、`handler#out/<応答> → 呼び出し元の ret_n`

役割は項目の `meta.http`: in の項目に `path` / `query` / `body`、out の応答の項目に `response`。役割の項目が無ければ、in の最初の普通の項目が入口になる。

```yaml
# .stack-atlas/graph/legacy-php.v2.yaml（PHP の例。legacy/api/export.php が GET /export を返す）
nodes:
  - id: "fn:legacy/api/export"
    kind: fn
    name: "export.php"
    runtime: server
    file: platform/legacy/api/export.php     # 複数 repo なら <repo>/<repo 相対パス>
    line: 1
    # host: "infra:…"                          # 動く所のインフラの箱が graph にあれば
    meta: { route: "GET /export", lang: php }
    ports:
      - id: in
        dir: in
        items:
          - id: query
            name: query
            type: "$_GET"
            wireType: object
            meta: { http: query }
            children:
              - { id: from, name: from, type: string, wireType: string }
              - { id: to, name: to, type: string, wireType: string, optional: true }
      - id: out
        dir: out
        items:
          - id: body
            name: body
            type: array
            wireType: object
            meta: { http: response }
            children:
              - { id: rows, name: rows, type: array, wireType: array }
              - { id: count, name: count, type: int, wireType: integer }
    links:
      - { from: in/query.from, to: out/body.rows, confidence: crude }
      - { from: in/query.to, to: out/body.rows, confidence: crude }
```

- 項目の名前と型は PHP のコード（`$_GET['from']`、`json_encode([...])` のキー）から写す。`optional` は `?? 既定値` があるもの
- 同じ handler が DB を読むなら、table の箱（`schema:<表>`）への線（`via: sql`）を overrides の v2.wires で足してよい（任意）
- 実装が別の repo・別の言語にある endpoint（報告の `endpointsWithoutHandler`）も、この形で handler を置けば消える

## 4. OpenAPI に無いルートの送り手（webhook など）

`unjoined.routesWithoutEndpoint` の handler は、送り手の箱を手書きし、overrides で handler の入口の項目へ `via: http` の線を引けば解決する（handler の箱に `via: http` か `event` の線が入ればよい）。

```yaml
# .stack-atlas/graph/external.v2.yaml に足す
  - id: "external:billing-provider"
    kind: external
    name: "決済サービス（webhook の送り手）"
    runtime: external
    ports:
      - id: out
        dir: out
        items:
          - id: event
            name: event
            type: InvoicePaid
            wireType: object
            children:
              - { id: invoiceId, name: invoiceId, type: string, wireType: string }
```

```yaml
# stack-atlas.overrides.yaml
v2:
  wires:
    - from: "external:billing-provider#out/event"
      to: "fn:internal/api.handleInvoiceWebhook#in/body"
      via: http
      label: "POST /webhooks/invoice"
      reason: "決済サービスからの webhook。OpenAPI に載っていない"
```

handler の body の子と送り手の子の名前を揃えると照合が効く。OpenAPI に足すのは提案（対象のファイルは書かない）。送り手の箱は views.yaml の始点にできる。

## 5. cron・キューの中身

`kind: trigger`（`runtime: time`）や `kind: queue` の箱を足し、中で呼ぶ関数の箱（アダプタの箱）への線を overrides の v2.wires で引く。スケジュールの式は `name` か `meta` に書いてよい。
