# 07. 既存ツール調査（2026-11-07 時点）

## 結論

「インフラからコードの型まで 1 画面で、層を 3D に重ねて表示し、ホバーで関連をハイライトし、メモも書ける」ものは見つからなかった。
近いものは、**インフラ図**・**アーキテクチャ図**・**コードのグラフ**のどれか 1 つに閉じている。全部を貫いて扱うのが Stack Atlas の差別化ポイント。

## 層ごとの近いツール

| 層 | ツール | 何ができるか | 足りない点 |
|---|---|---|---|
| インフラ | Cloudcraft（Datadog） | AWS や Azure の環境を取り込んでライブの構成図にする。アラートやコストを重ねて表示できる | コードの中までは追えない |
| アーキテクチャ | IcePanel | C4 モデルで、必要な詳細度までズームできる共同作図ツール | 図は手で描く。コードと自動でつながらない |
| アーキテクチャ | Structurizr | diagrams as code の C4 | 同上。3D でも、データフローの再生でもない |
| コード | Haystack Editor | VS Code のフォーク。関数やクラスを無限キャンバス上の有向グラフとして探索・編集できる | インフラ層がない |
| コード | CodeSee Maps | コードベースのマップを自動生成していた | 2024 年に GitKraken に買収され、単体サービスは終了 |
| コード（3D） | Orbis、GraphMyCode、CÓDIGO GPS など | リポジトリから 3D の依存グラフを描く | ファイル依存の force graph が中心で、層の考え方・画面・キャッシュはない |

## 参考にできる点

- **C4 モデル**（IcePanel、Structurizr）: 詳細度の段階を行き来するズームの考え方。Stack Atlas の層の考え方と相性がよい
- **Cloudcraft**: クラウドの API から取り込んでライブで更新する考え方、図の上に監視データを重ねる表示
- **Haystack / CodeSee**: シンボル単位でコードを地図に載せる操作感
- **GraphMyCode**: 解析をブラウザ内の WebAssembly で完結させ、コードを外に出さない設計（業務コードを扱う Stack Atlas の非機能要件と同じ方向）

## 出典

- Cloudcraft: https://docs.datadoghq.com/cloudcraft/getting-started/create-your-first-cloudcraft-diagram/
- IcePanel（Thoughtworks Technology Radar）: https://thoughtworks.com/radar/platforms/icepanel
- IcePanel のズームできる図: https://icepanel.io/blog/how-to-create-interactive-zoomable-software-architecture-diagrams
- Haystack Editor: https://dev.to/akshaysg/haystack-an-ide-for-exploring-and-editing-code-on-an-infinite-canvas-4j5h
- CodeSee の買収: https://www.schneider.im/gitkraken-acquired-codesee
- Orbis: https://dev.to/nilofer_tweets/orbis-turn-any-github-repository-into-an-interactive-3d-dependency-graph-3eei
- GraphMyCode: https://www.producthunt.com/p/graphmycode
- CÓDIGO GPS: https://gh.r-mj.com/MerariJafet/codigo-gps
