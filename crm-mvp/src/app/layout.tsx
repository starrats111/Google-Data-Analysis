import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import ThemeProvider from "@/components/ThemeProvider";
import { LanguageProvider, type Lang } from "@/contexts/LanguageContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ad Automation CRM — Google Ads API Management Platform | Wenzhou Fengdu Advertising & Media",
  description:
    "Ad Automation CRM by Wenzhou Fengdu Advertising & Media Co., Ltd. — an in-house tool using Google Ads API v23 (searchStream + mutate) to manage our own Google Search and Performance Max campaigns under our own MCC. All advertising spend is funded directly by our company. Internal use only; not offered as a service to third parties.",
};

// C-080：SSR 时决定营销页面的首屏语言；cookie 优先（用户主动选过），其次 Accept-Language（首次访问）
async function resolveInitialLang(): Promise<Lang> {
  try {
    const cookieStore = await cookies();
    const cookieLang = cookieStore.get("lang")?.value;
    if (cookieLang === "zh" || cookieLang === "en") return cookieLang;

    const headerStore = await headers();
    const accept = headerStore.get("accept-language") || "";
    // 简单匹配：浏览器偏好里出现 zh 即视为中文用户
    if (/\bzh\b/i.test(accept)) return "zh";
  } catch {
    // 在某些 edge / preview 环境 cookies()/headers() 可能不可用，回退英文
  }
  return "en";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const initialLang = await resolveInitialLang();
  return (
    <html lang={initialLang === "zh" ? "zh-CN" : "en"}>
      <body>
        <AntdRegistry>
          <ThemeProvider>
            <LanguageProvider initialLang={initialLang}>{children}</LanguageProvider>
          </ThemeProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
