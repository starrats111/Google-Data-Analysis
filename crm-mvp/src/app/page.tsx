"use client";

import { Button, Typography, Space } from "antd";
import {
  RocketOutlined,
  ShopOutlined,
  FileTextOutlined,
  BarChartOutlined,
  SettingOutlined,
  UserOutlined,
  PlayCircleOutlined,
  ContactsOutlined,
  CheckCircleOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";
import { MARKETING, MK_SPACING, MK_FONT, MK_RADIUS } from "@/styles/marketingTokens";

const { Title, Paragraph, Text } = Typography;

const i18n = {
  en: {
    heroEyebrow: "Affiliate marketing · Google Ads automation",
    heroTitle: "Ad Automation CRM",
    heroDesc:
      "Wenzhou Fengdu Advertising & Media Co., Ltd. is an affiliate marketing company. Our internal team uses this in-house platform to manage Google Ads Search and Performance Max campaigns under our own MCC — all advertising budgets are paid by our company directly to Google. We do not manage campaigns on behalf of third-party clients.",
    heroNote:
      "Used exclusively by our internal advertising team — not offered as a service or product to any third party. All campaigns comply with the Google Ads Affiliate Program Policy.",
    aboutLink: "Read company background →",
    btnUser: "User Portal",
    btnAdmin: "Admin Console",
    btnDemo: "Platform Demo",
    btnContact: "Contact Us",
    trustBadge1: "Google Ads API v23 Certified",
    trustBadge2: "Owned MCC · Direct billing to Google",
    trustBadge3: "Affiliate Program Policy compliant",
    apiSectionTitle: "Google Ads API v23 — How we use it",
    apiReadTitle: "Read Operations — googleAds:searchStream",
    apiReadItems: [
      "Daily campaign metrics (cost, clicks, impressions, conversions)",
      "Campaign status and budget queries via GAQL",
      "MCC child account enumeration (customer_client)",
      "CID availability checking before campaign creation",
    ],
    apiWriteTitle: "Write Operations — googleAds:mutate",
    apiWriteItems: [
      "Campaign + budget + ad group + RSA creation",
      "Keyword addition (Broad / Phrase / Exact match)",
      "Ad assets: sitelinks, callouts, promotions, price, call, snippets",
      "Real-time budget and CPC bid adjustments",
    ],
    apiFooter:
      "Managing multiple Google Ads sub-accounts under our own MCC with all advertising spend funded directly by our company. Basic Access (15,000 ops/day) required — Explorer Access quota exceeded by daily batch operations.",
    apiCta: "View Platform Demo with Screenshots →",
    capTitle: "Platform Capabilities",
    capSubtitle: "Built end-to-end for affiliate-driven Google Ads operations.",
    features: [
      { title: "Merchant & Campaign Workflow", desc: "Source partner merchants from international affiliate networks and assign campaigns to internal team members for end-to-end management." },
      { title: "Google Ads Automation", desc: "Automate the full Google Search and Performance Max lifecycle — creation, keyword setup, bidding strategy, geographic/language targeting, RSA composition, and asset management." },
      { title: "Performance & ROI Analytics", desc: "Track spend, clicks, impressions, conversions, affiliate commissions, and ROI across all campaigns in a unified real-time dashboard." },
      { title: "Content & Publishing Automation", desc: "AI-powered SEO article generation and multi-site publishing to support organic traffic alongside paid search campaigns." },
    ],
  },
  zh: {
    heroEyebrow: "联盟营销 · Google Ads 自动化",
    heroTitle: "广告自动化平台",
    heroDesc:
      "温州丰度广告传媒有限公司是一家联盟营销公司。公司内部广告团队通过本平台在我们自有的 Google Ads 经理账户（MCC）下管理 Google 搜索广告与效果最大化广告，所有广告预算均由本公司直接向 Google 支付。我们不为任何第三方客户管理广告。",
    heroNote:
      "本平台仅供公司内部广告团队使用，不向任何第三方提供产品或服务。所有广告均遵守 Google Ads 联盟营销计划政策（Affiliate Program Policy）。",
    aboutLink: "了解公司背景 →",
    btnUser: "进入用户平台",
    btnAdmin: "进入总控制台",
    btnDemo: "平台演示",
    btnContact: "联系我们",
    trustBadge1: "Google Ads API v23 认证",
    trustBadge2: "自有 MCC · Google 直接扣款",
    trustBadge3: "符合联盟营销计划政策",
    apiSectionTitle: "Google Ads API v23 — 使用方式",
    apiReadTitle: "读操作 — googleAds:searchStream",
    apiReadItems: [
      "每日广告指标（花费、点击、展示、转化）",
      "通过 GAQL 查询广告状态与预算",
      "MCC 子账户枚举（customer_client）",
      "广告创建前 CID 可用性检查",
    ],
    apiWriteTitle: "写操作 — googleAds:mutate",
    apiWriteItems: [
      "创建广告系列 + 预算 + 广告组 + RSA",
      "关键词添加（广泛 / 词组 / 完全匹配）",
      "广告素材：站内链接 / 宣传信息 / 促销 / 价格 / 致电 / 摘要",
      "实时调整预算与 CPC 出价",
    ],
    apiFooter:
      "在自有 MCC 下管理多个 Google Ads 子账户，所有广告费用由本公司直接向 Google 支付。需要 Basic Access (15,000 ops/天) —— 日常批操作早已超出 Explorer Access 配额。",
    apiCta: "查看平台演示与截图 →",
    capTitle: "平台能力",
    capSubtitle: "为联盟营销驱动的 Google Ads 运营提供端到端能力。",
    features: [
      { title: "商家与广告流程", desc: "从国际联盟网络发掘合作商家，分配给内部团队成员进行端到端的广告管理。" },
      { title: "Google Ads 智能投放", desc: "自动化 Google 搜索广告与效果最大化广告全流程 — 广告系列创建、关键词设置、出价策略、地域/语言定向、RSA 组合及素材管理。" },
      { title: "数据看板与 ROI", desc: "实时可视化看板，费用、点击、展示、转化、佣金、ROI 一目了然。" },
      { title: "内容与发布自动化", desc: "AI 自动生成 SEO 文章，支持多站点一键发布，配合付费搜索广告提升自然流量。" },
    ],
  },
} as const;

const featureIcons = [
  <ShopOutlined key="shop" />,
  <RocketOutlined key="rocket" />,
  <BarChartOutlined key="chart" />,
  <FileTextOutlined key="text" />,
];

function TrustBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        background: MARKETING.bgCard,
        border: `1px solid ${MARKETING.border}`,
        borderRadius: MK_RADIUS.pill,
        fontSize: 12.5,
        color: MARKETING.textSub,
        fontWeight: 500,
        boxShadow: MARKETING.shadowSoft,
      }}
    >
      <CheckCircleOutlined style={{ color: MARKETING.accentGreen, fontSize: 13 }} />
      {children}
    </span>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: MARKETING.bgPage, color: MARKETING.text }}>
      <PageHeader />

      {/* ─── Hero ─── */}
      <section
        style={{
          background: MARKETING.bgHeroGradient,
          padding: `${MK_SPACING.hero}px 24px ${MK_SPACING.xl}px`,
          textAlign: "center",
          borderBottom: `1px solid ${MARKETING.border}`,
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              background: MARKETING.bgCard,
              border: `1px solid ${MARKETING.border}`,
              borderRadius: MK_RADIUS.pill,
              fontSize: 13,
              color: MARKETING.primaryDark,
              fontWeight: 600,
              letterSpacing: 0.3,
              marginBottom: 24,
              boxShadow: MARKETING.shadowSoft,
            }}
          >
            <SafetyCertificateOutlined style={{ fontSize: 14 }} />
            {t.heroEyebrow}
          </div>

          <Title
            style={{
              fontSize: "clamp(36px, 6vw, 56px)",
              fontWeight: 800,
              color: MARKETING.text,
              margin: "0 0 20px",
              lineHeight: 1.1,
              letterSpacing: -0.5,
            }}
          >
            {t.heroTitle}
          </Title>

          <Paragraph
            style={{
              color: MARKETING.textSub,
              fontSize: MK_FONT.body,
              maxWidth: 760,
              margin: "0 auto 16px",
              lineHeight: 1.7,
            }}
          >
            {t.heroDesc}
          </Paragraph>
          <Paragraph
            style={{
              color: MARKETING.textMuted,
              fontSize: MK_FONT.bodySmall,
              maxWidth: 720,
              margin: "0 auto 32px",
              lineHeight: 1.65,
            }}
          >
            {t.heroNote}{" "}
            <a href="/about" style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>
              {t.aboutLink}
            </a>
          </Paragraph>

          {/* 信任徽章 */}
          <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap", marginBottom: 36 }}>
            <TrustBadge>{t.trustBadge1}</TrustBadge>
            <TrustBadge>{t.trustBadge2}</TrustBadge>
            <TrustBadge>{t.trustBadge3}</TrustBadge>
          </div>

          {/* CTA 按钮组 */}
          <Space size={12} wrap style={{ justifyContent: "center" }}>
            <Button
              type="primary"
              size="large"
              icon={<UserOutlined />}
              onClick={() => router.push("/user/login")}
              style={{
                height: 48,
                paddingInline: 28,
                fontSize: 15,
                fontWeight: 600,
                borderRadius: MK_RADIUS.md,
                boxShadow: "0 4px 14px rgba(26,127,219,0.32)",
              }}
            >
              {t.btnUser}
            </Button>
            <Button
              size="large"
              icon={<SettingOutlined />}
              onClick={() => router.push("/admin/login")}
              style={{
                height: 48,
                paddingInline: 24,
                fontSize: 15,
                borderRadius: MK_RADIUS.md,
                borderColor: MARKETING.border,
                color: MARKETING.text,
              }}
            >
              {t.btnAdmin}
            </Button>
            <Button
              size="large"
              icon={<PlayCircleOutlined />}
              onClick={() => router.push("/demo")}
              style={{
                height: 48,
                paddingInline: 24,
                fontSize: 15,
                borderRadius: MK_RADIUS.md,
                borderColor: MARKETING.border,
                color: MARKETING.text,
              }}
            >
              {t.btnDemo}
            </Button>
            <Button
              size="large"
              icon={<ContactsOutlined />}
              onClick={() => router.push("/contact")}
              style={{
                height: 48,
                paddingInline: 24,
                fontSize: 15,
                fontWeight: 600,
                borderRadius: MK_RADIUS.md,
                background: MARKETING.accentGreen,
                borderColor: MARKETING.accentGreen,
                color: "#fff",
                boxShadow: "0 4px 14px rgba(34,197,94,0.28)",
              }}
            >
              {t.btnContact}
            </Button>
          </Space>
        </div>
      </section>

      {/* ─── Google Ads API Integration Evidence Block（给 Google 审核员看）─── */}
      <section
        style={{
          background: MARKETING.bgSection,
          padding: `${MK_SPACING.xl}px 24px`,
          borderBottom: `1px solid ${MARKETING.border}`,
        }}
      >
        <div style={{ maxWidth: 1060, margin: "0 auto" }}>
          <Title
            level={2}
            style={{
              fontSize: MK_FONT.sectionTitle,
              fontWeight: 700,
              color: MARKETING.text,
              textAlign: "center",
              margin: `0 0 ${MK_SPACING.lg}px`,
              letterSpacing: -0.3,
            }}
          >
            {t.apiSectionTitle}
          </Title>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: MK_SPACING.md,
              marginBottom: MK_SPACING.md,
            }}
          >
            {[
              { title: t.apiReadTitle, items: t.apiReadItems },
              { title: t.apiWriteTitle, items: t.apiWriteItems },
            ].map((block) => (
              <div
                key={block.title}
                style={{
                  background: MARKETING.bgCard,
                  border: `1px solid ${MARKETING.border}`,
                  borderRadius: MK_RADIUS.lg,
                  padding: MK_SPACING.md,
                  boxShadow: MARKETING.shadowMedium,
                }}
              >
                <Text strong style={{ fontSize: 15, color: MARKETING.primaryDark, display: "block", marginBottom: 10 }}>
                  {block.title}
                </Text>
                <ul style={{ margin: 0, paddingLeft: 20, color: MARKETING.textSub, fontSize: 13.5, lineHeight: 1.9 }}>
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div style={{ textAlign: "center", color: MARKETING.textMuted, fontSize: 13, lineHeight: 1.7 }}>
            {t.apiFooter}{" "}
            <a href="/demo" style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>{t.apiCta}</a>
          </div>
        </div>
      </section>

      {/* ─── Platform Capabilities ─── */}
      <section style={{ padding: `${MK_SPACING.xl}px 24px ${MK_SPACING.hero}px` }}>
        <div style={{ maxWidth: 1060, margin: "0 auto" }}>
          <Title
            level={2}
            style={{
              fontSize: MK_FONT.sectionTitle,
              fontWeight: 700,
              color: MARKETING.text,
              textAlign: "center",
              margin: `0 0 12px`,
              letterSpacing: -0.3,
            }}
          >
            {t.capTitle}
          </Title>
          <Paragraph
            style={{
              color: MARKETING.textMuted,
              fontSize: MK_FONT.body,
              textAlign: "center",
              maxWidth: 600,
              margin: `0 auto ${MK_SPACING.lg}px`,
            }}
          >
            {t.capSubtitle}
          </Paragraph>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: MK_SPACING.md,
            }}
          >
            {t.features.map((f, i) => (
              <div
                key={f.title}
                className="feature-card"
                style={{
                  background: MARKETING.bgCard,
                  border: `1px solid ${MARKETING.border}`,
                  borderRadius: MK_RADIUS.lg,
                  padding: MK_SPACING.md,
                  boxShadow: MARKETING.shadowMedium,
                  transition: "transform 0.2s ease, box-shadow 0.2s ease",
                  cursor: "default",
                }}
              >
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: MK_RADIUS.md,
                    background: MARKETING.primaryLight,
                    color: MARKETING.primaryDark,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 22,
                    marginBottom: 16,
                  }}
                >
                  {featureIcons[i]}
                </div>
                <Title
                  level={3}
                  style={{ margin: "0 0 8px", fontSize: MK_FONT.cardTitle, color: MARKETING.text, fontWeight: 700 }}
                >
                  {f.title}
                </Title>
                <Paragraph style={{ margin: 0, color: MARKETING.textSub, fontSize: 14, lineHeight: 1.7 }}>
                  {f.desc}
                </Paragraph>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageFooter />

      <style jsx>{`
        :global(.feature-card:hover) {
          transform: translateY(-3px);
          box-shadow: ${MARKETING.shadowHover};
        }
      `}</style>
    </div>
  );
}
