import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // output: "standalone",
  output: 'export',
  trailingSlash: true,
};

export default nextConfig;
