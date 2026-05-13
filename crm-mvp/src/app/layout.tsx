import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import ThemeProvider from "@/components/ThemeProvider";
import { LanguageProvider } from "@/contexts/LanguageContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ad Automation CRM — Google Ads API Management Platform | Wenzhou Fengdu Advertising & Media",
  description:
    "Ad Automation CRM by Wenzhou Fengdu Advertising & Media Co., Ltd. — an in-house tool using Google Ads API v23 (searchStream + mutate) to manage our own Google Search and Performance Max campaigns under our own MCC. All advertising spend is funded directly by our company. Internal use only; not offered as a service to third parties.",
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
