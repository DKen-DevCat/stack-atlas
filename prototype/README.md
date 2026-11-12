# prototype/

`stack-atlas.html` は、ビルド不要の単一ファイルのプロトタイプ。three.js r160 を jsDelivr から読み込む。

ほかに 2 つのモックがある。

| ファイル | 中身 |
|---|---|
| `dataflow-mock.html` | 箱・口・項目・線の配線図のモック（Phase 8。設計は `docs/15`） |
| `entrance-mock.html` | 画面から始める入口のモック（Phase 10。設計は `docs/25` §3.5）。左に画面、右に挙動の一覧と、選んだ挙動の経路。ビルドも HTTP サーバーも要らず、ファイルをブラウザで開けば動く。画面もデータも手で書いたもので、箱の下のファイル名と行は、試しに読んだ小さな OSS のもの |

`live/` は、本物のアプリを操作しながら流れを追う「ライブ」の試し（Phase 10-2 の前の確かめ。`live/README.md`）。

以下は `stack-atlas.html` の説明。

## 動かし方

```bash
cd prototype
python3 -m http.server 8000   # ES Modules と importmap を使うので file:// ではなく HTTP で開く
# http://localhost:8000/stack-atlas.html
```

## コードの構成（上から順）

| ブロック | 内容 |
|---|---|
| `LAYERS` / `KIND` | 層の定義、ノードの種類ごとの色と形 |
| `NODES` / `EDGES` | サンプル構成のデータ（手書き） |
| `CACHE` / `TONE` | キャッシュ情報 |
| `FLOWS` | データフロー 3 種 |
| `SCREENS` | ダミー画面の Canvas 描画関数。`R.push({c, x, y, w, h})` で領域を登録する |
| three setup 〜 nodes | シーン、層の板、ノード（画面ノードは pivot グループ＋フレーム＋CanvasTexture） |
| `layout()` | explode に応じた配置と、線の再計算 |
| `closure()` / `applyState()` | ハイライト規則（`docs/05-viewer-spec.md` 参照） |
| panel | 詳細パネル、メモ、スクショ差し替え |
| data flow | CatmullRom 曲線と粒子 |
| picking | レイキャスト。画面ノードは UV から領域を引く |

データは `node scripts/export-prototype-data.mjs` で graph.json 形式に書き出せる（`examples/race-site.graph.json`）。

## 既知の制約

- データ・座標・ダミー画面はすべてこのサンプル専用
- メモとスクショは localStorage（ブラウザ単位）
- ノード数が数百を超えると、ラベル（DOM）の数が重くなる見込み
