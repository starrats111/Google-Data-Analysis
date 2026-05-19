"use client";

import { Typography } from "antd";
import {
  EnvironmentOutlined,
  MailOutlined,
  TeamOutlined,
  GlobalOutlined,
  LinkOutlined,
  DollarOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";
import { MARKETING, MK_SPACING, MK_FONT, MK_RADIUS } from "@/styles/marketingTokens";

const { Title, Paragraph, Text } = Typography;

const i18n = {
  en: {
    pageTitle: "About Us",
    pageSubtitle:
      "Wenzhou Fengdu Advertising & Media — founded December 2025 — affiliate marketing × Google Ads automation.",
    overview: "Company Overview",
    overviewP1:
      "Wenzhou Fengdu Advertising & Media Co., Ltd. (温州丰度广告传媒有限公司) was founded in December 2025 and is an affiliate marketing company based in Wenzhou, Zhejiang, China. Our business model is to drive purchase-intent traffic to partner merchants' websites through Google Search and Performance Max advertising, and we earn commissions on resulting sales.",
    overviewP2:
      "All Google Ads campaigns are operated by our own internal advertising team under our own Google Ads Manager (MCC) account. All advertising budgets are paid for by our company directly to Google. We do not manage campaigns on behalf of third-party clients. All campaigns comply with the Google Ads Affiliate Program Policy.",
    bizTitle: "Our Business Model",
    bizP1Pre: "Wenzhou Fengdu Advertising & Media Co., Ltd. is an ",
    bizP1Bold: "affiliate marketing company",
    bizP1Post:
      ". We source partner merchants from international affiliate networks. Our team evaluates merchant products, selects high-intent commercial keywords, and runs Google Search and Performance Max campaigns to drive purchase-intent traffic to those merchants' websites. We earn commissions on resulting sales or conversions.",
    bizP2:
      "All Google Ads campaigns are operated by our own internal advertising team under our own Google Ads Manager (MCC) account. All advertising budgets are paid for by our company directly to Google. We do not manage campaigns on behalf of third-party clients.",
    bizP3:
      "To operate at scale across multiple international markets and languages, we developed the Ad Automation CRM — an in-house tool deployed on our own infrastructure that integrates with the Google Ads API to automate and streamline the full campaign management workflow. The tool is used exclusively by our internal employees and is not offered as a service or product to any third party. All campaigns comply with the Google Ads Affiliate Program Policy.",
    capTitle: "Platform Capabilities",
    capIntro:
      "Our in-house Ad Automation CRM provides the following capabilities to support our internal advertising operations:",
    caps: [
      { bold: "Merchant & Campaign Workflow", text: " — Source partner merchants from international affiliate networks; assign merchants to internal team members and track campaign status." },
      { bold: "Google Ads Campaign Automation", text: " — Automated creation and management of Google Search and Performance Max campaigns, including budget allocation, bidding strategies (Manual CPC, Target CPA, Maximize Clicks), geographic and language targeting, ad groups, Responsive Search Ads, and keyword management." },
      { bold: "Budget & Bid Control", text: " — Real-time campaign budget adjustments and ad group CPC bid updates directly from our internal dashboard." },
      { bold: "Performance & ROI Reporting", text: " — Daily campaign performance metrics (cost, clicks, impressions, average CPC, conversions) combined with commission tracking for ROI analysis and data-driven optimization." },
      { bold: "MCC Account Management", text: " — Multi-account management under our own MCC, including child account listing, availability checking, and spending attribution." },
      { bold: "Ad Asset Management", text: " — Creation and management of campaign-level assets including sitelinks, callouts, promotions, price extensions, call extensions, structured snippets, and image assets." },
      { bold: "Data Synchronization", text: " — Automated daily synchronization of campaign metrics and status updates between Google Ads and our internal database." },
      { bold: "Content Automation", text: " — AI-powered SEO article generation and multi-site publishing to support organic traffic alongside paid search campaigns." },
    ],
    apiTitle: "How We Use the Google Ads API",
    apiP1:
      "Our in-house tool integrates with the Google Ads API v23 to manage Search and Performance Max campaigns across our own Google Ads accounts under our own MCC. The API is used exclusively for internal campaign management and reporting. Key API functions include:",
    apiItems: [
      "Creating and modifying campaigns, ad groups, Responsive Search Ads, keywords, and campaign-level assets via googleAds:mutate",
      "Querying campaign performance metrics, account information, and status via googleAds:searchStream (GAQL)",
      "Managing multiple Google Ads sub-accounts under our own MCC, including child account enumeration and availability checking",
      "Performing automated daily data synchronization to update campaign metrics and status in our internal database",
      "Keyword planning and forecast generation via Keyword Planner for new campaign setup",
    ],
    apiP2:
      "All Google Ads data accessed through the API is used solely for our internal campaign management and reporting. We do not share, resell, or expose this data to external parties. All advertising operations comply with the Google Ads API Terms and Conditions and the Google Ads Affiliate Program Policy.",
    contactTitle: "Contact Information",
    companyLabel: "Company Name",
    companyName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    cnLabel: "Chinese Name",
    cnName: "温州丰度广告传媒有限公司",
    foundedLabel: "Founded",
    foundedValue: "December 9, 2025",
    countryLabel: "Country of Operation",
    countryValue: "China",
    addrLabel: "Address",
    address: "Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County, Wenzhou, Zhejiang, China",
    phoneLabel: "Phone (China)",
    phoneValue: "+86 13958988973",
    emailLabel: "Email",
    webLabel: "Website",
    contactCta: "Full contact details on the",
    contactCtaLink: "Contact Us",
    contactCtaSuffix: "page.",
  },
  zh: {
    pageTitle: "关于我们",
    pageSubtitle: "温州丰度广告传媒有限公司 — 成立于 2025 年 12 月 — 联盟营销 × Google Ads 自动化。",
    overview: "公司概况",
    overviewP1:
      "温州丰度广告传媒有限公司成立于 2025 年 12 月，是一家位于浙江温州的联盟营销公司。我们的商业模式是通过 Google 搜索广告与效果最大化广告，为合作商家网站引导具有购买意向的流量，并从最终销售中赚取佣金。",
    overviewP2:
      "所有 Google Ads 广告均由公司内部广告团队在我们自有的 Google Ads 经理账户（MCC）下运营，所有广告预算均由本公司直接向 Google 支付。我们不为任何第三方客户管理广告。所有广告均遵守 Google Ads 联盟营销计划政策（Affiliate Program Policy）。",
    bizTitle: "商业模式",
    bizP1Pre: "温州丰度广告传媒有限公司是一家",
    bizP1Bold: "联盟营销公司",
    bizP1Post:
      "。我们从国际联盟网络中挖掘合作商家，团队评估商家产品，挑选高购买意向的商业关键词，并投放 Google 搜索广告与效果最大化广告，将具有购买意向的流量引导至商家网站，从中赚取销售或转化佣金。",
    bizP2:
      "所有 Google Ads 广告均由公司内部广告团队在我们自有的 Google Ads 经理账户（MCC）下运营，所有广告预算均由本公司直接向 Google 支付。我们不为任何第三方客户管理广告。",
    bizP3:
      "为了在多个国际市场和语言环境下规模化运营，我们开发了 Ad Automation CRM——一个部署在我们自有基础设施上、集成 Google Ads API 的内部工具。本工具仅供公司内部员工使用，不向任何第三方提供产品或服务。所有广告均遵守 Google Ads 联盟营销计划政策。",
    capTitle: "平台能力",
    capIntro: "我们自研的 Ad Automation CRM 提供以下能力以支持内部广告运营：",
    caps: [
      { bold: "商家与广告流程", text: " — 从国际联盟网络发掘合作商家，分配给内部团队成员，追踪广告状态。" },
      { bold: "Google Ads 广告自动化", text: " — 自动创建和管理 Google 搜索广告与效果最大化广告，包括预算分配、出价策略（手动 CPC、目标 CPA、最大化点击）、地域与语言定向、广告组、自适应搜索广告和关键词管理。" },
      { bold: "预算与出价控制", text: " — 从内部后台实时调整广告预算和广告组 CPC 出价。" },
      { bold: "效果与 ROI 报告", text: " — 每日广告系列效果指标（花费、点击、展示、平均 CPC、转化）结合佣金追踪，支持 ROI 分析和数据驱动优化。" },
      { bold: "MCC 账户管理", text: " — 在我们自有的 MCC 下进行多账户管理，包括子账户列表、可用性检查和花费归属。" },
      { bold: "广告素材管理", text: " — 创建和管理广告系列级别素材，包括站内链接、宣传信息、促销、价格扩展、致电扩展、结构化摘要和图片素材。" },
      { bold: "数据同步", text: " — 自动每日同步 Google Ads 广告指标和状态更新到内部数据库。" },
      { bold: "内容自动化", text: " — AI 驱动的 SEO 文章生成和多站点发布，配合付费搜索广告提升自然流量。" },
    ],
    apiTitle: "Google Ads API 使用说明",
    apiP1:
      "我们自研的工具集成 Google Ads API v23，在我们自有的 MCC 下管理 Google 搜索广告与效果最大化广告。API 仅用于内部广告管理和报告。主要功能包括：",
    apiItems: [
      "通过 googleAds:mutate 创建和修改广告系列、广告组、自适应搜索广告、关键词和广告素材",
      "通过 googleAds:searchStream (GAQL) 查询广告效果指标、账户信息和状态",
      "在自有 MCC 下管理多个子账户，包括子账户列表和可用性检查",
      "执行自动化每日数据同步，更新内部数据库中的广告指标和状态",
      "通过 Keyword Planner 进行关键词规划与预测，用于新广告系列的搭建",
    ],
    apiP2:
      "通过 API 访问的所有 Google Ads 数据仅用于公司内部广告管理和报告。我们不会向外部方共享、转售或公开这些数据。所有广告操作均遵守 Google Ads API 条款与条件以及 Google Ads 联盟营销计划政策。",
    contactTitle: "联系方式",
    companyLabel: "公司名称",
    companyName: "温州丰度广告传媒有限公司",
    cnLabel: "英文名称",
    cnName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    foundedLabel: "成立时间",
    foundedValue: "2025 年 12 月 9 日",
    countryLabel: "运营所在国家",
    countryValue: "中国",
    addrLabel: "中国联系地址",
    address: "中国 浙江省 温州市 泰顺县 罗阳镇 新城大道 华鸿心广场 29 幢 1110 室-2",
    phoneLabel: "中国联系电话",
    phoneValue: "+86 13958988973",
    emailLabel: "电子邮箱",
    webLabel: "公司网址",
    contactCta: "更多联系方式请访问",
    contactCtaLink: "联系我们",
    contactCtaSuffix: "页面。",
  },
} as const;

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: MARKETING.bgCard,
        border: `1px solid ${MARKETING.border}`,
        borderRadius: MK_RADIUS.lg,
        padding: `${MK_SPACING.md}px ${MK_SPACING.lg}px`,
        boxShadow: MARKETING.shadowMedium,
        marginBottom: MK_SPACING.md,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: MK_RADIUS.md,
            background: MARKETING.primaryLight,
            color: MARKETING.primaryDark,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
          }}
        >
          {icon}
        </div>
        <Title
          level={2}
          style={{ margin: 0, fontSize: 22, fontWeight: 700, color: MARKETING.text }}
        >
          {title}
        </Title>
      </div>
      {children}
    </section>
  );
}

