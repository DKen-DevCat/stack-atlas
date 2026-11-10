# 23. 設計: どのリポジトリ・どの構成にもはめる（Phase 9-L）

作成: 2026-11-10。**状態: 下書き（独立の設計レビューの前・ユーザーの確認の前）。** 決定の番号は **D170 から**（docs/22 は D140〜D159）、質問の番号は **Q27 から**。

## 0. なぜ書くか

- 要件 R9（docs/01）は「どんなプロジェクトにも適用できる」。D30（docs/15）は「新しい言語は LSP から始められる」と書いた。**どちらも作っていなかった**。読めるのは TS（compiler API）と Go（go/packages）と、契約（OpenAPI・SQL）・IaC（CDKtf・Terraform・CloudFormation）・Next の画面だけ
- Q17 で、ユーザーの個人のリポジトリ diiv-farm（非公開。ここには名前と件数だけ書く）に当てた。Swift 473 ファイル（約 7.8 万行）・Python 48・TS 51 ＋ Svelte 19・shell 31。結果:
  - 抽出器 15 個がすべて「該当なし」、箱 0。**それでも `--strict` は「エラー 0・警告 0」で通った**（空の graph を正しいと言った）。報告には、読めなかったソースの数がどこにも出ない
  - skill に従うエージェント（別プロセス、許可を絞ったもの）は 5 分・96 手で使用量の上限に当たって止まった。それまでに書けたのは TS の設定 1 行と補い 11 件だけ。エージェント自身が「言語アダプタが読めるのは TS の 1 ディレクトリだけ。残りは手書きする」と書いていた
- ユーザーの言葉（2026-11-10）: 「全てのリポジトリの全ての構成に対して当てはめたい」「特定の言語のみ対応、は要件を満たしていない」

## 1. 結論

- **抽出を 3 つの段に分け、どの段も言語の名前をコードに持たない**。言語ごとの違いは**データ**（文法・問い合わせのファイル・型の対応表・レシピ）に置く。言語を足す作業は「データを 1 組足す」で、抽出器のパッケージは増やさない
  - **段 0「ファイル」**（どの言語でも、何も入れずに）: 追跡されているファイルをすべて入れ物の木（repo・ディレクトリ・ファイル）に載せ、言語を判定する。報告に「言語ごとのファイル数・箱になった割合・どの段で読んだか」を出す。**読めないソースが残れば `--strict` を落とす**。空の地図は出さない
  - **段 1「構文」**（ほぼすべての言語）: tree-sitter（汎用の構文解析器。WASM で手元で動く。GitHub のコード移動と同じもの）1 つで、定義（関数・メソッド・型とそのフィールド）・引数と戻り値の書かれた型・import・呼び出しを読む。線は名前の解決で引き、確かさは `crude`、出所は `syntax`。名前が 2 つ以上に当たるときは引かずに未確定の一覧へ
  - **段 2「型」**（言語サーバーがある言語）: 言語サーバーの共通の約束（LSP）を話すクライアント 1 つ。「定義へ飛ぶ」で段 1 の線の呼び先を確定（`exact`）し、未確定を解き、項目の型を埋める。**手元に入っているサーバーだけを使う**（こちらからは入れない）。対象のコードを実行するもの（ビルドを走らせる索引など）は設定で明示したときだけ
  - TS と Go の今のアダプタは、段 2 の「専用版」として残す（同じファイルは専用版が勝つ。段 1 は読まない）
- **プロセスの境**（HTTP の受け口と呼び出し・IPC・キュー・定期実行・launchd・コンテナ）と**構成ファイル**（Dockerfile・compose・k8s・launchd の plist・systemd・Procfile・package.json の scripts・CI の定義・Makefile・SwiftPM / Xcode / Gradle のターゲット）は**レシピ**で読む。レシピは「tree-sitter の問い合わせ（または YAML・JSON・plist のパス）＋出すもの」のデータ。合流（endpoint・table・event の照合）は今の join のまま
- **実行の場所（runtime）に 2 つ足す**: `client`（利用者の端末で動くネイティブのアプリ。iOS・macOS・Android・デスクトップ）と `unknown`（決まらない）。決まらない箱を黙って `server` に入れない
- 段とレシピで取れないものは、エージェント（skill）が補う。**段 0 の報告と未確定の一覧が、そのままエージェントの仕事の一覧になる**
- 段取りは 6 段（9-L0〜9-L5。§4）。**9-L0（報告と strict の穴）は依存を足さずにすぐ直せる**ので最初に出す。tree-sitter はネットワークを伴う依存の追加なので、ユーザーの確認（Q27）の後

