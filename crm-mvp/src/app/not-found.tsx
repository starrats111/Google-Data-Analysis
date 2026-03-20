"use client";

import { Button, Result } from "antd";

export default function NotFound() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
      <Result
        status="404"
        title="页面不存在"
        subTitle="您访问的页面不存在，请检查地址是否正确"
        extra={
          <Button type="primary" onClick={() => (window.location.href = "/")}>
            返回首页
          </Button>
        }
      />
    </div>
  );
}
