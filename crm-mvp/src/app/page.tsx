"use client";

import { Button, Typography, Card, Row, Col, Space } from "antd";
import {
  RocketOutlined,
  ShopOutlined,
  FileTextOutlined,
  BarChartOutlined,
  SettingOutlined,
  UserOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";

const { Title, Paragraph, Text } = Typography;

const i18n = {
  en: {
    heroTitle: "Ad Automation CRM",
    heroDesc:
      "Wenzhou Fengdu Advertising & Media Co., Ltd. is an affiliate marketing company. Our internal advertising team uses this in-house platform to manage Google Ads Search and Performance Max campaigns under our own Google Ads Manager (MCC) account — all advertising budgets are paid for by our company directly to Google. We do not manage campaigns on behalf of third-party clients.",
    heroNote:
      "This platform is used exclusively by our internal advertising team and is not offered as a service or product to any third party. All campaigns comply with the Google Ads Affiliate Program Policy. For company information, please visit our",
    aboutLink: "About Us",
    heroNoteSuffix: "page.",
    btnUser: "User Portal",
    btnAdmin: "Admin Console",
    btnDemo: "Platform Demo",
    capTitle: "Platform Capabilities",
    features: [
      { title: "Merchant & Campaign Workflow", desc: "Source partner merchants from international affiliate networks and assign campaigns to internal team members for end-to-end management." },
      { title: "Google Ads Campaign Automation", desc: "Automate the full Google Search and Performance Max campaign lifecycle — creation, keyword setup, bidding strategy, geographic/language targeting, RSA composition, and asset management." },
      { title: "Performance & ROI Analytics", desc: "Track spend, clicks, impressions, conversions, affiliate commissions, and ROI across all campaigns in a unified real-time dashboard." },
      { title: "Content & Publishing Automation", desc: "AI-powered SEO article generation and multi-site publishing to support organic traffic alongside paid search campaigns." },
    ],
  },
  zh: {
    heroTitle: "广告自动化发布平台",
    heroDesc:
      "温州丰度广告传媒有限公司是一家联盟营销公司。公司内部广告团队通过本平台在我们自有的 Google Ads 经理账户（MCC）下管理 Google 搜索广告与效果最大化广告，所有广告预算均由本公司直接向 Google 支付。我们不为任何第三方客户管理广告。",
    heroNote: "本平台仅供公司内部广告团队使用，不向任何第三方提供产品或服务。所有广告均遵守 Google Ads 联盟营销计划政策（Affiliate Program Policy）。公司信息请访问",
    aboutLink: "关于我们",
    heroNoteSuffix: "页面。",
    btnUser: "进入用户平台",
    btnAdmin: "进入总控制台",
    btnDemo: "平台演示",
    capTitle: "平台核心能力",
    features: [
      { title: "商家与广告流程", desc: "从国际联盟网络发掘合作商家，分配给内部团队成员进行端到端的广告管理。" },
      { title: "智能投放", desc: "自动化 Google 搜索广告与效果最大化广告全流程 — 广告系列创建、关键词设置、出价策略、地域/语言定向、RSA 组合及素材管理。" },
      { title: "数据看板", desc: "实时可视化看板，费用、点击、展示、转化、佣金、ROI 一目了然。" },
      { title: "文章管理", desc: "AI 自动生成 SEO 文章，支持多站点一键发布，配合付费搜索广告提升自然流量。" },
    ],
  },
};

const featureIcons = [
  <ShopOutlined key="shop" style={{ fontSize: 32, color: "#4DA6FF" }} />,
  <RocketOutlined key="rocket" style={{ fontSize: 32, color: "#52c41a" }} />,
  <BarChartOutlined key="chart" style={{ fontSize: 32, color: "#fa8c16" }} />,
  <FileTextOutlined key="text" style={{ fontSize: 32, color: "#1A7FDB" }} />,
];

export default function HomePage() {
  const router = useRouter();
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <PageHeader />

      <div style={{ background: "#f0f7ff", padding: "60px 20px 48px", textAlign: "center" }}>
        <Title style={{ color: "#1A7FDB", fontSize: 36, marginBottom: 12 }}>
          {t.heroTitle}
        </Title>
        <Paragraph style={{ color: "#444", fontSize: 17, maxWidth: 720, margin: "0 auto 16px", lineHeight: 1.8 }}>
          {t.heroDesc}
        </Paragraph>
        <Paragraph style={{ color: "#888", fontSize: 14, maxWidth: 680, margin: "0 auto 32px" }}>
          {t.heroNote}{" "}
          <a href="/about" style={{ color: "#1A7FDB" }}>{t.aboutLink}</a>{" "}
          {t.heroNoteSuffix}
        </Paragraph>
        <Space size="large" wrap style={{ justifyContent: "center" }}>
          <Button type="primary" size="large" icon={<UserOutlined />} onClick={() => router.push("/user/login")} style={{ height: 48, paddingInline: 32, fontSize: 16 }}>
            {t.btnUser}
          </Button>
          <Button size="large" icon={<SettingOutlined />} onClick={() => router.push("/admin/login")} style={{ height: 48, paddingInline: 32, fontSize: 16 }}>
            {t.btnAdmin}
          </Button>
          <Button size="large" icon={<PlayCircleOutlined />} onClick={() => router.push("/demo")} style={{ height: 48, paddingInline: 32, fontSize: 16 }}>
            {t.btnDemo}
          </Button>
        </Space>
      </div>

      {/* Google Ads API Integration Evidence Block */}
      <div style={{ background: "#f6ffed", borderTop: "2px solid #52c41a", borderBottom: "2px solid #52c41a", padding: "32px 20px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <Title level={4} style={{ color: "#237804", marginBottom: 16, textAlign: "center" }}>
            Google Ads API v23 Integration — How We Use the API
          </Title>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12}>
              <Card size="small" style={{ background: "#fff", borderRadius: 8, border: "1px solid #b7eb8f" }}>
                <Text strong style={{ color: "#237804" }}>Read Operations — googleAds:searchStream</Text>
                <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 13, color: "#444" }}>
                  <li>Daily campaign metrics (cost, clicks, impressions, conversions)</li>
                  <li>Campaign status and budget queries via GAQL</li>
                  <li>MCC child account enumeration (customer_client)</li>
                  <li>CID availability checking before campaign creation</li>
                </ul>
              </Card>
            </Col>
            <Col xs={24} sm={12}>
              <Card size="small" style={{ background: "#fff", borderRadius: 8, border: "1px solid #b7eb8f" }}>
                <Text strong style={{ color: "#237804" }}>Write Operations — googleAds:mutate</Text>
                <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 13, color: "#444" }}>
                  <li>Campaign + budget + ad group + RSA creation</li>
                  <li>Keyword addition (Broad / Phrase / Exact match)</li>
                  <li>Ad assets: sitelinks, callouts, promotions, price, call, snippets</li>
                  <li>Real-time budget and CPC bid adjustments</li>
                </ul>
              </Card>
            </Col>
          </Row>
          <div style={{ textAlign: "center", marginTop: 16 }}>
            <Text style={{ color: "#555", fontSize: 13 }}>
              Managing multiple <strong>Google Ads sub-accounts under our own MCC</strong> with all advertising spend funded directly by our company.
              Basic Access (15,000 ops/day) required — Explorer Access quota exceeded by daily batch operations.
              &nbsp;→&nbsp;
            </Text>
            <a href="/demo" style={{ color: "#237804", fontWeight: 600, fontSize: 13 }}>View Platform Demo with Screenshots</a>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1060, margin: "0 auto", padding: "48px 20px 80px" }}>
        <Title level={3} style={{ textAlign: "center", color: "#333", marginBottom: 32 }}>
          {t.capTitle}
        </Title>
        <Row gutter={[24, 24]}>
          {t.features.map((f, i) => (
            <Col xs={24} sm={12} key={f.title}>
              <Card hoverable style={{ height: "100%", borderRadius: 12 }}>
                <Space direction="vertical" size={12}>
                  {featureIcons[i]}
                  <Title level={4} style={{ margin: 0 }}>{f.title}</Title>
                  <Text type="secondary">{f.desc}</Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      <PageFooter />
    </div>
  );
}
