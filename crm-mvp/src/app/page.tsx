"use client";

import { Button, Typography, Card, Row, Col, Space, Divider } from "antd";
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
import Link from "next/link";

const { Title, Paragraph, Text } = Typography;

const features = [
  {
    icon: <ShopOutlined style={{ fontSize: 32, color: "#4DA6FF" }} />,
    title: "商家管理",
    desc: "统一管理 7 大联盟平台商家，一键领取、自动创建广告",
  },
  {
    icon: <FileTextOutlined style={{ fontSize: 32, color: "#52c41a" }} />,
    title: "文章管理",
    desc: "AI 自动生成 SEO 文章，支持多站点一键发布",
  },
  {
    icon: <BarChartOutlined style={{ fontSize: 32, color: "#fa8c16" }} />,
    title: "数据看板",
    desc: "实时数据可视化，费用/佣金/ROI 一目了然",
  },
  {
    icon: <SettingOutlined style={{ fontSize: 32, color: "#1A7FDB" }} />,
    title: "智能投放",
    desc: "广告默认设置 + 节日营销，自动优化投放策略",
  },
];

const enFeatures = [
  {
    icon: <ShopOutlined style={{ fontSize: 28, color: "#4DA6FF" }} />,
    title: "Affiliate Merchant Management",
    desc: "Source and manage partner merchants from major international affiliate networks (CJ, Impact, ShareASale, Awin, Rakuten, etc.) and assign campaigns to team members.",
  },
  {
    icon: <RocketOutlined style={{ fontSize: 28, color: "#52c41a" }} />,
    title: "Google Ads Campaign Automation",
    desc: "Automate the full Google Search campaign lifecycle — creation, keyword setup, bidding strategy, geographic/language targeting, RSA composition, and asset management.",
  },
  {
    icon: <BarChartOutlined style={{ fontSize: 28, color: "#fa8c16" }} />,
    title: "Performance & ROI Analytics",
    desc: "Track spend, clicks, impressions, conversions, affiliate commissions, and ROI across all campaigns in a unified real-time dashboard.",
  },
  {
    icon: <FileTextOutlined style={{ fontSize: 28, color: "#1A7FDB" }} />,
    title: "Content & Publishing Automation",
    desc: "AI-powered SEO article generation and multi-site publishing to support organic traffic alongside paid search campaigns for each affiliate merchant.",
  },
];

export default function HomePage() {
  const router = useRouter();

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      {/* Header */}
      <div style={{ padding: "20px 40px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Space>
          <RocketOutlined style={{ fontSize: 28, color: "#4DA6FF" }} />
          <Text strong style={{ fontSize: 20, color: "#1A7FDB" }}>广告自动化发布</Text>
        </Space>
        <Space>
          <Button onClick={() => router.push("/user/login")}>
            用户登录
          </Button>
          <Button type="primary" onClick={() => router.push("/admin/login")}>
            管理员入口
          </Button>
        </Space>
      </div>

      {/* English Hero — for external visitors and verification */}
      <div style={{ background: "#f0f7ff", padding: "60px 20px 48px", textAlign: "center" }}>
        <Title style={{ color: "#1A7FDB", fontSize: 36, marginBottom: 12 }}>
          Ad Automation CRM
        </Title>
        <Paragraph style={{ color: "#444", fontSize: 17, maxWidth: 720, margin: "0 auto 16px", lineHeight: 1.8 }}>
          An internal affiliate marketing operations platform developed by{" "}
          <Text strong>Wenzhou Fengdu Advertising &amp; Media Co., Ltd.</Text>{" "}
          Our team uses this platform to manage Google Ads Search campaigns for affiliate merchants sourced from major international affiliate networks, track ROI and commissions, and automate content publishing — all within a single, internally-operated system.
        </Paragraph>
        <Paragraph style={{ color: "#888", fontSize: 14, maxWidth: 680, margin: "0 auto 32px" }}>
          This platform is used exclusively by our internal advertising team and is not offered as a service to third parties.
          For company information, please visit our{" "}
          <a href="/about" style={{ color: "#1A7FDB" }}>About Us</a> page.
        </Paragraph>
        <Space size="large" wrap style={{ justifyContent: "center" }}>
          <Button
            type="primary"
            size="large"
            icon={<UserOutlined />}
            onClick={() => router.push("/user/login")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            进入用户平台
          </Button>
          <Button
            size="large"
            icon={<SettingOutlined />}
            onClick={() => router.push("/admin/login")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            进入总控制台
          </Button>
          <Button
            size="large"
            icon={<PlayCircleOutlined />}
            onClick={() => router.push("/demo")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            Platform Demo
          </Button>
        </Space>
      </div>

      {/* English Features */}
      <div style={{ maxWidth: 1060, margin: "0 auto", padding: "48px 20px 16px" }}>
        <Title level={3} style={{ textAlign: "center", color: "#333", marginBottom: 32 }}>
          Platform Capabilities
        </Title>
        <Row gutter={[24, 24]}>
          {enFeatures.map((f) => (
            <Col xs={24} sm={12} key={f.title}>
              <Card hoverable style={{ height: "100%", borderRadius: 12 }}>
                <Space direction="vertical" size={12}>
                  {f.icon}
                  <Title level={4} style={{ margin: 0 }}>{f.title}</Title>
                  <Text type="secondary">{f.desc}</Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      {/* Chinese Hero */}
      <div style={{ textAlign: "center", padding: "48px 20px 32px" }}>
        <Title level={3} style={{ color: "#555", marginBottom: 8 }}>
          广告自动化发布平台
        </Title>
        <Paragraph style={{ color: "#888", fontSize: 15, maxWidth: 540, margin: "0 auto" }}>
          商家领取 → 广告自动创建 → 文章自动生成 → 数据自动分析，一站式闭环管理
        </Paragraph>
      </div>

      {/* Chinese Features */}
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 20px 80px" }}>
        <Row gutter={[24, 24]}>
          {features.map((f) => (
            <Col xs={24} sm={12} key={f.title}>
              <Card hoverable style={{ height: "100%", borderRadius: 12 }}>
                <Space direction="vertical" size={12}>
                  {f.icon}
                  <Title level={4} style={{ margin: 0 }}>{f.title}</Title>
                  <Text type="secondary">{f.desc}</Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", padding: "30px 20px", borderTop: "1px solid #f0f0f0" }}>
        <Text style={{ color: "#999", display: "block", marginBottom: 8 }}>
          © 2026 Wenzhou Fengdu Advertising &amp; Media Co., Ltd. All rights reserved.
        </Text>
        <Space split={<Divider type="vertical" />} size={4}>
          <Link href="/about" style={{ color: "#999", fontSize: 13 }}>About Us</Link>
          <Link href="/demo" style={{ color: "#999", fontSize: 13 }}>Platform Demo</Link>
          <Link href="/privacy-policy" style={{ color: "#999", fontSize: 13 }}>Privacy Policy</Link>
          <Link href="/terms-of-service" style={{ color: "#999", fontSize: 13 }}>Terms of Service</Link>
        </Space>
      </div>
    </div>
  );
}