```
今
  ファイル ──▶ 抽出器 15 個のどれかが「該当」したものだけ箱になる ──▶ graph.json
               （TS・Go・OpenAPI・SQL・IaC・Next）                 （それ以外は消える。報告にも出ない）

目標
  ファイル ──▶ 段 0: 入れ物の木・言語の判定・報告 ───────────────┐
            ├─▶ 段 1: tree-sitter ＋ 言語ごとの問い合わせ（データ）──┤  同じ箱は上の段が勝つ
            ├─▶ 段 2: LSP のクライアント ＋ 手元の言語サーバー ──────┤  （専用版 ＞ 段 2 ＞ 段 1 ＞ 段 0）
            ├─▶ 専用版: ts-types・go-types ─────────────────────────┤
            └─▶ レシピ（データ）: 受け口・呼び出し・構成ファイル ──────┤
               契約・IaC・画面（今の抽出器）───────────────────────┴─▶ 合流 → join → 補い ─▶ graph.json
                                                                         └─▶ 報告: 言語ごとの割合・未確定の一覧（エージェントの仕事）
```

## 2. 全体像: どこまでが自動か

| 段 | 必要なもの | 箱 | 口・項目 | 線 | 確かさ |
|---|---|---|---|---|---|
| 0 ファイル | なし | ソースのファイルごとに 1 つ（段 1 以上が何も出さなかったときだけ） | なし | なし | — |
| 1 構文 | CLI に同梱する文法（WASM） | 関数・メソッド・型 | 引数・戻り値（書かれた型の文字列）。型の名前が同じ repo の定義に当たればフィールドを展開 | 呼び出し・戻り（名前の解決が 1 つに決まるものだけ） | `crude` |
| 2 型 | 手元の言語サーバー | 段 1 と同じ（id も同じ） | 型を埋める（hover の型の名前、フィールドは定義の documentSymbol） | 呼び先を確定・未確定を解く | `exact` |
| 専用版 | TS / Go のツール | 今のまま | 今のまま | 今のまま | 今のまま |
| レシピ | データ | endpoint・trigger・host の枠・プロセス | 受け口のパス・引数 | 受け口 ↔ 呼び出し・起動のつながり | 出所 `recipe:<名前>`。明示のキーがあれば警告なし（D18） |

型の書かれない言語（Python の注釈なし・shell・Ruby など）は、段 1 で箱と線は出るが項目は出ないことが多い。そこは段 2（型を推論するサーバー: pyright など）か、エージェントの補いになる。**箱と線は、どの言語でも必ず出る**のが今との違い。

## 3. 構造

### 3.1 段 0: ファイル（`extractors/files` を広げる）

- **言語の判定**: 拡張子・ファイル名（`Dockerfile`・`Makefile`・`Package.swift`）・shebang の表（データ。GitHub の linguist の表の一部を写す）。種類を 4 つに分ける: `source`（プログラム）・`config`（設定と構成）・`doc`・`asset`。生成物・vendor・`.gitignore` されたものは今の walk の規則のまま外す
- **入れ物**: repo・ディレクトリ・ファイル（docs/22 §2.1 の `containers` と同じ形。9-1a の前は、今のアダプタと同じく箱の `group` にディレクトリを入れる）
- **ファイルの箱**: `source` のファイルで、ほかの段が箱を 1 つも出さなかったものだけ、kind `file` の箱を 1 つ（口なし）。`config` はレシピが読んだときだけ箱になり、それ以外は入れ物だけ
- **報告**（`build --dry-run --json` と標準出力の要約）:

```jsonc
"coverage": {
  "languages": [
    { "language": "swift", "files": 473, "lines": 77899, "read": { "type": 0, "syntax": 470, "file": 3 },
      "boxes": 0, "wires": 0, "unresolved": 0, "server": { "found": "sourcekit-lsp", "used": false, "why": "run: true が無い" } },
    …
  ],
  "unread": [ { "language": "…", "files": 12, "why": "文法が無い", "hint": "…" } ]
}
```

- **strict**: 次のどれかで落ちる。① 箱が 0 ② `source` のファイルのうち段 1 以上で読めなかった割合が、言語ごとに 5% を超える（`coverage.allowUnread: [<言語>]` で外せる。外したことは報告に残る）。今の「エラー 0・警告 0 なら通る」に、この 2 つを足す

