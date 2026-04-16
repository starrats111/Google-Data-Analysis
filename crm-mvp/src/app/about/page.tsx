"use client";

import { Typography, Space, Card, Divider } from "antd";
import {
  EnvironmentOutlined,
  MailOutlined,
  TeamOutlined,
  GlobalOutlined,
  LinkOutlined,
  DollarOutlined,
} from "@ant-design/icons";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";

const { Title, Paragraph, Text } = Typography;

const i18n = {
  en: {
    pageTitle: "About Us",
    overview: "Company Overview",
    overviewP1:
      "Wenzhou Fengdu Advertising & Media Co., Ltd. (温州丰度广告传媒有限公司) is a professional advertising technology company specializing in digital marketing solutions. We develop and operate an internal advertising campaign management and reporting platform that helps our team of advertising professionals efficiently manage Google Ads campaigns at scale.",
    overviewP2:
      "Our platform integrates with the Google Ads API to provide end-to-end campaign management capabilities, including automated campaign creation, budget and bid optimization, performance reporting and analytics, and multi-account (MCC) management. The tool is designed exclusively for use by our internal team members and is not offered as a third-party service.",
    bizTitle: "Our Business Model",
    bizP1Pre: "Wenzhou Fengdu Advertising & Media Co., Ltd. is an ",
    bizP1Bold: "affiliate marketing company",
    bizP1Post:
      ". Our business involves identifying commercial opportunities through major international affiliate networks — including Commission Junction (CJ), Impact, ShareASale, Awin, Rakuten, and others — and promoting these partner merchants by running Google Search Advertising campaigns that drive qualified traffic to their websites. We earn commissions on resulting sales or conversions.",
    bizP2:
      "Our internal team of advertising professionals manages all Google Ads campaigns in-house. To operate this affiliate marketing business at scale across multiple international markets and languages, we have developed the Ad Automation CRM — an internal platform that integrates with the Google Ads API to automate and streamline the full campaign management workflow.",
    bizP3:
      "All advertising campaigns are run exclusively by our internal employees. We do not offer advertising management or this platform as a service to third-party clients.",
    capTitle: "Platform Capabilities",
    capIntro:
      "Our Ad Automation CRM platform provides the following capabilities to support our affiliate marketing operations:",
    caps: [
      { bold: "Affiliate Merchant Management", text: " — Source and manage partner merchants from 7 major international affiliate networks; assign merchants to team members and track campaign status." },
      { bold: "Google Ads Campaign Automation", text: " — Automated creation and management of Google Search campaigns, including budget allocation, bidding strategies (Manual CPC, Target CPA, Maximize Clicks), geographic and language targeting, ad groups, Responsive Search Ads, and keyword management." },
      { bold: "Budget & Bid Control", text: " — Real-time campaign budget adjustments and ad group CPC bid updates directly from our dashboard." },
      { bold: "Performance & ROI Reporting", text: " — Daily campaign performance metrics (cost, clicks, impressions, average CPC, conversions) combined with affiliate commission tracking for ROI analysis and data-driven optimization." },
      { bold: "MCC Account Management", text: " — Multi-account management under MCC manager accounts, including child account listing, availability checking, and spending attribution per merchant." },
      { bold: "Ad Asset Management", text: " — Creation and management of campaign-level assets including sitelinks, callouts, promotions, price extensions, call extensions, structured snippets, and image assets." },
      { bold: "Data Synchronization", text: " — Automated daily synchronization of campaign metrics and status updates between Google Ads and our internal database." },
      { bold: "Content Automation", text: " — AI-powered SEO article generation and multi-site publishing to support organic promotion of affiliate merchants alongside paid search campaigns." },
    ],
    apiTitle: "How We Use the Google Ads API",
    apiP1:
      "Our platform integrates with the Google Ads API v23 to manage Search campaigns across multiple Google Ads accounts under our MCC manager accounts. The API is used exclusively for internal campaign management and reporting operations. Key API functions include:",
    apiItems: [
      "Creating and modifying campaigns, ad groups, Responsive Search Ads, keywords, and campaign-level assets via googleAds:mutate",
      "Querying campaign performance metrics, account information, and status via googleAds:searchStream (GAQL)",
      "Managing multiple Google Ads sub-accounts under our MCC, including child account enumeration and availability checking",
      "Performing automated daily data synchronization to update campaign metrics and status in our internal database",
    ],
    apiP2:
      "All Google Ads data accessed through the API is used solely for our internal affiliate marketing campaign management and reporting. We do not share, resell, or expose this data to external parties.",
    contactTitle: "Contact Information",
    companyLabel: "Company Name:",
    companyName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    cnLabel: "Chinese Name:",
    cnName: "温州丰度广告传媒有限公司",
    addrLabel: "Address:",
    address: "Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County, Wenzhou, Zhejiang, China",
    emailLabel: "Email:",
    webLabel: "Website:",
  },
  zh: {
    pageTitle: "关于我们",
    overview: "公司概况",
    overviewP1:
      "温州丰度广告传媒有限公司是一家专注于数字营销解决方案的专业广告科技公司。我们自主开发并运营一套内部广告系列管理与报告平台，帮助团队高效、规模化地管理 Google Ads 广告。",
    overviewP2:
      "平台深度集成 Google Ads API，提供端到端的广告管理能力，包括自动创建广告系列、预算与出价优化、效果报告与数据分析，以及多账户（MCC）管理。该工具仅供公司内部团队使用，不对外提供服务。",
    bizTitle: "商业模式",
    bizP1Pre: "温州丰度广告传媒有限公司是一家",
    bizP1Bold: "联盟营销公司",
    bizP1Post:
      "。我们通过国际主流联盟网络——包括 Commission Junction (CJ)、Impact、ShareASale、Awin、Rakuten 等——发现商业机会，并为合作商家投放 Google 搜索广告，引导精准流量到其网站，从中赚取销售或转化佣金。",
    bizP2:
      "公司广告团队全部由内部员工管理所有 Google Ads 广告系列。为了在多个国际市场和语言环境下规模化运营联盟营销业务，我们开发了 Ad Automation CRM——一个集成 Google Ads API 的内部平台，自动化并简化整个广告管理流程。",
    bizP3:
      "所有广告均由公司内部员工独立运营。我们不向第三方客户提供广告管理服务或本平台的使用。",
    capTitle: "平台能力",
    capIntro: "Ad Automation CRM 平台提供以下能力以支持联盟营销运营：",
    caps: [
      { bold: "商家管理", text: " — 统一管理 7 大国际联盟平台商家；将商家分配给团队成员并追踪广告状态。" },
      { bold: "Google Ads 广告自动化", text: " — 自动创建和管理 Google 搜索广告系列，包括预算分配、出价策略（手动 CPC、目标 CPA、最大化点击）、地域与语言定向、广告组、自适应搜索广告和关键词管理。" },
      { bold: "预算与出价控制", text: " — 从后台实时调整广告预算和广告组 CPC 出价。" },
      { bold: "效果与 ROI 报告", text: " — 每日广告系列效果指标（花费、点击、展示、平均 CPC、转化）结合联盟佣金追踪，支持 ROI 分析和数据驱动优化。" },
      { bold: "MCC 账户管理", text: " — 通过 MCC 管理账户进行多账户管理，包括子账户列表、可用性检查和按商家归属的花费统计。" },
      { bold: "广告素材管理", text: " — 创建和管理广告系列级别素材，包括站内链接、宣传信息、促销、价格扩展、致电扩展、结构化摘要和图片素材。" },
      { bold: "数据同步", text: " — 自动每日同步 Google Ads 广告指标和状态更新到内部数据库。" },
      { bold: "内容自动化", text: " — AI 驱动的 SEO 文章生成和多站点发布，配合付费搜索广告提升联盟商家的自然流量。" },
    ],
    apiTitle: "Google Ads API 使用说明",
    apiP1:
      "平台集成 Google Ads API v23，在 MCC 管理账户下管理多个 Google Ads 账户的搜索广告系列。API 仅用于内部广告管理和报告。主要功能包括：",
    apiItems: [
      "通过 googleAds:mutate 创建和修改广告系列、广告组、自适应搜索广告、关键词和广告素材",
      "通过 googleAds:searchStream (GAQL) 查询广告效果指标、账户信息和状态",
      "管理 MCC 下的多个子账户，包括子账户列表和可用性检查",
      "执行自动化每日数据同步，更新内部数据库中的广告指标和状态",
    ],
    apiP2:
      "通过 API 访问的所有 Google Ads 数据仅用于公司内部联盟营销广告管理和报告。我们不会向外部方共享、转售或公开这些数据。",
    contactTitle: "联系方式",
    companyLabel: "公司名称：",
    companyName: "温州丰度广告传媒有限公司",
    cnLabel: "英文名称：",
    cnName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    addrLabel: "地址：",
    address: "浙江省温州市泰顺县罗阳镇新城大道华鸿心广场29幢1110室-2",
    emailLabel: "邮箱：",
    webLabel: "网站：",
  },
};

