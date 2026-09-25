import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // 管理PCの「PDF・画像から読み込む」でファイルを送るため（既定は1MB）
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
