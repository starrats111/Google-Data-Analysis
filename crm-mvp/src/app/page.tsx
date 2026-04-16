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
      "An internal affiliate marketing operations platform developed by Wenzhou Fengdu Advertising & Media Co., Ltd. Our team uses this platform to manage Google Ads Search campaigns for affiliate merchants sourced from major international affiliate networks, track ROI and commissions, and automate content publishing — all within a single, internally-operated system.",
    heroNote:
      "This platform is used exclusively by our internal advertising team and is not offered as a service to third parties. For company information, please visit our",
    aboutLink: "About Us",
    heroNoteSuffix: "page.",
    btnUser: "User Portal",
    btnAdmin: "Admin Console",
    btnDemo: "Platform Demo",
    capTitle: "Platform Capabilities",
    features: [
      { title: "Affiliate Merchant Management", desc: "Source and manage partner merchants from major international affiliate networks (CJ, Impact, ShareASale, Awin, Rakuten, etc.) and assign campaigns to team members." },
      { title: "Google Ads Campaign Automation", desc: "Automate the full Google Search campaign lifecycle — creation, keyword setup, bidding strategy, geographic/language targeting, RSA composition, and asset management." },
      { title: "Performance & ROI Analytics", desc: "Track spend, clicks, impressions, conversions, affiliate commissions, and ROI across all campaigns in a unified real-time dashboard." },
      { title: "Content & Publishing Automation", desc: "AI-powered SEO article generation and multi-site publishing to support organic traffic alongside paid search campaigns for each affiliate merchant." },
    ],
  },
  zh: {
    heroTitle: "广告自动化发布平台",
    heroDesc:
      "温州丰度广告传媒有限公司内部运营平台。团队通过本平台管理来自国际联盟网络的商家，统一创建和优化 Google Ads 搜索广告系列，追踪 ROI 与佣金，并自动化内容发布 — 实现一站式闭环管理。",
    heroNote: "本平台仅供公司内部广告团队使用，不对外提供服务。公司信息请访问",
    aboutLink: "关于我们",
    heroNoteSuffix: "页面。",
    btnUser: "进入用户平台",
    btnAdmin: "进入总控制台",
    btnDemo: "平台演示",
    capTitle: "平台核心能力",
    features: [
      { title: "商家管理", desc: "统一管理 7 大联盟平台商家，一键领取、自动分配给团队成员创建广告。" },
      { title: "智能投放", desc: "自动化 Google 搜索广告全流程 — 广告系列创建、关键词设置、出价策略、地域/语言定向、RSA 组合及素材管理。" },
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