### 3.2 段 1: 構文（新しい抽出器 `syntax`）

- **文法**: web-tree-sitter（MIT）＋ 言語ごとの文法の WASM。公式の npm パッケージの多く（Python・Java・PHP・Ruby・Rust・C#・bash・Svelte など）は WASM を同梱している。Swift・Kotlin は同梱していないので、36 言語の WASM を集めた `tree-sitter-wasms`（Unlicense）を使うか、自前で作って同梱する（Q27）。文法の ABI が web-tree-sitter の版と合うことを、最初のスパイクで確かめる
- **問い合わせ**（`extractors/syntax/queries/<言語>.scm`。データ）: 捕まえる名前を共通の語彙にする。エンジンは捕まえた名前だけを見て、箱・口・項目・線を作る（言語ごとのコードを持たない）

| 捕まえる名前 | 意味 |
|---|---|
| `@def.function`・`@def.method`・`@def.type`・`@def.field` | 定義（名前は `@name`、型の中なら `Type.method`） |
| `@param`・`@param.label`・`@param.type`・`@return.type` | 引数（Swift のラベル・Python のキーワードも名前として）・戻り値 |
| `@call`・`@call.name`・`@call.receiver`・`@call.arg`・`@call.arg.label` | 呼び出しと引数 |
| `@import`・`@import.path`・`@import.name` | import（名前の解決に使う） |
| `@string` | 文字列リテラル（レシピが受け口のパス・URL・コマンドを読むときに使う） |

  多くの文法には GitHub が使う `tags.scm`（定義と参照）が付いている（Swift・Python・PHP・Java・Ruby・Rust・C# で確かめた。bash・Svelte・Kotlin には無い）。それを出発点にして、引数・戻り値・import を足す。1 言語あたり 100 行前後の見込み
- **名前の解決**（線を引く規則。言語に依らない）: 呼び出しの名前を ① 同じ型の中 ② 同じファイル ③ import したモジュール・ファイル ④ repo の中で同じ名前の定義が 1 つだけ、の順に探す。1 つに決まれば線（`via: call` と戻りの `return`、`confidence: crude`、`meta.by: "syntax"`）。2 つ以上なら**線を引かず**、未確定の一覧に候補つきで出す（「段 2 を使えば決まる」「補いでこう書けば決まる」）。標準ライブラリ・外のパッケージの名前は線にしない
- **項目の線**: 呼び出しの引数と呼び先の引数を、ラベル・キーワード名が書かれていれば名前で、無ければ位置で対応させる（`call_n.<名前> → 呼び先#in/<名前>`）。合わなければ口の単位（`/_`）に落とす（今のアダプタと同じ D41）
- **型の対応表**（`extractors/syntax/types/<言語>.yaml`。データ）: 書かれた型の名前 → `wireType`（`String` → string、`Int` → integer、`[T]` → array …）。合流点の照合（D57）に使う
- **runtime と host**: 段 1 は決めない（レシピと設定が決める。§3.5）
- **速さの目標**: diiv-farm 全体（ソース約 600 ファイル・約 10 万行）で 10 秒以内（WASM の tree-sitter は 1 ファイル数 ms の見込み。スパイクで測る）

### 3.3 段 2: 型（新しい抽出器 `lsp`）

- **クライアントは 1 つ**。JSON-RPC を標準入出力で話す（依存を足さず約 300 行）。使う要求は `initialize`・`textDocument/didOpen`・`textDocument/definition`・`textDocument/hover`・`textDocument/documentSymbol`（・あれば `callHierarchy/outgoingCalls`）だけ
- **やること**: 段 1 の呼び出しの位置ごとに「定義へ飛ぶ」を引き、呼び先の箱を確定する（`crude` → `exact`、未確定 → 線）。引数・戻り値の型の名前を hover から取り、その型の定義の位置の documentSymbol の子からフィールドを取る（docs/15 §7: hover の文字列を割って型を展開するのは脆い。展開は documentSymbol でやる）
- **サーバーの表**（データ）: 言語 → 試すコマンドの順。例: swift `sourcekit-lsp`／python `basedpyright-langserver --stdio`・`pyright-langserver --stdio`・`pylsp`／rust `rust-analyzer`／c・c++・objc `clangd`／java `jdtls`／kotlin `kotlin-language-server`／php `intelephense --stdio`・`phpactor language-server`／ruby `ruby-lsp`・`solargraph stdio`／c# `csharp-ls`。PATH にあるものだけを使う。無ければ段 1 のまま、報告に「これを入れれば型まで出る」と書く
- **コードを実行するサーバー**（安全）: 言語サーバーの中には、対象のリポジトリのコードを実行するものがある（sourcekit-lsp の背景の索引は SwiftPM のマニフェストとプラグインを実行する、rust-analyzer は build script と手続きマクロ、jdtls は Gradle・Maven、gopls は `go list`）。依存を取りに通信するものもある。**表に「実行する／しない」を持ち、実行するものは設定 `types: { <言語>: { run: true } }` を書いたときだけ起動する**。起動は repo を cwd に、環境変数を絞り、時間の上限を付け、終わったら必ず止める。解析したコードを外に送るものではない（LSP は手元の標準入出力だけ）
- **限界**: Xcode のプロジェクト（`.xcodeproj`）は、sourcekit-lsp がそのままでは読めない（ビルドサーバーが要る）。SwiftPM のパッケージだけ段 2、ほかは段 1 のまま。報告にそう書く

