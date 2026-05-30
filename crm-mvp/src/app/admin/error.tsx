"use client";

import { Button, Result } from "antd";
import { useEffect } from "react";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[AdminError]", error);
    // C-113 / D-052: 部署后老标签页失效错误自动恢复（同 user/error.tsx）
    //   ① ChunkLoadError（chunk hash 变化）② "Failed to find Server Action"（action ID 变化）
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
        subTitle={process.env.NODE_ENV === "development" ? error.message : "请稍后重试或联系管理员"}
        extra={[
          <Button key="retry" type="primary" onClick={reset}>
            重试
          </Button>,
          <Button key="home" onClick={() => (window.location.href = "/admin/dashboard")}>
            返回首页
          </Button>,
        ]}
      />
    </div>
  );
}
