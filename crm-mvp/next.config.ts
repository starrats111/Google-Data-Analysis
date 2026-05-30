import type { NextConfig } from "next";
import { execSync } from "child_process";

const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  // D-057: 允许部署时把构建产物写到临时目录（如 .next.tmp）再原子切换，
  // 使旧 .next 在整个构建期间继续对外服务，消除部署期 chunk 404 窗口。
  distDir: process.env.NEXT_DIST_DIR || ".next",

  generateBuildId: async () => {
    try {
      return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    } catch {
      return `build-${Date.now()}`;
    }
  },

  typescript: {
    ignoreBuildErrors: true,
  },
  // C-111 v3：切回 webpack 后必须把 puppeteer 链等含动态 require 的 server-only
  // 包外部化，否则 webpack 静态分析失败 ("Cannot statically analyse require(…, …)")。
  serverExternalPackages: [
    "bcryptjs",
    "jsonwebtoken",
    "ssh2",
    "google-ads-api",
    "google-auth-library",
    "puppeteer",
    "puppeteer-core",
    "puppeteer-extra",
    "puppeteer-extra-plugin",
    "puppeteer-extra-plugin-stealth",
    "clone-deep",
    "merge-deep",
    // D-066：tesseract.js 必须外部化，否则 webpack 把它打进 .next/，
    // 其 worker 入口路径被算成 .next/worker-script/node/index.js（不存在）→
    // worker 线程加载失败抛 uncaughtException 中断在途生成 + OCR 过滤永久失效。
    "tesseract.js",
  ],

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

  // ─── experimental 配置 ───
  // C-111 / D-046.A 1.B 修复：删除 optimizePackageImports
  // 真因：Next.js 16 默认 Turbopack 生产构建，与 optimizePackageImports（Next 15 webpack 时代优化）
  //       叠加时打包遗漏 antd 内部子 module（244451 Spin / 829672 / 836938 / 271645），
  //       导致懒加载 chunk 抛 ChunkLoadError → 前端 client-side exception。
  //       Antd v6 自身已支持 ESM tree-shaking，移除该配置后 bundle 仅增 5-10%。
  experimental: {
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
