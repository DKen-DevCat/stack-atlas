# 補い（`stack-atlas.overrides.yaml` の `v2:` の節）

言語アダプタが自動で出せない所を、項目の単位で補う。graph.json を手で書く代わりにここへ書けば、再生成しても消えない。例の id は合成の支出トラッカー（Stack Atlas の fixture-poly）の形で、**対象の id はかならず報告と graph.json で確かめてから**書く。

## 1. 共通の約束

- **reason は必須**（全種類）。DECISIONS.md の reason と同じ文にする。無ければ `build --strict` のエラー
- 補いで足した線・links・項目は `confidence: crude` が既定で、`meta.by: "overrides"` と reason が付く。`confidence: exact` は根拠（コードの行）を DECISIONS.md に書いたときだけ書く
- **strict の違反を `remove` で消さない**。埋められない隙間は提案にする
- 結果は `build --dry-run --json` の `supplements`（効いた / 解けない / 指紋が合わない）。解けない補いも strict のエラー
- v1 の `nodes` / `edges` / `remove` / `deploy`（同じファイルの上の方。3D の地図と箱の単位の線）はそのまま使える。項目の単位は `v2:` に書く

## 2. 参照の書き方

項目を指す所（`from`・`to`・`at`・links / when の `from`・`to`）は次のどれか。

| 形 | 意味 |
|---|---|
| `"fn:getEntries#in/limit"` | 文字列の参照（`model.md` §2）。links・when の中では `#` を省いて `"in/limit"`（その箱の中） |
| `{ ref: "<参照>", expect: { name, type, http } }` | 指紋付き。**番号の項目（`call_n`・`ret_n`・`render_n`・`query_n`・`insert_n`・`update_n`）を含む参照は expect が必須** |
| `{ call: { in: "<箱>", to: "<箱>" } }` | 意味の参照: `in` の箱の out の項目のうち、`to` の箱へ線が出ているもの（呼び出し `call_n` も描画 `render_n` も） |
| `{ call: { in: "<箱>", http: "GET /entries" } }` | 意味の参照: `in` の箱の HTTP の呼び出しのうち method とパスが合うもの |
| `{ ret: { in: "<箱>", from: "<箱>" } }` | 意味の参照: `in` の箱の呼び出しの戻り `ret_n` のうち、`from` の箱から返るもの |
| 上の 3 つに `path: "a.b"` | 見つけた項目の子へ下りる（`{ call: { in: "fn:getEntries", http: "GET /entries" }, path: url }` → `…#out/call_1.url`） |

- 意味の参照は**候補がちょうど 1 つ**のときだけ解ける（0 なら解けない、2 つ以上なら番号と expect で書く）。links・when の中では `in` を省くとその箱
- 指紋（expect）は**番号の段の項目**（`call_1` 自身）の `name`・`type`、呼び出しなら `http: "METHOD /path"` と比べる。子の名前（`call_1.query`）はずれないので比べない。合わなければ「指紋が合わない」（前に呼び出しが増えて番号がずれた）
- 番号を書くより意味の参照を先に考える。同じ相手を 2 回呼ぶなど候補が複数のときだけ番号と expect
- group になった v1 の箱（`lib:…`・`handler:…` のファイル・パッケージの箱）は指せない。中の `fn:` を指す
- 名前は graph.json の値をそのまま写す（`fetch() の戻り` のような表示名も）

## 3. 当てる段

```
抽出 → 合流（呼び出し ⇔ endpoint ⇔ handler ⇔ table）
  → 段 A: nodes → wires → remove（retarget は確かめて、次の掃除が使う）
  → 掃除（group の付け替え。補った線も「細かい線があれば箱の単位の線を消す」に入る）
  → 段 B: items → variants → links → when
  → 数え直し（unjoined・undetermined・不透明は最後の graph から）→ 食い違いの検査 → views.yaml → strict
```

- 段 B の順なので、when は同じファイルの links で足した対応と variants で足した分岐を指せる。items で足した子を links で指せる
- 手書きの部分グラフ（`hand-graph.md`）の箱は合流の前に入るので、v2.wires から指せる

## 4. 種類ごと

### 4.1 `nodes`（箱のパッチ）

```yaml
v2:
  nodes:
    - { id: "fn:internal/push.Send", host: "infra:lambda_api/notify", reason: "notify の Lambda からしか呼ばれない" }
```

変えられるのは `runtime`・`kind`・`host`（`kind: infra` の箱 id）・`group`・`name`・`file`・`line`・`code`・`cache`・`screen`。ほかのキーは解けない補い。箱を**足す**のは手書きの部分グラフ。

### 4.2 `wires`（線を足す）

```yaml
v2:
  wires:
    - from: { call: { in: "fn:getExchangeRate", http: "GET /v2/rates" }, path: input }
      to: "external:fx-api#in/path"
      via: http                      # 必須: props | call | return | http | sql | event | render | deliver
      label: "GET /v2/rates"         # 任意
      reason: "為替は外部 API。自前の OpenAPI に無いので合流できない"
    - from: "external:fx-api#out/body"
      to: { ref: "fn:getExchangeRate#in/ret_1", expect: { name: "fetch() の戻り", type: "Response" } }
      via: http
      reply: true                    # 往復の戻り
      reason: "為替 API の応答が fetch の戻りに入る"
```

