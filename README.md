# Stack Atlas

インフラ → 画面 → コンポーネント → 型 を層として 3D に積み、1 画面で依存関係・データフロー・キャッシュを追えるようにするツール（開発初期）。

![overview](docs/images/01-overview.png)

- 引き継ぎの概要: [HANDOFF.md](HANDOFF.md)
- Claude 向けの作業指示: [CLAUDE.md](CLAUDE.md)
- 動くプロトタイプ: [prototype/](prototype/)
- 仕様: [docs/](docs/)

| | |
|---|---|
| ![hover](docs/images/02-hover-component.png) | ![cache](docs/images/03-cache-flow.png) |
| 画面内の ResultTable を指すと、同じ部品を使う画面と型が光る | キャッシュモードと「閲覧 MISS」フロー |
