"use client";

import { ConfigProvider, App } from "antd";
import zhCN from "antd/locale/zh_CN";
import themeConfig from "@/styles/themeConfig";

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <App>{children}</App>
    </ConfigProvider>
  );
}
