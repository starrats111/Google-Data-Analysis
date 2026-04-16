"use client";

import { useState } from "react";
import { Button, Typography, Card, Row, Col, Space, Divider } from "antd";
import {
  RocketOutlined,
  ShopOutlined,
  FileTextOutlined,
  BarChartOutlined,
  SettingOutlined,
  UserOutlined,
  PlayCircleOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import Link from "next/link";

const { Title, Paragraph, Text } = Typography;

const i18n = {
  en: {
    brand: "Ad Automation Platform",
    login: "User Login",
    admin: "Admin Portal",
    heroTitle: "Ad Automation CRM",
    heroDesc:
      "An internal affiliate marketing operations platform developed by Wenzhou Fengdu Advertising & Media Co., Ltd. Our team uses this platform to manage Google Ads Search campaigns for affiliate merchants sourced from major international affiliate networks, track ROI and commissions, and automate content publishing — all within a single, internally-operated system.",
    heroNote:
      "This platform is used exclusively by our internal advertising team and is not offered as a service to third parties. For company information, please visit our",
    aboutLink: "About Us",
    btnUser: "User Portal",
    btnAdmin: "Admin Console",
    btnDemo: "Platform Demo",
    capTitle: "Platform Capabilities",
    features: [
      {
        icon: <ShopOutlined style={{ fontSize: 32, color: "#4DA6FF" }} />,
        title: "Affiliate Merchant Management",
        desc: "Source and manage partner merchants from major international affiliate networks (CJ, Impact, ShareASale, Awin, Rakuten, etc.) and assign campaigns to team members.",
      },
      {
        icon: <RocketOutlined style={{ fontSize: 32, color: "#52c41a" }} />,
        title: "Google Ads Campaign Automation",
        desc: "Automate the full Google Search campaign lifecycle — creation, keyword setup, bidding strategy, geographic/language targeting, RSA composition, and asset management.",
      },
      {
        icon: <BarChartOutlined style={{ fontSize: 32, color: "#fa8c16" }} />,
        title: "Performance & ROI Analytics",
        desc: "Track spend, clicks, impressions, conversions, affiliate commissions, and ROI across all campaigns in a unified real-time dashboard.",
      },
      {
        icon: <FileTextOutlined style={{ fontSize: 32, color: "#1A7FDB" }} />,
        title: "Content & Publishing Automation",
        desc: "AI-powered SEO article generation and multi-site publishing to support organic traffic alongside paid search campaigns for each affiliate merchant.",
      },
    ],
    footer: "© 2026 Wenzhou Fengdu Advertising & Media Co., Ltd. All rights reserved.",
    linkAbout: "About Us",
    linkDemo: "Platform Demo",
    linkPrivacy: "Privacy Policy",
    linkTerms: "Terms of Service",
  },
  zh: {
    brand: "广告自动化发布",
    login: "用户登录",
    admin: "管理员入口",
    heroTitle: "广告自动化发布平台",
    heroDesc:
      "温州丰度广告传媒有限公司内部运营平台。团队通过本平台管理来自国际联盟网络的商家，统一创建和优化 Google Ads 搜索广告系列，追踪 ROI 与佣金，并自动化内容发布 — 实现一站式闭环管理。",
    heroNote:
      "本平台仅供公司内部广告团队使用，不对外提供服务。公司信息请访问",
    aboutLink: "关于我们",
    btnUser: "进入用户平台",
    btnAdmin: "进入总控制台",
    btnDemo: "平台演示",
    capTitle: "平台核心能力",
    features: [
      {
        icon: <ShopOutlined style={{ fontSize: 32, color: "#4DA6FF" }} />,
        title: "商家管理",
        desc: "统一管理 7 大联盟平台商家，一键领取、自动分配给团队成员创建广告。",
      },
      {
        icon: <RocketOutlined style={{ fontSize: 32, color: "#52c41a" }} />,
        title: "智能投放",
        desc: "自动化 Google 搜索广告全流程 — 广告系列创建、关键词设置、出价策略、地域/语言定向、RSA 组合及素材管理。",
      },
      {
        icon: <BarChartOutlined style={{ fontSize: 32, color: "#fa8c16" }} />,
        title: "数据看板",
        desc: "实时可视化看板，费用、点击、展示、转化、佣金、ROI 一目了然。",
      },
      {
        icon: <FileTextOutlined style={{ fontSize: 32, color: "#1A7FDB" }} />,
        title: "文章管理",
        desc: "AI 自动生成 SEO 文章，支持多站点一键发布，配合付费搜索广告提升自然流量。",
      },
    ],
    footer: "© 2026 温州丰度广告传媒有限公司 版权所有",
    linkAbout: "关于我们",
    linkDemo: "平台演示",
    linkPrivacy: "隐私政策",
    linkTerms: "服务条款",
  },
};

type Lang = keyof typeof i18n;

export default function HomePage() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>("en");
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <div
        style={{
          padding: "20px 40px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Space>
          <RocketOutlined style={{ fontSize: 28, color: "#4DA6FF" }} />
          <Text strong style={{ fontSize: 20, color: "#1A7FDB" }}>
            {t.brand}
          </Text>
        </Space>
        <Space>
          <Button
            icon={<GlobalOutlined />}
            onClick={() => setLang(lang === "en" ? "zh" : "en")}
          >
            {lang === "en" ? "中文" : "EN"}
          </Button>
          <Button onClick={() => router.push("/user/login")}>{t.login}</Button>
          <Button type="primary" onClick={() => router.push("/admin/login")}>
            {t.admin}
          </Button>
        </Space>
      </div>

      <div
        style={{
          background: "#f0f7ff",
          padding: "60px 20px 48px",
          textAlign: "center",
        }}
      >
        <Title style={{ color: "#1A7FDB", fontSize: 36, marginBottom: 12 }}>
          {t.heroTitle}
        </Title>
        <Paragraph
          style={{
            color: "#444",
            fontSize: 17,
            maxWidth: 720,
            margin: "0 auto 16px",
            lineHeight: 1.8,
          }}
        >
          {t.heroDesc}
        </Paragraph>
        <Paragraph
          style={{
            color: "#888",
            fontSize: 14,
            maxWidth: 680,
            margin: "0 auto 32px",
          }}
        >
          {t.heroNote}{" "}
          <a href="/about" style={{ color: "#1A7FDB" }}>
            {t.aboutLink}
          </a>{" "}
          {lang === "en" ? "page." : "页面。"}
        </Paragraph>
        <Space size="large" wrap style={{ justifyContent: "center" }}>
          <Button
            type="primary"
            size="large"
            icon={<UserOutlined />}
            onClick={() => router.push("/user/login")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            {t.btnUser}
          </Button>
          <Button
            size="large"
            icon={<SettingOutlined />}
            onClick={() => router.push("/admin/login")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            {t.btnAdmin}
          </Button>
          <Button
            size="large"
            icon={<PlayCircleOutlined />}
            onClick={() => router.push("/demo")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            {t.btnDemo}
          </Button>
        </Space>
      </div>

      <div
        style={{ maxWidth: 1060, margin: "0 auto", padding: "48px 20px 80px" }}
      >
        <Title
          level={3}
          style={{ textAlign: "center", color: "#333", marginBottom: 32 }}
        >
          {t.capTitle}
        </Title>
        <Row gutter={[24, 24]}>
          {t.features.map((f) => (
            <Col xs={24} sm={12} key={f.title}>
              <Card hoverable style={{ height: "100%", borderRadius: 12 }}>
                <Space direction="vertical" size={12}>
                  {f.icon}
                  <Title level={4} style={{ margin: 0 }}>
                    {f.title}
                  </Title>
                  <Text type="secondary">{f.desc}</Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      <div
        style={{
          textAlign: "center",
          padding: "30px 20px",
          borderTop: "1px solid #f0f0f0",
        }}
      >
        <Text style={{ color: "#999", display: "block", marginBottom: 8 }}>
          {t.footer}
        </Text>
        <Space split={<Divider type="vertical" />} size={4}>
          <Link href="/about" style={{ color: "#999", fontSize: 13 }}>
            {t.linkAbout}
          </Link>
          <Link href="/demo" style={{ color: "#999", fontSize: 13 }}>
            {t.linkDemo}
          </Link>
          <Link href="/privacy-policy" style={{ color: "#999", fontSize: 13 }}>
            {t.linkPrivacy}
          </Link>
          <Link
            href="/terms-of-service"
            style={{ color: "#999", fontSize: 13 }}
          >
            {t.linkTerms}
          </Link>
        </Space>
      </div>
    </div>
  );
}
