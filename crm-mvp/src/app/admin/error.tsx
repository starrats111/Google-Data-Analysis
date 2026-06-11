"use client";

import { Button, Result } from "antd";
import { useEffect } from "react";
import { hardReloadBustingCache, isStaleDeployError, tryAutoRecoverStaleDeploy } from "@/lib/stale-deploy";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // C-113 / D-052 / D-158: 部署后老标签页失效（ChunkLoadError / Server Action 失效）自动恢复。
  const stale = isStaleDeployError(error);
  useEffect(() => {
    console.error("[AdminError]", error);
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
              : "请稍后重试或联系管理员"
        }
        extra={[
          <Button key="retry" type="primary" onClick={() => (stale ? hardReloadBustingCache() : reset())}>
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
