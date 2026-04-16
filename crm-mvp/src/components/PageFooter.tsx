"use client";

import { Typography, Space, Divider } from "antd";
import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";

const { Paragraph } = Typography;

const links = {
  en: { about: "About Us", demo: "Platform Demo", privacy: "Privacy Policy", terms: "Terms of Service" },
  zh: { about: "关于我们", demo: "平台演示", privacy: "隐私政策", terms: "服务条款" },
};

export default function PageFooter() {
  const { lang } = useLanguage();
  const t = links[lang];

  return (
    <div style={{ textAlign: "center", padding: "30px 20px", borderTop: "1px solid #f0f0f0" }}>
      <Paragraph style={{ color: "#999", marginBottom: 8 }}>
        {lang === "en"
          ? "© 2026 Wenzhou Fengdu Advertising & Media Co., Ltd. All rights reserved."
          : "© 2026 温州丰度广告传媒有限公司 版权所有"}
      </Paragraph>
      <Space split={<Divider type="vertical" />} size={4}>
        <Link href="/about" style={{ color: "#999", fontSize: 13 }}>{t.about}</Link>
        <Link href="/demo" style={{ color: "#999", fontSize: 13 }}>{t.demo}</Link>
        <Link href="/privacy-policy" style={{ color: "#999", fontSize: 13 }}>{t.privacy}</Link>
        <Link href="/terms-of-service" style={{ color: "#999", fontSize: 13 }}>{t.terms}</Link>
      </Space>
    </div>
  );
}
