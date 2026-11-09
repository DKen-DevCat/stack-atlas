// Command go-types-helper は Stack Atlas の go-types 抽出器（言語アダプタ。docs/17 §3.3・§7）が `go run .` で動かす
// 標準ライブラリだけのプログラム。解析対象の Go モジュールを go/parser と go/types で読み、関数の単位の箱・口・項目・links と
// 同じ言語の中の線（呼び出し・戻り）を JSON で標準出力に書く。
//
// 安全のための約束（docs/17 §7 #7・#8）:
//   - 解析対象のコードは実行しない。対象に go build / go test / go generate / go list を走らせない（go/build の Import も
//     モジュールの中のパッケージには使わない。モジュールが有効だと go list を呼ぶため）
//   - import は自前の ImporterFrom で解く: モジュールの中・`replace => ./dir`・vendor は go/parser と go/types で読み、
//     標準ライブラリは GOROOT のソースから読む（全体で 1 つの共有の読み込み器）。それ以外の外部モジュールは即エラーを返し、
//     go/types に偽のパッケージとして扱わせて検査を続ける（その型の項目は wireType unknown）
//   - シンボリックリンクでモジュールの根の外へは出ない。ファイルの数と大きさに上限がある
//
// 使い方: go run . -root <モジュールの根> [-entry cmd/api ...] [-depth 2] [-max-items 200]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

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
	)
	flag.StringVar(&root, "root", "", "解析対象のモジュールの根（go.mod のあるディレクトリ）")
	flag.Var(&entries, "entry", "入口のパッケージ（モジュール相対のディレクトリ。複数可）")
	flag.IntVar(&depth, "depth", 2, "型の展開の深さ")
	flag.IntVar(&maxItems, "max-items", 200, "1 箱の項目の上限")
	flag.IntVar(&maxFiles, "max-files", 5000, "読む .go ファイルの上限（標準ライブラリを除く）")
	flag.Int64Var(&maxBytes, "max-bytes", 64<<20, "読む .go ファイルの合計の上限（標準ライブラリを除く）")
	flag.Int64Var(&maxFile, "max-file-bytes", 2<<20, "1 ファイルの大きさの上限")
	flag.Parse()
	if root == "" {
		fmt.Fprintln(os.Stderr, "go-types-helper: -root が要ります")
		os.Exit(2)
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
	a := newAnalyzer(l, options{depth: depth, maxItems: maxItems, entries: entries})
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
