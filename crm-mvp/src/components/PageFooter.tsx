"use client";

import { Space } from "antd";
import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import { MARKETING, MK_SPACING } from "@/styles/marketingTokens";

const i18n = {
  en: {
    about: "About Us",
    demo: "Platform Demo",
    contact: "Contact Us",
    privacy: "Privacy Policy",
    terms: "Terms of Service",
    company: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    tagline: "Affiliate marketing × Google Ads automation",
    copyright: "© 2026 Wenzhou Fengdu Advertising & Media Co., Ltd. All rights reserved.",
    columnProduct: "Product",
    columnLegal: "Legal",
    columnContact: "Contact",
  },
  zh: {
    about: "关于我们",
    demo: "平台演示",
    contact: "联系我们",
    privacy: "隐私政策",
    terms: "服务条款",
    company: "温州丰度广告传媒有限公司",
    tagline: "联盟营销 × Google Ads 自动化",
    copyright: "© 2026 温州丰度广告传媒有限公司 版权所有",
    columnProduct: "产品",
    columnLegal: "法律",
    columnContact: "联系",
  },
} as const;

const linkStyle: React.CSSProperties = {
  color: MARKETING.textSub,
  fontSize: 14,
  lineHeight: 2.1,
  textDecoration: "none",
};

const columnTitleStyle: React.CSSProperties = {
  color: MARKETING.text,
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  marginBottom: 12,
};

export default function PageFooter() {
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <footer
      style={{
        marginTop: MK_SPACING.xl,
        borderTop: `1px solid ${MARKETING.border}`,
        background: MARKETING.bgSection,
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: `${MK_SPACING.lg}px ${MK_SPACING.md}px ${MK_SPACING.md}px`,
          display: "grid",
          gridTemplateColumns: "minmax(220px,1.4fr) repeat(3,minmax(140px,1fr))",
          gap: MK_SPACING.lg,
        }}
        className="footer-grid"
      >
        {/* 品牌列 */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "linear-gradient(135deg,#0F4C35 0%,#1A7A50 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: MARKETING.shadowSoft,
              }}
              aria-hidden="true"
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                <path d="M3 14 L9 4 L15 14 Z" fill="white" opacity="0.9" />
                <circle cx="9" cy="13.5" r="1.5" fill="#4ADE80" />
              </svg>
            </div>
            <span style={{ fontSize: 16, fontWeight: 700, color: MARKETING.text, letterSpacing: 0.3 }}>
              fengdu-ads
            </span>
          </div>
          <div style={{ fontSize: 13, color: MARKETING.textMuted, marginBottom: 6, lineHeight: 1.5 }}>
            {t.company}
          </div>
          <div style={{ fontSize: 13, color: MARKETING.textMuted, fontStyle: "italic" }}>
            {t.tagline}
          </div>
        </div>

        {/* 产品列 */}
        <div>
          <div style={columnTitleStyle}>{t.columnProduct}</div>
          <Space direction="vertical" size={0}>
            <Link href="/" style={linkStyle}>Home</Link>
            <Link href="/demo" style={linkStyle}>{t.demo}</Link>
            <Link href="/about" style={linkStyle}>{t.about}</Link>
          </Space>
        </div>

        {/* 法律列 */}
        <div>
          <div style={columnTitleStyle}>{t.columnLegal}</div>
          <Space direction="vertical" size={0}>
            <Link href="/privacy-policy" style={linkStyle}>{t.privacy}</Link>
            <Link href="/terms-of-service" style={linkStyle}>{t.terms}</Link>
          </Space>
        </div>

        {/* 联系列 */}
        <div>
          <div style={columnTitleStyle}>{t.columnContact}</div>
          <Space direction="vertical" size={0}>
            <Link href="/contact" style={linkStyle}>{t.contact}</Link>
            <a href="mailto:connect@fengdu-ads.top" style={linkStyle}>connect@fengdu-ads.top</a>
            <a href="https://fengdu-ads.top" target="_blank" rel="noopener noreferrer" style={linkStyle}>
              fengdu-ads.top
            </a>
          </Space>
        </div>
      </div>

      <div
        style={{
          borderTop: `1px solid ${MARKETING.border}`,
          padding: `${MK_SPACING.sm}px ${MK_SPACING.md}px`,
          textAlign: "center",
          fontSize: 12,
          color: MARKETING.textMuted,
        }}
      >
        {t.copyright}
      </div>

      <style jsx>{`
        @media (max-width: 720px) {
          :global(.footer-grid) {
            grid-template-columns: 1fr 1fr !important;
          }
        }
      `}</style>
    </footer>
  );
}
