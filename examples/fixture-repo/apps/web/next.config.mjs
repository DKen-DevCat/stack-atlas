/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lambda Web Adapter 用に standalone 出力（.next/standalone.zip にして Lambda へ）
  output: "standalone",
  // incrementalCache はデフォルトのファイルシステム（Lambda では /tmp）のまま。
  // cacheHandler は未設定 → cache 抽出器が warn を出す想定。
};

export default nextConfig;
