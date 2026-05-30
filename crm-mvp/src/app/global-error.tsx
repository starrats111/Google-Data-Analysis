"use client";

import { useEffect } from "react";

// D-056: 根级（global-error）自愈。Next.js 中 user/error.tsx、admin/error.tsx 只能捕获各自
// 段内错误；根布局 / 首页 / 登录页 / 段边界挂载前抛出的客户端异常会落到内置 global-error，
// 显示 "Application error: a client-side exception has occurred"，且没有任何自动刷新 → 用户卡死。
// 这里复用 D-052 的过期部署判定：检测到 ChunkLoadError / Server Action 失效即自动刷新一次拿最新
// bundle（sessionStorage 10s 节流防坏部署无限刷新）。global-error 会替换根布局，故自带 <html>/<body>。
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
    const msg = String(error?.message || "");
    const isStaleDeployError =
      error?.name === "ChunkLoadError" ||
      /Loading chunk [\w-]+ failed|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Failed to find Server Action|from an older or newer deployment/i.test(msg);
    if (isStaleDeployError && typeof window !== "undefined") {
      const KEY = "__chunk_reloaded_at";
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last > 10000) {
        sessionStorage.setItem(KEY, String(Date.now()));
        window.location.reload();
      }
    }
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
          background: "#f5f5f5",
          color: "#333",
        }}
      >
        <div style={{ textAlign: "center", padding: "24px", maxWidth: 480 }}>
          <h2 style={{ fontSize: 20, marginBottom: 12 }}>页面加载出错了</h2>
          <p style={{ color: "#888", marginBottom: 24, lineHeight: 1.6 }}>
            可能是版本更新导致，正在尝试自动刷新；若未恢复请手动刷新页面。
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              onClick={() => reset()}
              style={{
                padding: "8px 20px",
                border: "none",
                borderRadius: 6,
                background: "#1677ff",
                color: "#fff",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              重试
            </button>
            <button
              onClick={() => (window.location.href = "/")}
              style={{
                padding: "8px 20px",
                border: "1px solid #d9d9d9",
                borderRadius: 6,
                background: "#fff",
                color: "#333",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              刷新首页
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
