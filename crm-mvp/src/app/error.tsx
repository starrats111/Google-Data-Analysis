"use client";

import { Button, Result } from "antd";
import { useEffect } from "react";
import { hardReloadBustingCache, isStaleDeployError, tryAutoRecoverStaleDeploy } from "@/lib/stale-deploy";

// D-056 / D-158: 根段错误边界。覆盖首页 / 登录页 / 其它根级页面（不在 user/admin 段内）的客户端异常，
// 在落到 global-error 之前先行自愈。过期部署（ChunkLoadError / Server Action 失效）自动缓存穿透硬刷新。
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = isStaleDeployError(error);
  useEffect(() => {
    console.error("[RootError]", error);
    if (isStaleDeployError(error)) tryAutoRecoverStaleDeploy();
  }, [error]);

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
      <Result
        status="error"
        title="页面出错了"
        subTitle={
          process.env.NODE_ENV === "development"
            ? error.message
            : stale
              ? "检测到版本已更新，正在自动刷新；若未恢复请点「重试」"
              : "可能是版本更新导致，正在尝试自动刷新；若未恢复请手动刷新页面"
        }
        extra={[
          <Button key="retry" type="primary" onClick={() => (stale ? hardReloadBustingCache() : reset())}>
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