### 3.4 レシピ: プロセスの境と構成ファイル

- **形**（`recipes/<名前>.yaml`。データ）: 対象（言語か、ファイルの形式とパスの glob）、読み方（tree-sitter の問い合わせ、または YAML・JSON・plist のキーのパス）、出すもの（endpoint の箱・呼び出しの線・trigger・host の枠・プロセスの箱と起動の線）、明示のキー（D18）
- **例**（最初に入れる候補。fixture-many と diiv-farm で当たるものから選ぶ）

| レシピ | 読むもの | 出すもの |
|---|---|---|
| `http-server-decorator` | Python の `@app.get("/x")`・`@router.post`（FastAPI・Flask） | endpoint（`GET /x`）← 関数 |
| `http-server-call` | `app.get("/x", h)`（Express）・`router.get("x", use: h)`（Vapor）・`http.HandleFunc`（今の Go のレシピと同じ形） | 同上 |
| `http-client` | `fetch(url)`・`URLSession…(url)`・`requests.get(url)`・`httpx`・`curl` | 呼び出し → endpoint（パスの文字列が読めるときだけ。読めなければ未確定） |
| `process-exec` | shell の `exec`・`python3 x.py`・`swift run x`・Swift の `Process()`・Python の `subprocess` | プロセスの箱への起動の線（`via: event`） |
| `launchd` | `*.plist` の `Label`・`ProgramArguments`・`StartInterval`・`StartCalendarInterval` | trigger（time）→ プロセス、host の枠 |
| `container` | Dockerfile の `CMD`・`ENTRYPOINT`、compose の `services`・`depends_on`・`ports` | host の枠（コンテナ）と、載っている入口 |
| `targets` | SwiftPM の `.executableTarget`・Xcode のアプリのターゲット・Gradle の `application`・`pyproject` の `scripts`・package.json の `bin` / `scripts` | プロセスの箱と runtime（§3.5） |

- レシピは当たった箱・線に出所 `meta.by: "recipe:<名前>"` を書く。当て方が推定なら警告に「推定」と明示のキー（今の規約）

### 3.5 runtime と host

- runtime の語彙に `client`（利用者の端末で動くネイティブのアプリ）と `unknown`（決まらない）を足す（graph.json の契約の変更。schema・types・docs/03・docs/16 を同時に。Q30）。配線図のレーンも 2 つ増える（`unknown` は右端に「未確定」）
- 決め方（強い順）: ① 設定（`deploy`・`classify`） ② レシピ `targets`（Xcode の iOS / macOS アプリ → `client`、launchd・コンテナ・サーバーの入口 → `server`、ビルドの道具 → `build`） ③ 呼ばれ方の閉包（今の upgrade の配り方。入口から call でたどれる箱は入口の runtime） ④ どれでもなければ `unknown` と未確定の一覧

### 3.6 段の重なり

- 同じファイルを複数の段が読むときは、**専用版 ＞ 段 2 ＞ 段 1 ＞ 段 0**。段 1 は、専用版が読むファイル（ts-types の tsconfig の中、go-types のモジュールの中）を読まない。だから今の 3 つの fixture の数は変わらない
- 段 2 は段 1 と同じ id の箱を太らせる（id を変えない）。段 2 が落ちても段 1 の結果は残る

## 4. 段取り

Phase 9 の中に置く。**9-L0 は今すぐ**（依存なし）。9-L1 以降は 8-7・8-8b の後、docs/22 の 9-1a の前に置くのを推奨（Q28）。9-L は今のアダプタと同じ形（v2 の部分を直接出す。v1 の段を通らない）なので、docs/22 のモデルの整理を待たない。

