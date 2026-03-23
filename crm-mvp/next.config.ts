import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ["bcryptjs", "jsonwebtoken", "ssh2", "google-ads-api", "google-auth-library"],

  // ─── 安全头部 ───
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
        ],
      },
      {
        source: "/api/(.*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },

  // ─── 压缩 ───
  compress: true,

  // ─── 2核2G 服务器构建优化 ───
  compiler: {
    removeConsole: isProd ? { exclude: ["error", "warn"] } : false,
  },

  // 生产环境关闭浏览器 source map — 节省 ~30% 构建内存和磁盘
  productionBrowserSourceMaps: false,

  // ─── 包导入优化 — 按需加载，减少 bundle 体积 ───
  experimental: {
    optimizePackageImports: ["antd", "@ant-design/icons", "recharts", "dayjs"],
    serverActions: {
      bodySizeLimit: '5mb',
    },
  },

  // ─── 日志 — 生产环境关闭，节省内存 ───
  ...(isProd ? {} : {
    logging: {
      fetches: { fullUrl: true },
    },
  }),

  // ─── 静态资源缓存 — 减少重复请求 ───
  async rewrites() {
    return [];
  },
};

export default nextConfig;