export default function AboutPage() {
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <PageHeader showHome />

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px 80px" }}>
        <Title level={1} style={{ color: "#1A7FDB", textAlign: "center" }}>
          {t.pageTitle}
        </Title>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <TeamOutlined style={{ marginRight: 8, color: "#4DA6FF" }} />
              {t.overview}
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>{t.overviewP1}</Paragraph>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>{t.overviewP2}</Paragraph>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <DollarOutlined style={{ marginRight: 8, color: "#fa8c16" }} />
              {t.bizTitle}
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              {t.bizP1Pre}<Text strong>{t.bizP1Bold}</Text>{t.bizP1Post}
            </Paragraph>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>{t.bizP2}</Paragraph>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>{t.bizP3}</Paragraph>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <GlobalOutlined style={{ marginRight: 8, color: "#52c41a" }} />
              {t.capTitle}
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>{t.capIntro}</Paragraph>
            <ul style={{ fontSize: 16, lineHeight: 2.2, paddingLeft: 24 }}>
              {t.caps.map((c) => (
                <li key={c.bold}><Text strong>{c.bold}</Text>{c.text}</li>
              ))}
            </ul>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <LinkOutlined style={{ marginRight: 8, color: "#722ed1" }} />
              {t.apiTitle}
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>{t.apiP1}</Paragraph>
            <ul style={{ fontSize: 16, lineHeight: 2.2, paddingLeft: 24 }}>
              {t.apiItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>{t.apiP2}</Paragraph>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <EnvironmentOutlined style={{ marginRight: 8, color: "#fa8c16" }} />
              {t.contactTitle}
            </Title>
            <div>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <Text strong>{t.companyLabel}</Text> {t.companyName}
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <Text strong>{t.cnLabel}</Text> {t.cnName}
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <Text strong>{t.addrLabel}</Text> {t.address}
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <MailOutlined style={{ marginRight: 8 }} />
                <Text strong>{t.emailLabel}</Text>{" "}
                <a href="mailto:admin@fengdu-ads.top">admin@fengdu-ads.top</a>
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
                <GlobalOutlined style={{ marginRight: 8 }} />
                <Text strong>{t.webLabel}</Text>{" "}
                <a href="https://fengdu-ads.top" target="_blank" rel="noopener noreferrer">fengdu-ads.top</a>
              </Paragraph>
            </div>
          </Space>
        </Card>

        <Divider />
        <PageFooter />
      </div>
    </div>
  );
}
