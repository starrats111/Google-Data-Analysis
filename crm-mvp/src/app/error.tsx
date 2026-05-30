"use client";

import { Button, Result } from "antd";
import { useEffect } from "react";

// D-056: 根段错误边界。覆盖首页 / 登录页 / 其它根级页面（不在 user/admin 段内）的客户端异常，
// 在落到 global-error 之前先行自愈。判定逻辑与 D-052 一致：过期部署（ChunkLoadError / Server
// Action 失效）自动刷新一次拿最新 bundle（sessionStorage 10s 节流防无限刷新）。
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[RootError]", error);
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
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <Result
        status="error"
        title="页面出错了"
        subTitle={process.env.NODE_ENV === "development" ? error.message : "可能是版本更新导致，正在尝试自动刷新；若未恢复请手动刷新页面"}
        extra={[
          <Button key="retry" type="primary" onClick={reset}>
            重试
          </Button>,
          <Button key="home" onClick={() => (window.location.href = "/")}>
            刷新首页
          </Button>,
        ]}
      />
    </div>
  );
}