const paraStyle: React.CSSProperties = {
  fontSize: 15.5,
  lineHeight: 1.8,
  color: MARKETING.textSub,
  marginBottom: 12,
};

const infoLineStyle: React.CSSProperties = {
  display: "flex",
  padding: "8px 0",
  borderBottom: `1px solid ${MARKETING.border}`,
  gap: 12,
  fontSize: 14.5,
  color: MARKETING.text,
};

export default function AboutPage() {
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: MARKETING.bgPage, color: MARKETING.text }}>
      <PageHeader showHome />

      {/* Hero */}
      <section
        style={{
          background: MARKETING.bgHeroGradient,
          padding: `${MK_SPACING.hero}px 24px ${MK_SPACING.lg}px`,
          textAlign: "center",
          borderBottom: `1px solid ${MARKETING.border}`,
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <Title
            style={{
              fontSize: "clamp(32px, 5vw, 44px)",
              fontWeight: 800,
              color: MARKETING.text,
              margin: "0 0 12px",
              letterSpacing: -0.3,
            }}
          >
            {t.pageTitle}
          </Title>
          <Paragraph style={{ color: MARKETING.textSub, fontSize: MK_FONT.body, margin: 0, lineHeight: 1.7 }}>
            {t.pageSubtitle}
          </Paragraph>
        </div>
      </section>

      {/* Sections */}
      <div style={{ maxWidth: 880, margin: "0 auto", padding: `${MK_SPACING.lg}px 24px ${MK_SPACING.xl}px` }}>
        <Section icon={<TeamOutlined />} title={t.overview}>
          <Paragraph style={paraStyle}>{t.overviewP1}</Paragraph>
          <Paragraph style={{ ...paraStyle, marginBottom: 0 }}>{t.overviewP2}</Paragraph>
        </Section>

        <Section icon={<DollarOutlined />} title={t.bizTitle}>
          <Paragraph style={paraStyle}>
            {t.bizP1Pre}
            <Text strong style={{ color: MARKETING.text }}>{t.bizP1Bold}</Text>
            {t.bizP1Post}
          </Paragraph>
          <Paragraph style={paraStyle}>{t.bizP2}</Paragraph>
          <Paragraph style={{ ...paraStyle, marginBottom: 0 }}>{t.bizP3}</Paragraph>
        </Section>

        <Section icon={<GlobalOutlined />} title={t.capTitle}>
          <Paragraph style={paraStyle}>{t.capIntro}</Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 1.95, paddingLeft: 20, marginBottom: 0, color: MARKETING.textSub }}>
            {t.caps.map((c) => (
              <li key={c.bold} style={{ marginBottom: 8 }}>
                <Text strong style={{ color: MARKETING.text }}>{c.bold}</Text>
                {c.text}
              </li>
            ))}
          </ul>
        </Section>

        <Section icon={<LinkOutlined />} title={t.apiTitle}>
          <Paragraph style={paraStyle}>{t.apiP1}</Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 1.95, paddingLeft: 20, color: MARKETING.textSub, marginBottom: 16 }}>
            {t.apiItems.map((item) => (
              <li key={item} style={{ marginBottom: 6 }}>{item}</li>
            ))}
          </ul>
          <Paragraph style={{ ...paraStyle, marginBottom: 0 }}>{t.apiP2}</Paragraph>
        </Section>

        <Section icon={<EnvironmentOutlined />} title={t.contactTitle}>
          {[
            [t.companyLabel, t.companyName],
            [t.cnLabel, t.cnName],
            [t.foundedLabel, t.foundedValue],
            [t.countryLabel, t.countryValue],
            [t.addrLabel, t.address],
          ].map(([label, value]) => (
            <div key={label} style={infoLineStyle}>
              <div style={{ width: 160, color: MARKETING.textMuted, fontWeight: 500, flexShrink: 0 }}>
                {label}
              </div>
              <div style={{ flex: 1 }}>{value}</div>
            </div>
          ))}
          <div style={infoLineStyle}>
            <div style={{ width: 160, color: MARKETING.textMuted, fontWeight: 500, flexShrink: 0 }}>
              {t.phoneLabel}
            </div>
            <div style={{ flex: 1 }}>
              <a href={`tel:${t.phoneValue.replace(/\s/g, "")}`} style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>
                {t.phoneValue}
              </a>
            </div>
          </div>
          <div style={infoLineStyle}>
            <div style={{ width: 160, color: MARKETING.textMuted, fontWeight: 500, flexShrink: 0 }}>
              <MailOutlined style={{ marginRight: 6 }} />
              {t.emailLabel}
            </div>
            <div style={{ flex: 1 }}>
              <a href="mailto:connect@fengdu-ads.top" style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>
                connect@fengdu-ads.top
              </a>
            </div>
          </div>
          <div style={{ ...infoLineStyle, borderBottom: "none" }}>
            <div style={{ width: 160, color: MARKETING.textMuted, fontWeight: 500, flexShrink: 0 }}>
              <GlobalOutlined style={{ marginRight: 6 }} />
              {t.webLabel}
            </div>
            <div style={{ flex: 1 }}>
              <a href="https://fengdu-ads.top" target="_blank" rel="noopener noreferrer" style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>
                fengdu-ads.top
              </a>
            </div>
          </div>

          <div
            style={{
              marginTop: 16,
              padding: `10px 14px`,
              background: MARKETING.primaryLight,
              borderRadius: MK_RADIUS.md,
              fontSize: 13.5,
              color: MARKETING.primaryDark,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <InfoCircleOutlined />
            <span>
              {t.contactCta}{" "}
              <a href="/contact" style={{ color: MARKETING.primaryDark, fontWeight: 700, textDecoration: "underline" }}>
                {t.contactCtaLink}
              </a>{" "}
              {t.contactCtaSuffix}
            </span>
          </div>
        </Section>
      </div>

      <PageFooter />
    </div>
  );
}
