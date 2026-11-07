# @stack-atlas/extractor-terraform

素の Terraform（HCL）から **インフラ層**（`infra:*` ノードと `flow` エッジ）を作る抽出器（docs/12 §3.3）。
`terraform` CLI は不要。HCL は `@cdktf/hcl2json`（wasm、ネットワーク不要）で JSON にし、モジュールと参照を解決してから `@stack-atlas/tf-graph` に渡す。

## 入力・設定

| キー | 既定 | 意味 |
|---|---|---|
| `terraform.root` | 自動 | module 呼び出しを持つ root モジュールのディレクトリ |
| `terraform.repo` | | 複数リポジトリのとき、対象の repo |
| `terraform.sourceDir` | | 互換用（file / line は読んだモジュールの .tf から直接探す） |
| `infra.include` / `exclude` / `all` | | ノードにする型の調整（tf-graph の README） |
| `deploy.<id>.app: next` | | その Lambda に `meta.deployApp: 'next'` |

`root` が無いときの自動検出: `infra/` → `terraform/` → `iac/` → repo 直下（浅く）の順に、`module` か `resource` ブロックを持つ `*.tf` のディレクトリを探す。
ほかから `source = "./..."` で呼ばれているディレクトリ（＝モジュール）は除き、名前が `dev*` のものを優先（無ければ `staging` / `prod` など環境名、さらに無ければアルファベット順の最初）。選んだ root は info ログに出る。

## 読み方

- root の `*.tf`（`.terraform/` などは見ない）を読み、`module` の `source` がローカルパス（`./` `../`）なら再帰的に読む（深さ 5 まで）。レジストリ / git の source は warn を出して読まない。
- ノード ID: root のリソースは `infra:<name>`、モジュールのリソースは `infra:<module>/<name>`（入れ子は `infra:a/b/<name>`。`<module>` は呼び出し名）。同じモジュールで型違いの同名リソースが両方ノードになると、末尾が `<type>.<name>` になる。
- `meta.infra: { type, logicalId, path, stack, module? }`。`path` は Terraform のアドレス（`module.a.aws_x.name`）、`stack` は root ディレクトリ名（例 `dev`）。
- `file` / `line`: `resource "<type>" "<name>"` の行（hcl2json は行を持たないので、読んだ .tf を grep する）。`code` はそのブロック（最大 25 行）。

## 参照の解決

モジュールごとの環境で、式の中のトークンを置き換える（最大 5 段）。最後にリソース参照（`aws_x.y.attr`）にたどり着けば tf-graph がエッジにする。

- `var.x` → そのモジュールを呼んでいる `module` ブロックの引数の式（呼び出し側のスコープ）。root では `terraform.tfvars` / `*.auto.tfvars` のリテラル、無ければ `variable` の `default`
- `local.x` → `locals` の式
- `module.m.out` → モジュール m の `output "out"` の `value`
- 別のモジュールの式を持ち込むときは、中の参照を `mod:<module>:` で修飾する（`${mod:aurora:aws_secretsmanager_secret.this.arn}`）。だからモジュールをまたぐエッジが張れる（例: Lambda の環境変数 `var.db_secret_arn` → root の `module.aurora.secret_arn` → aurora の `aws_secretsmanager_secret`）。
- 解決できないトークン（値の無い変数、`data.*` 経由など）は無視し、debug ログに件数を出す。名前が式のまま残ったノードは論理 ID で表示する。

## 制限

- `count` / `for_each` のインスタンスは区別しない（ブロック 1 つ = ノード 1 つ）。
- `terraform_remote_state` や別 root のリソースはたどらない。
- 関数（`merge` / `lookup` など）は中の参照だけを見る。`merge(...)` の中の環境変数は、ラベルが `environment.variables` になる。
