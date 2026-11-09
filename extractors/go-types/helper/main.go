// Command go-types-helper は Stack Atlas の go-types 抽出器（言語アダプタ。docs/17 §3.3・§7）が `go build` して動かす
// 標準ライブラリだけのプログラム（実行ファイルは利用者ごとのキャッシュに置く。src/run.ts）。解析対象の Go モジュールを go/parser と go/types で読み、関数の単位の箱・口・項目・links と
// 同じ言語の中の線（呼び出し・戻り）を JSON で標準出力に書く。
//
// 安全のための約束（docs/17 §7 #7・#8）:
//   - 解析対象のコードは実行しない。対象に go build / go test / go generate / go list を走らせない（go/build の Import も
//     モジュールの中のパッケージには使わない。モジュールが有効だと go list を呼ぶため）
//   - import は自前の ImporterFrom で解く: モジュールの中・`replace => ./dir`・vendor は go/parser と go/types で読み、
//     標準ライブラリは GOROOT のソースから読む（全体で 1 つの共有の読み込み器）。それ以外の外部モジュールは即エラーを返し、
//     go/types に偽のパッケージとして扱わせて検査を続ける（その型の項目は wireType unknown）
//   - シンボリックリンクでモジュールの根の外へは出ない。ファイルの数と大きさに上限がある
//   - 時間の上限（-timeout）を自分でも守る（TS の側が kill するのが先。これは最後の守り。超えたら終了コード 3）
//
// 使い方: go-types-helper -root <モジュールの根> [-entry cmd/api ...] [-depth 2] [-max-items 200] [-timeout 120s]
// [-schema-stdin]（標準入力から SQL のテーブルとカラムの JSON `{"tables":{"users":["id","name"]}}` を読む）
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// exitTimeout は -timeout に着いたときの終了コード（TS の側が時間の上限のエラーにする）
const exitTimeout = 3

// maxSchemaBytes は標準入力の SQL のスキーマの上限
const maxSchemaBytes = 32 << 20

// sqlSchema は SQL のテーブル（小文字の名前）→ カラム（定義の順）。TS の側がマイグレーションから作って標準入力で渡す
type sqlSchema map[string][]string

func readSchema(r io.Reader) (sqlSchema, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxSchemaBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSchemaBytes {
		return nil, fmt.Errorf("SQL のスキーマが大きすぎます（%d バイトを超える）", maxSchemaBytes)
	}
	var in struct {
		Tables map[string][]string `json:"tables"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return nil, fmt.Errorf("SQL のスキーマが読めません: %w", err)
	}
	out := sqlSchema{}
	for name, cols := range in.Tables {
		out[strings.ToLower(name)] = cols
	}
	return out, nil
}

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

func main() {
	var (
		root     string
		entries  listFlag
		depth    int
		maxItems int
		maxFiles int
		maxBytes int64
		maxFile  int64
		timeout  time.Duration
		schemaIn bool
	)
	flag.StringVar(&root, "root", "", "解析対象のモジュールの根（go.mod のあるディレクトリ）")
	flag.Var(&entries, "entry", "入口のパッケージ（モジュール相対のディレクトリ。複数可）")
	flag.IntVar(&depth, "depth", 2, "型の展開の深さ")
	flag.IntVar(&maxItems, "max-items", 200, "1 箱の項目の上限")
	flag.IntVar(&maxFiles, "max-files", 5000, "読む .go ファイルの上限（標準ライブラリを除く）")
	flag.Int64Var(&maxBytes, "max-bytes", 64<<20, "読む .go ファイルの合計の上限（標準ライブラリを除く）")
	flag.Int64Var(&maxFile, "max-file-bytes", 2<<20, "1 ファイルの大きさの上限")
	flag.DurationVar(&timeout, "timeout", 0, "時間の上限（0 は無し）。超えたら終了コード 3")
	flag.BoolVar(&schemaIn, "schema-stdin", false, "標準入力から SQL のスキーマ（JSON）を読む")
	flag.Parse()
	if timeout > 0 {
		time.AfterFunc(timeout, func() {
			fmt.Fprintf(os.Stderr, "go-types-helper: 時間の上限（%s）に着きました\n", timeout)
			os.Exit(exitTimeout)
		})
	}
	if root == "" {
		fmt.Fprintln(os.Stderr, "go-types-helper: -root が要ります")
		os.Exit(2)
	}
	var schema sqlSchema
	if schemaIn {
		var err error
		if schema, err = readSchema(os.Stdin); err != nil {
			fmt.Fprintln(os.Stderr, "go-types-helper:", err)
			os.Exit(1)
		}
	}
	started := time.Now()
	l, err := newLoader(root, limits{maxFiles: maxFiles, maxBytes: maxBytes, maxFile: maxFile})
	if err != nil {
		fmt.Fprintln(os.Stderr, "go-types-helper:", err)
		os.Exit(1)
	}
	if err := l.loadModule(); err != nil {
		fmt.Fprintln(os.Stderr, "go-types-helper:", err)
		os.Exit(1)
	}
	loaded := time.Since(started)
	a := newAnalyzer(l, options{depth: depth, maxItems: maxItems, entries: entries, schema: schema})
	out := a.run()
	out.Stats.LoadMs = loaded.Milliseconds()
	out.Stats.TotalMs = time.Since(started).Milliseconds()
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "go-types-helper:", err)
		os.Exit(1)
	}
}