- `from` は dir out の口の項目、`to` は dir in の口の項目。任意で `reply`・`label`・`when`・`confidence`
- 結べなかった呼び出し（`unjoined.calls`）は、その `item`（かその子）から `via: http` の線が出れば解決。OpenAPI に無いルートは、handler の箱に `via: http`（か `event`）の線が入れば解決
- 子の照合（食い違いの検査）は線の両端の子どうしで行う。子のある項目から子の無い項目へ引くと照合しない（不透明）。形の合う段どうしを結ぶ（パスの子 → `in/path` など）

### 4.3 `retarget`（付け替え先を決める）

```yaml
v2:
  retarget:
    - { group: "handler:cmd/notify", peer: "schema:push_subscriptions", to: ["fn:cmd/notify.main"], reason: "購読の読み出しは main が直接行う" }
```

`undetermined` の `{ group, peer }` と同じ組を書き、`to` は `candidates`（group の中の関数の箱）から選ぶ。使われなかった retarget（もう付け替える線が無い）は解けない補い。

### 4.4 `remove`（線を消す）

```yaml
v2:
  remove:
    - { wire: { from: "fn:a#out/call_1.x", to: "fn:b#in/x" }, reason: "…" }   # 項目どうし（参照の書き方は §2）
    - { wire: { from: "fn:a", to: "fn:b" }, reason: "…" }                     # 箱 id どうし: その向きの線を全部
```

アダプタの誤った線を消すときだけ。**strict の違反（結べない呼び出しなど）を消すために使わない**。

### 4.5 `items`（中の見えない項目に子を足す）

```yaml
v2:
  items:
    - at: "fn:internal/api.handleImport#in/body"
      expect: { type: "map[string]any" }       # 今の型を指紋に（型が直ったら外れて気づける）
      children:
        - { id: source, name: source, type: string, wireType: string, optional: true }
        - { id: amount, name: amount, type: float64, wireType: number }
      reason: "body を map[string]any で受け、source と amount のキーだけを読む"
```

- 足せるのは**子の無い項目か `wireType: unknown` の項目**だけ（アダプタの子がある項目には足せない）
- 子の id は `[A-Za-z0-9_$-]+`（`.` は不可）。入れ子は `children` の中に `children`。1 つの補いで 500 個まで
- コードが実際に読むキーだけを書く。読まないフィールドは書かない（足すと契約との食い違い `broken` が新しく出ることがある。それは「送っても使われない」という事実なので消さない）
- `wireType` を書くと照合が効く（JSON の数値は Go の `float64` なら `number`）

### 4.6 `links`（箱の中の対応）

```yaml
v2:
  links:
    - { node: "fn:toDayCells", from: "in/totals", to: "out/return.cells", reason: "totals を日ごとのセルに詰め替える" }
    - { node: "fn:internal/api.handleImport", from: "in/body.amount", to: { call: { to: "fn:internal/store.InsertTransaction" }, path: tx.amount }, confidence: exact, reason: "…（DECISIONS.md に行番号）" }
```

- `from` は dir in、`to` は dir out の項目（同じ箱の中）。任意で `when`・`confidence`・`mode: replace`
- links の無い箱は、既定の links（全 in → 全 out。table は key → read、endpoint は恒等）を**書き出してから**足す（1 本足すと既定が消えないように）。全部を自分の links にするときは `mode: replace`
- 同じ links が既にあれば足さず、印（`meta.by`・reason）だけ付ける。confidence は書いたときだけ置き換わる

### 4.7 `variants`（分岐を宣言する）

```yaml
v2:
  variants:
    - { node: "comp:PushToggle", id: push_v2, name: "新しい購読フロー（フラグ）", default: false, reason: "機能フラグで呼ぶ API が変わる" }
```

`id` は `[a-z][a-z0-9_]*`。同じ箱の同じ id は置き換え（upsert）。分岐だけ宣言しても何も変わらない。§4.8 の when とセットで書く（`variants.md`）。

### 4.8 `when`（links か線に条件を付ける）

```yaml
v2:
  when:
    # 箱の中の links に（node と link）
    - node: "fn:getEntries"
      link: { from: "in/limit", to: { call: { http: "GET /entries" }, path: query.limit } }
      when: { limit: true }
      reason: "limit を渡したときだけクエリに載る"
    # 線に（wire）
    - wire: { from: { call: { in: "comp:PushToggle", to: "fn:subscribeV2" } }, to: "fn:subscribeV2#in/call" }
      when: { push_v2: true }
      reason: "フラグが有効なときだけ新しい購読 API を呼ぶ"
```

- 指す links・線は**既にあるもの**（無ければ解けない。links は §4.6 で先に足す）。線の `from` / `to` は graph.json の線と完全に同じ参照になること（親か子か）
- キーは分岐 id か `<箱 id>#<分岐 id>`。分岐を宣言した箱の links か、その箱が端にある線に付ける（両端が同じ id を宣言しているなら修飾が要る）
- `{ 分岐: true }` と `{ 分岐: false }` の両方の側を書くと、配線図で切り替えたときに片方だけが光る