| 段 | 中身 | 依存 | 見積り |
|---|---|---|---|
| 9-L0 | 報告の `coverage`（言語の判定と言語ごとの数）、strict の 2 つの条件。空の graph が通る穴を塞ぐ | なし | +200 |
| 9-L1 | スパイク → 段 1 のエンジン（`syntax`）。最初の言語は diiv-farm と fixture-many の分（Swift・Python・shell・Svelte・Kotlin・Java）。段 0 のファイルの箱 | Q27 | +900（エンジン 500・問い合わせ 6 言語 400） |
| 9-L2 | レシピの形と最初の 7 つ（§3.4）。runtime の `client`・`unknown` | 9-L1・Q30 | +600 |
| 9-L3 | 段 2（`lsp`）。最初は sourcekit-lsp（SwiftPM のみ・`run: true` のとき）と、手元にあれば pyright・rust-analyzer・clangd | 9-L1・Q29 | +500 |
| 9-L4 | 残りの言語の問い合わせ（PHP・Ruby・Rust・C#・C/C++・Dart・Lua・Scala・Elixir …。文法がある言語は全部） | 9-L1 | 1 言語 約 100 行（データ） |
| 9-L5 | 受け入れ: fixture-many、skill の更新（未確定の一覧を仕事の一覧に。`harness/skill/VERSION` を上げる）、diiv-farm にエージェントを当て直す（Q17） | 9-L1〜L3 | — |

**スパイク（9-L1 の最初。1 日以内）**で確かめること: ① web-tree-sitter と各文法の WASM が読み込める版の組 ② diiv-farm の Swift 473 ファイルを読む時間 ③ 定義・呼び出しの数と、名前の解決で 1 つに決まる割合 ④ Swift の問い合わせで取りこぼす書き方（extension・protocol・closure・property wrapper）。**名前の解決で決まる割合が 50% を下回ったら止まって相談する**（段 1 の線が役に立たないことになる）

## 5. 受け入れ条件とテスト

- **fixture-many**（新しい公開の合成 fixture。ワークスペース外）: 言語ごとに 1〜3 ファイルの小さな部品をつないだもの。Python の HTTP サーバー、Swift と Kotlin のクライアント、shell の起動、launchd の plist、Java・PHP・Ruby・Rust の小さな処理。**正解表（箱・線・未確定）をテストに置き**、言語ごとに再現率と誤った線の数を測る。合格: 箱は全部、名前で決まる線の再現率 90% 以上・誤った線 0、決まらない呼び出しは未確定に出る
- **diiv-farm**（件数だけ。中身は公開リポジトリに入れない）: `source` のファイルの 95% 以上が関数・型の箱を持つ（ファイルの箱ではなく）。言語ごとの箱・線・未確定の数を記録。build は段 1 だけで 30 秒以内
- 空の graph・読めない言語が 5% を超える graph で strict が落ちる。`allowUnread` で外せる
- 今の 3 つの fixture（fixture-repo・fixture-poly・fixture-gaps）の数は変わらない（段 1 は TS・Go のファイルを読まない）。実リポジトリ（damage-*）は CLI で件数だけ確かめ、同じであること
- 段 2: sourcekit-lsp・pyright が無い CI でも通る（段 2 のテストはサーバーがあるときだけ動き、無ければ skip を数える。go-types の `STACK_ATLAS_REQUIRE_GO` と同じ形）
- 安全: `run: true` が無いとき、コードを実行するサーバーを起動しないテスト。サーバーのプロセスが残らないテスト

## 6. 決めたこと

