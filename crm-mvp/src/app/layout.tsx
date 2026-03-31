import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import ThemeProvider from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ad Automation Platform - Wenzhou Fengdu Advertising & Media",
  description:
    "Internal advertising campaign management and reporting platform by Wenzhou Fengdu Advertising & Media Co., Ltd. Integrates with Google Ads API for campaign creation, budget optimization, performance reporting, and MCC account management.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <ThemeProvider>{children}</ThemeProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
