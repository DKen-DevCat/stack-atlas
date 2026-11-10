# 分岐（variants と when）

配線図は 1 つの状態の組み合わせ（既定は各分岐の `default`）を描き、分岐の表で切り替える。コードの `if` / 三項演算子 / `&&` で**描く部品・呼ぶ先・渡す項目**が変わる所は、アダプタが分岐にしないので補う。strict は分岐の欠けを検査しない（報告に出ない隙間）。

## 1. 見つけ方

| 種類 | コードの目印 | 自動で出るか |
|---|---|---|
| キャッシュ | CloudFront・SWR・React Query・`fetch` の cache | `kind: cache` の箱の `hit` は自動（cache 抽出器） |
| 認証 | Go の認証 middleware（Authorization を見て 401） | endpoint の `login` は自動（go-types）。ほかの形（cookie・セッション・画面のガード）は補う |
| 機能フラグ | `process.env.NEXT_PUBLIC_FEATURE_*`、`flags.isEnabled('x')`、設定の真偽値 | 出ない |
| 任意の引数・クエリ | TS の `x?: T`・既定値、Go の `if v := r.URL.Query().Get("x"); v != ""`、OpenAPI の `required: false` | 出ない（項目は出るが、渡す / 渡さないの 2 つの状態は出ない） |
| 日付・時刻 | 締め日・月末・タイムゾーンで返すものが変わる、日付の指定の有無 | 出ない |
| 権限・ロール | `if (user.role === 'admin')` | 出ない |

1 つの判断（同じフラグ・同じ引数の有無）は 1 つの分岐にまとめる。判断が箱をまたぐなら、**判断している箱**（フラグを読む部品、引数を受ける関数）に置く。

## 2. 書き方

1. `variants` で分岐を宣言する（`id` は `[a-z][a-z0-9_]*`、`name` は人が読む名前、`default` は本番の既定）
2. `when` で、その分岐で変わる links か線に条件を付ける。片方だけでなく、`true` の側と `false` の側の両方を書く
3. 変わる対応がまだ無ければ（コードが変数を経由していてアダプタが links を出していない）、先に `links` で足す

```yaml
v2:
  variants:
    - { node: "comp:PushToggle", id: push_v2, name: "新しい購読フロー（NEXT_PUBLIC_FEATURE_PUSH_V2 が 1）", default: false, reason: "フラグで購読の部品を切り替える" }
  when:
    # 部品を三項演算子で選ぶ: 描画の項目は render_n。意味の参照 { call: { to } } は描画にも効く
    - node: "comp:PushToggle"
      link: { from: "in/props", to: { call: { to: "comp:SubscribeV2" } } }
      when: { push_v2: true }
      reason: "フラグが 1 なら SubscribeV2 を描く"
    - node: "comp:PushToggle"
      link: { from: "in/props", to: { call: { to: "comp:SubscribeLegacy" } } }
      when: { push_v2: false }
      reason: "フラグが 1 でなければ SubscribeLegacy を描く"
```

- links の `from` は、その描画・呼び出しへ実際に流れ込む in の項目（graph.json の箱の `links` で確かめる。呼び出しの戻り `ret_n` なら `{ ret: { from: "<返す箱>" } }` で指す）
- 任意のクエリは、引数からクエリの子への link に `when: { <分岐>: true }` を付ける（`link: { from: "in/limit", to: { call: { http: "GET /entries" }, path: query.limit } }`）。サーバー側にも同じ判断があるなら（「空なら既定の件数」）、handler の箱に同じ id の分岐を置いてよい（線の両端が同じ id を宣言したら、線の when は `<箱 id>#<分岐 id>` で修飾する）
- 分岐の組み合わせを名前付きで見せたいときは views.yaml の `variants`（`views.md`）

## 3. 書かないもの

- 例外・エラーの経路（`if err != nil`）は分岐にしない（全部が分岐になって読めなくなる）
- アダプタが出した `hit`・`login` を作り直さない（同じ id で upsert になる）
- コードに無い状態（将来のフラグなど）は書かない