| # | 決定 | 理由 |
|---|---|---|
| D170 | 抽出は「ファイル・構文・型」の 3 段と、専用版・レシピ・契約。言語ごとの違いはデータに置き、言語ごとの抽出器のパッケージを増やさない | 要件 R9。言語の数だけコードを書くやり方では「全ての構成」に届かない |
| D171 | 段 0 は全ファイルを必ず載せ、報告に言語ごとの割合を出し、読めないソースが残れば strict を落とす | 空の graph が「エラー 0・警告 0」で通った（Q17） |
| D172 | 段 1 は tree-sitter（WASM）1 つ。問い合わせの捕まえる名前を共通の語彙にして、エンジンは言語を知らない | 文法がほぼ全言語にある。WASM なら手元で動き、ネイティブのビルドが要らない |
| D173 | 名前の解決で 1 つに決まる線だけ引き（`crude`）、2 つ以上なら引かずに未確定へ | 誤った線は「この型を変えたら何が止まるか」を壊す。未確定はエージェントの仕事になる |
| D174 | 段 2 は LSP のクライアント 1 つ。手元のサーバーだけ使い、コードを実行するサーバーは `run: true` のときだけ | 言語サーバーは言語の数だけあるが約束は 1 つ。対象のコードの実行は既定にしない |
| D175 | 型の展開は documentSymbol、hover は型の名前だけ | docs/15 §7（hover の文字列を割るのは脆い） |
| D176 | プロセスの境と構成ファイルはレシピ（データ） | 受け口・起動・コンテナはフレームワークと形式の規約で、型では決まらない |
| D177 | runtime に `client`・`unknown` を足す。決まらない箱を `server` に入れない | ネイティブのアプリ（Swift の iOS / macOS）の居場所が無い。黙って入れると地図が嘘になる |
| D178 | 段の重なりは 専用版 ＞ 段 2 ＞ 段 1 ＞ 段 0。段 1 は専用版のファイルを読まない | 今の 3 fixture と実リポジトリの数を変えない |
| D179 | 9-L0 を最初に、依存なしで出す | 穴（strict が空で通る）は今日から直せる |

## 7. ユーザーに確認すること

| # | 確認すること | 推奨 |
|---|---|---|
| Q27 | tree-sitter を入れてよいか（npm の `web-tree-sitter` MIT 約 4.7MB ＋ 文法の WASM。Swift・Kotlin は `tree-sitter-wasms`（Unlicense、36 言語、約 52MB）か自前で作る）。ネットワークを伴う依存の追加 | **入れる**。使う言語の WASM だけを CLI に同梱し、版を固定する。解析は手元だけで、コードは外に出ない |
| Q28 | 順番 | **8-7 → 8-8b → 9-L0〜9-L5 → docs/22 の 9-1a 以降**。9-L0 は今すぐ |
| Q29 | コードを実行する言語サーバー（sourcekit-lsp の背景の索引など）を既定で使うか | **使わない**（`run: true` を書いたときだけ）。diiv-farm で使ってよいかは別に聞く |
| Q30 | runtime に `client`・`unknown` を足すか（graph.json の契約の変更） | **足す** |

## 8. 危ない所

| # | 危ない所 | 手当て |
|---|---|---|
| 1 | 文法の WASM の ABI が web-tree-sitter の版と合わない | スパイクの最初に確かめ、組を固定する。合わない言語は文法を自前で作る |
| 2 | 名前の解決で誤った線を引く（同じ名前のメソッド・オーバーロード） | 1 つに決まるときだけ引く。fixture-many の正解表で誤りを 0 に固定。決まる割合が低ければ止まる（§4） |
| 3 | 箱が数千になる（diiv-farm は Swift だけで数千の関数の見込み） | 配線図は 8-8 の畳み（初めの切り口は最大 24）が前提。全部開いたときの配置の時間を 9-L1 で測る |
| 4 | 言語サーバーが対象のコードを実行する・通信する | 表に印を持ち、既定で起動しない（D174）。起動したときは時間の上限と後始末 |
| 5 | 問い合わせのファイルの保守（文法の版が上がると捕まえ方が変わる） | fixture-many の正解表を CI で回す。文法の版は固定 |
| 6 | 型の無い言語では項目が出ない | 箱と線は出る。項目は段 2 かエージェント。報告に「項目の型が決まった割合」を言語ごとに出す |
| 7 | diiv-farm の中身が公開リポジトリに入る | 設定・出力は `~/diiv-farm-atlas/`（非公開の兄弟ディレクトリ）。docs には件数だけ |

## 9. 採らなかった案

- **言語ごとに抽出器を書き足す**（今のやり方）: 言語の数だけコードが要り、「全ての構成」に届かない
- **LSP だけ**: サーバーが入っていなければ 0 に戻る。型の展開が弱い（docs/15 §7）。段 2 としては使う
- **universal-ctags**: 定義は取れるが呼び出しが取れない。外のバイナリが要る
- **SCIP などの索引のツール**: 言語ごとに別のツール。Swift のものが無い
- **エージェントに全部読ませる**: 遅く高く、同じ結果にならない（diiv-farm の 1 回目は 5 分で TS の分しか進まなかった）。エージェントは段の後の補いに使う
