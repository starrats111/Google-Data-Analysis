import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import ThemeProvider from "@/components/ThemeProvider";
import { LanguageProvider } from "@/contexts/LanguageContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ad Automation CRM — Google Ads API Management Platform | Wenzhou Fengdu Advertising & Media",
  description:
    "Ad Automation CRM by Wenzhou Fengdu Advertising & Media Co., Ltd. An internal tool using Google Ads API v23 (searchStream + mutate) to manage Search campaigns across 15+ MCC sub-accounts for affiliate merchants from CollabGlow, Partnermatic, LinkHaiTao and other networks. Internal use only.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <ThemeProvider>
            <LanguageProvider>{children}</LanguageProvider>
          </ThemeProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
