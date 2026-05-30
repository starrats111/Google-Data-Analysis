"use client";

import { Button, Result } from "antd";
import { useEffect } from "react";

export default function UserError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 生产环境可接入 Sentry 等错误监控
    console.error("[UserError]", error);
    // C-113 / D-052: 部署后老标签页失效错误自动恢复 —— 新版本部署后：
    //   ① chunk hash 变化 → 加载不到旧 chunk → ChunkLoadError
    //   ② Server Action ID 变化 → 旧标签页调用旧 action → "Failed to find Server Action"
    // 两者都属"客户端版本过期"，唯一正解就是刷新拿最新 bundle。检测到后自动刷新一次，
    // 用 sessionStorage 节流（10s 内只刷一次），防止坏部署导致无限刷新死循环。
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
          <Button key="home" onClick={() => (window.location.href = "/user/merchants")}>
            返回首页
          </Button>,
        ]}
      />
    </div>
  );
}
