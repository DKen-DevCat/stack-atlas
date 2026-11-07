# prototype/

`stack-atlas.html` は、ビルド不要の単一ファイルのプロトタイプ。three.js r160 を jsDelivr から読み込む。

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
