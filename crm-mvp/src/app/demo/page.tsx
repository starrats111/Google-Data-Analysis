"use client";

import { Typography, Space, Card, Divider, Tag } from "antd";
import {
  ApiOutlined,
  BarChartOutlined,
  SettingOutlined,
  CloudSyncOutlined,
  DollarOutlined,
  TeamOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import Image from "next/image";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";

const { Title, Paragraph, Text } = Typography;

interface ScreenshotItem {
  src?: string;
  images?: { src: string; caption: string }[];
  title: string;
  icon: React.ReactNode;
  apiTag: string;
  description: string;
  featuresLabel: string;
  features: string[];
}

function getScreenshots(lang: "en" | "zh"): ScreenshotItem[] {
  if (lang === "en") {
    return [
      {
        src: "/images/demo/data-center.png",
        title: "Data Center — Campaign Performance Dashboard",
        icon: <BarChartOutlined style={{ color: "#fa8c16" }} />,
        apiTag: "googleAds:searchStream",
        description:
          "Real-time campaign performance dashboard showing all Google Ads campaigns managed through our platform. Displays CID (Customer ID), campaign names, budget, max CPC, cost, clicks, commissions, refunds, net profit, and ROI for each campaign. Data is fetched daily from the Google Ads API using GAQL queries on campaign metrics (cost_micros, clicks, impressions, average_cpc, conversions).",
        featuresLabel: "Key Features:",
        features: [
          "Campaign-level metrics: cost, clicks, impressions, average CPC, conversions",
          "Date range filtering for historical performance analysis",
          "Filter by MCC account, campaign status, and campaign type",
          "Sync buttons for transaction data, MCC data, and CID accounts",
        ],
      },
      {
        images: [
          { src: "/images/demo/ad-creation-1.png", caption: "Step 1: Campaign setup — RSA headlines & descriptions, keyword configuration, MCC/CID account selection, budget, CPC, language, and network settings" },
          { src: "/images/demo/ad-creation-2.png", caption: "Step 2: Ad extensions — Sitelinks with URL validation, merchant image generation & upload for Google Ads compliance" },
          { src: "/images/demo/ad-creation-3.png", caption: "Step 3: Additional extensions — Callouts, Promotions, Price, Call, and Structured Snippets, all auto-generated from merchant data" },
        ],
        title: "Ad Creation — Full Campaign Setup & Submission",
        icon: <SettingOutlined style={{ color: "#1A7FDB" }} />,
        apiTag: "googleAds:mutate",
        description:
          "Complete campaign creation workflow. This page allows our team to build a full Google Search campaign in one interface — including 15 Responsive Search Ad headlines, 4 descriptions, keyword selection with match types, and all ad extensions (sitelinks, callouts, promotions, price, call, structured snippets). Once configured, the campaign is submitted directly to Google Ads via the API mutate endpoint.",
        featuresLabel: "Key Features:",
        features: [
          "Responsive Search Ad creation with 15 headlines + 4 descriptions",
          "Keyword management with Broad/Phrase/Exact match types",
          "Campaign-level asset creation: sitelinks, callouts, promotions, price extensions, call extensions, structured snippets",
          "Image asset upload and attachment to campaigns",
          "MCC/CID account selection for multi-account campaign distribution",
          "One-click submission to Google Ads via mutate API",
        ],
      },
      {
        src: "/images/demo/budget-control.png",
        title: "Budget Control — Real-time Budget Adjustment",
        icon: <DollarOutlined style={{ color: "#52c41a" }} />,
        apiTag: "googleAds:mutate (campaign_budget_operation.update)",
        description:
          "Real-time campaign budget modification interface. Team members can adjust the daily budget of any active campaign directly from the dashboard. The update is sent to Google Ads API via the mutate endpoint, modifying the campaign_budget resource with the new amount_micros value.",
        featuresLabel: "Key Features:",
        features: [
          "View current budget and modify in real-time",
          "Updates sent via campaign_budget_operation.update",
          "Dollar-to-micros conversion handled automatically",
        ],
      },
      {
        src: "/images/demo/mcc-accounts.png",
        title: "MCC Account Management — CID Selection & Availability",
        icon: <TeamOutlined style={{ color: "#722ed1" }} />,
        apiTag: "googleAds:searchStream (customer_client)",
        description:
          "MCC (Manager Account) sub-account management. When creating a new campaign, the platform queries the Google Ads API to list all child accounts (CIDs) under the selected MCC, checks each CID's availability (whether it already has active campaigns), and displays the status. Available CIDs are marked in green; occupied ones are marked as taken.",
        featuresLabel: "Key Features:",
        features: [
          "List child accounts via customer_client GAQL query",
          "Real-time CID availability checking (active campaign detection)",
          "Support for multiple MCC accounts per user",
        ],
      },
      {
        src: "/images/demo/data-sync.png",
        title: "Data Synchronization — MCC Campaign Data Sync",
        icon: <CloudSyncOutlined style={{ color: "#13c2c2" }} />,
        apiTag: "googleAds:searchStream (campaign + metrics + segments.date)",
        description:
          "Manual MCC data synchronization interface. Allows team members to sync campaign performance data from Google Ads for a specific date range. The platform fetches campaign metrics (cost, clicks, impressions, CPC, conversions) via the searchStream API and stores them in our internal database for consolidated reporting.",
        featuresLabel: "Key Features:",
        features: [
          "Date range selection for targeted data synchronization",
          "Fetches campaign metrics via searchStream GAQL queries",
          "Updates campaign statuses, budgets, and CID availability",
          "Automated daily sync also runs via cron job",
        ],
      },
      {
        src: "/images/demo/affiliate-network.png",
        title: "Affiliate Network — Merchant Sourcing",
        icon: <ShopOutlined style={{ color: "#eb2f96" }} />,
        apiTag: "Business Context",
        description:
          "Our team sources merchants from major international affiliate networks such as CollabGlow, Partnermatic, LinkHaiTao, Rewardoo, LinkBux, BrandSparkHub, and CreatorFlare. Each merchant is assigned to a team member who then creates and manages Google Ads Search campaigns to promote the merchant's products. Commissions earned from resulting sales are tracked in our platform's data center.",
        featuresLabel: "Key Features:",
        features: [
          "Merchant discovery from 7+ international affiliate networks",
          "Merchant assignment to team members for campaign management",
          "Commission and ROI tracking per merchant/campaign",
        ],
      },
    ];
  }

  return [
    {
      src: "/images/demo/data-center.png",
      title: "数据中心 — 广告系列效果面板",
      icon: <BarChartOutlined style={{ color: "#fa8c16" }} />,
      apiTag: "googleAds:searchStream",
      description:
        "实时广告系列效果面板，展示平台管理的所有 Google Ads 广告。显示 CID（客户 ID）、广告系列名称、预算、最高 CPC、花费、点击、佣金、退款、净利润和 ROI。数据每日通过 Google Ads API 使用 GAQL 查询广告指标（cost_micros、clicks、impressions、average_cpc、conversions）。",
      featuresLabel: "核心功能：",
      features: [
        "广告系列级指标：花费、点击、展示、平均 CPC、转化",
        "日期范围筛选用于历史效果分析",
        "按 MCC 账户、广告状态和类型筛选",
        "同步按钮：同步交易、同步 MCC、同步 CID",
      ],
    },
    {
      images: [
        { src: "/images/demo/ad-creation-1.png", caption: "步骤 1：广告系列设置 — RSA 标题与描述、关键词配置、MCC/CID 账户选择、预算、CPC、语言和投放网络设置" },
        { src: "/images/demo/ad-creation-2.png", caption: "步骤 2：广告扩展 — 站内链接（含 URL 验证）、商家图片生成与上传" },
        { src: "/images/demo/ad-creation-3.png", caption: "步骤 3：附加扩展 — 宣传信息、促销、价格、致电、结构化摘要，从商家数据自动生成" },
      ],
      title: "广告创建 — 完整广告系列设置与提交",
      icon: <SettingOutlined style={{ color: "#1A7FDB" }} />,
      apiTag: "googleAds:mutate",
      description:
        "完整的广告创建流程。团队可在一个界面中构建完整的 Google 搜索广告系列 — 包括 15 个自适应搜索广告标题、4 个描述、关键词选择（含匹配类型），以及所有广告扩展（站内链接、宣传信息、促销、价格、致电、结构化摘要）。配置完成后，通过 API mutate 端点直接提交到 Google Ads。",
      featuresLabel: "核心功能：",
      features: [
        "创建自适应搜索广告：15 个标题 + 4 个描述",
        "关键词管理：广泛匹配/词组匹配/完全匹配",
        "广告素材创建：站内链接、宣传信息、促销、价格扩展、致电扩展、结构化摘要",
        "图片素材上传与广告关联",
        "MCC/CID 账户选择用于多账户广告分发",
        "一键通过 mutate API 提交到 Google Ads",
      ],
    },
    {
      src: "/images/demo/budget-control.png",
      title: "预算控制 — 实时预算调整",
      icon: <DollarOutlined style={{ color: "#52c41a" }} />,
      apiTag: "googleAds:mutate (campaign_budget_operation.update)",
      description:
        "实时广告预算修改界面。团队成员可直接从面板调整任意活跃广告系列的每日预算。更新通过 mutate 端点发送到 Google Ads API，修改 campaign_budget 资源的 amount_micros 值。",
      featuresLabel: "核心功能：",
      features: [
        "查看当前预算并实时修改",
        "通过 campaign_budget_operation.update 发送更新",
        "自动处理美元到 micros 的单位转换",
      ],
    },
    {
      src: "/images/demo/mcc-accounts.png",
      title: "MCC 账户管理 — CID 选择与可用性",
      icon: <TeamOutlined style={{ color: "#722ed1" }} />,
      apiTag: "googleAds:searchStream (customer_client)",
      description:
        "MCC（管理账户）子账户管理。创建新广告时，平台通过 Google Ads API 查询所选 MCC 下的所有子账户（CID），检查每个 CID 的可用性（是否已有活跃广告），并显示状态。可用 CID 标记为绿色；已占用的标记为已占用。",
      featuresLabel: "核心功能：",
      features: [
        "通过 customer_client GAQL 查询列出子账户",
        "实时 CID 可用性检查（活跃广告检测）",
        "支持每个用户多个 MCC 账户",
      ],
    },
    {
      src: "/images/demo/data-sync.png",
      title: "数据同步 — MCC 广告数据同步",
      icon: <CloudSyncOutlined style={{ color: "#13c2c2" }} />,
      apiTag: "googleAds:searchStream (campaign + metrics + segments.date)",
      description:
        "手动 MCC 数据同步界面。团队成员可同步指定日期范围的 Google Ads 广告效果数据。平台通过 searchStream API 获取广告指标（花费、点击、展示、CPC、转化），存储到内部数据库用于汇总报告。",
      featuresLabel: "核心功能：",
      features: [
        "日期范围选择用于定向数据同步",
        "通过 searchStream GAQL 查询获取广告指标",
        "更新广告状态、预算和 CID 可用性",
        "自动每日同步也通过定时任务运行",
      ],
    },
    {
      src: "/images/demo/affiliate-network.png",
      title: "联盟网络 — 商家来源",
      icon: <ShopOutlined style={{ color: "#eb2f96" }} />,
      apiTag: "Business Context",
      description:
        "团队从国际联盟网络获取商家，包括 CollabGlow、Partnermatic、LinkHaiTao、Rewardoo、LinkBux、BrandSparkHub、CreatorFlare 等。每个商家分配给团队成员，由其创建和管理 Google Ads 搜索广告系列来推广商家产品。销售产生的佣金在平台数据中心中追踪。",
      featuresLabel: "核心功能：",
      features: [
        "从 7+ 个国际联盟网络发现商家",
        "将商家分配给团队成员管理广告",
        "按商家/广告追踪佣金和 ROI",
      ],
    },
  ];
}

const summaryI18n = {
  en: {
    title: "Google Ads API Integration Summary",
    desc: "Our platform integrates with the Google Ads API v23 via two primary REST endpoints:",
    readTitle: "Read Operations",
    readItems: [
      "Campaign performance metrics (daily)",
      "Campaign status and budget queries",
      "MCC child account enumeration",
      "CID availability checking",
      "Post-mutation status verification",
    ],
    writeTitle: "Write Operations",
    writeItems: [
      "Campaign + budget + ad group + RSA creation",
      "Keyword addition with match types",
      "Ad asset creation (6 types + images)",
      "Budget and CPC bid updates",
      "Campaign enable/pause/remove",
    ],
  },
  zh: {
    title: "Google Ads API 集成概要",
    desc: "平台通过两个主要 REST 端点集成 Google Ads API v23：",
    readTitle: "读取操作",
    readItems: [
      "每日广告效果指标",
      "广告状态和预算查询",
      "MCC 子账户枚举",
      "CID 可用性检查",
      "变更后状态验证",
    ],
    writeTitle: "写入操作",
    writeItems: [
      "创建广告系列 + 预算 + 广告组 + RSA",
      "添加关键词（含匹配类型）",
      "创建广告素材（6 种类型 + 图片）",
      "更新预算和 CPC 出价",
      "启用/暂停/移除广告系列",
    ],
  },
};

const introI18n = {
  en: {
    title: "Platform Demo",
    desc: "Below are screenshots of our Ad Automation CRM platform in production, demonstrating how we use the Google Ads API for campaign management, reporting, and optimization.",
    note: "This platform is used exclusively by our internal team at Wenzhou Fengdu Advertising & Media Co., Ltd.",
  },
  zh: {
    title: "平台演示",
    desc: "以下是 Ad Automation CRM 平台的生产环境截图，展示我们如何使用 Google Ads API 进行广告管理、报告和优化。",
    note: "本平台仅供温州丰度广告传媒有限公司内部团队使用。",
  },
};

export default function DemoPage() {
  const { lang } = useLanguage();
  const screenshots = getScreenshots(lang);
  const intro = introI18n[lang];
  const summary = summaryI18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <PageHeader showHome />

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "40px 20px 80px" }}>
        <Title level={1} style={{ color: "#1A7FDB", textAlign: "center" }}>
          <ApiOutlined style={{ marginRight: 12 }} />
          {intro.title}
        </Title>
        <Paragraph style={{ textAlign: "center", color: "#666", fontSize: 16, maxWidth: 700, margin: "0 auto 16px" }}>
          {intro.desc}
        </Paragraph>
        <Paragraph style={{ textAlign: "center", color: "#999", marginBottom: 48 }}>
          {intro.note}
        </Paragraph>

        {screenshots.map((s, idx) => (
          <Card key={idx} style={{ borderRadius: 12, marginBottom: 32, overflow: "hidden" }}>
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                {s.icon}
                <Title level={3} style={{ margin: 0, flex: 1 }}>{s.title}</Title>
                <Tag color="blue" style={{ fontSize: 13, padding: "2px 10px" }}>API: {s.apiTag}</Tag>
              </div>

              {s.images ? (
                <Space direction="vertical" size={16} style={{ width: "100%" }}>
                  {s.images.map((img, ii) => (
                    <div key={ii}>
                      <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden", background: "#fafafa" }}>
                        <Image src={img.src} alt={img.caption} width={920} height={0} style={{ width: "100%", height: "auto" }} unoptimized />
                      </div>
                      <Text type="secondary" style={{ display: "block", textAlign: "center", marginTop: 8, fontSize: 13 }}>
                        {img.caption}
                      </Text>
                    </div>
                  ))}
                </Space>
              ) : (
                <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, overflow: "hidden", background: "#fafafa" }}>
                  <Image src={s.src!} alt={s.title} width={920} height={0} style={{ width: "100%", height: "auto" }} unoptimized />
                </div>
              )}

              <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>{s.description}</Paragraph>
              <div>
                <Text strong style={{ fontSize: 14 }}>{s.featuresLabel}</Text>
                <ul style={{ fontSize: 14, lineHeight: 2, marginTop: 4 }}>
                  {s.features.map((f, fi) => (<li key={fi}>{f}</li>))}
                </ul>
              </div>
            </Space>
          </Card>
        ))}

        <Card style={{ borderRadius: 12, marginBottom: 32, background: "#f6f9fc" }}>
          <Title level={3} style={{ textAlign: "center" }}>{summary.title}</Title>
          <Paragraph style={{ textAlign: "center", fontSize: 15, lineHeight: 1.8 }}>{summary.desc}</Paragraph>
          <div style={{ display: "flex", gap: 24, justifyContent: "center", flexWrap: "wrap", marginTop: 16 }}>
            <Card style={{ flex: 1, minWidth: 300, borderRadius: 8 }}>
              <Title level={4} style={{ color: "#1A7FDB" }}>{summary.readTitle}</Title>
              <Paragraph><code>POST /customers/&#123;id&#125;/googleAds:searchStream</code></Paragraph>
              <ul style={{ fontSize: 14, lineHeight: 2 }}>
                {summary.readItems.map((item) => (<li key={item}>{item}</li>))}
              </ul>
            </Card>
            <Card style={{ flex: 1, minWidth: 300, borderRadius: 8 }}>
              <Title level={4} style={{ color: "#52c41a" }}>{summary.writeTitle}</Title>
              <Paragraph><code>POST /customers/&#123;id&#125;/googleAds:mutate</code></Paragraph>
              <ul style={{ fontSize: 14, lineHeight: 2 }}>
                {summary.writeItems.map((item) => (<li key={item}>{item}</li>))}
              </ul>
            </Card>
          </div>
        </Card>

        <Divider />
        <PageFooter />
      </div>
    </div>
  );
}
