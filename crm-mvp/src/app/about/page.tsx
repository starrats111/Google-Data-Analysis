"use client";

import { Typography, Space, Card, Divider, Button } from "antd";
import {
  RocketOutlined,
  EnvironmentOutlined,
  MailOutlined,
  TeamOutlined,
  GlobalOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import Link from "next/link";

const { Title, Paragraph, Text } = Typography;

export default function AboutPage() {
  const router = useRouter();

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
            Ad Automation Platform
          </Text>
        </Space>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push("/")}
        >
          Home
        </Button>
      </div>

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px 80px" }}>
        <Title level={1} style={{ color: "#1A7FDB", textAlign: "center" }}>
          About Us
        </Title>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <TeamOutlined style={{ marginRight: 8, color: "#4DA6FF" }} />
              Company Overview
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              Wenzhou Fengdu Advertising &amp; Media Co., Ltd. (温州丰度广告传媒有限公司) is a
              professional advertising technology company specializing in digital
              marketing solutions. We develop and operate an internal advertising
              campaign management and reporting platform that helps our team of
              advertising professionals efficiently manage Google Ads campaigns
              at scale.
            </Paragraph>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              Our platform integrates with the Google Ads API to provide
              end-to-end campaign management capabilities, including automated
              campaign creation, budget and bid optimization, performance
              reporting and analytics, and multi-account (MCC) management. The
              tool is designed exclusively for use by our internal team members
              and is not offered as a third-party service.
            </Paragraph>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <GlobalOutlined style={{ marginRight: 8, color: "#52c41a" }} />
              What We Do
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              Our core platform provides the following capabilities:
            </Paragraph>
            <ul style={{ fontSize: 16, lineHeight: 2.2, paddingLeft: 24 }}>
              <li>
                <Text strong>Campaign Management</Text> — Automated creation and
                management of Google Search campaigns, including budget
                allocation, bidding strategies, geographic and language targeting,
                ad groups, Responsive Search Ads, and keyword management.
              </li>
              <li>
                <Text strong>Budget &amp; Bid Optimization</Text> — Real-time
                campaign budget adjustments and ad group CPC bid updates directly
                from our dashboard.
              </li>
              <li>
                <Text strong>Performance Reporting</Text> — Daily campaign
                performance metrics (cost, clicks, impressions, average CPC,
                conversions) with historical analysis and ROI reporting.
              </li>
              <li>
                <Text strong>MCC Account Management</Text> — Multi-account
                management under MCC manager accounts, including child account
                listing, availability checking, and spending attribution.
              </li>
              <li>
                <Text strong>Ad Asset Management</Text> — Creation and management
                of campaign-level assets including sitelinks, callouts,
                promotions, price extensions, call extensions, structured
                snippets, and image assets.
              </li>
              <li>
                <Text strong>Data Synchronization</Text> — Automated daily
                synchronization of campaign metrics and status updates between
                Google Ads and our internal database.
              </li>
              <li>
                <Text strong>Content Automation</Text> — AI-powered SEO article
                generation and multi-site publishing for merchant promotion.
              </li>
            </ul>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <EnvironmentOutlined style={{ marginRight: 8, color: "#fa8c16" }} />
              Contact Information
            </Title>
            <div>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <Text strong>Company Name:</Text> Wenzhou Fengdu Advertising &amp;
                Media Co., Ltd.
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <Text strong>Chinese Name:</Text> 温州丰度广告传媒有限公司
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <Text strong>Address:</Text> Room 1110-2, Building 29, Huahong
                Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County,
                Wenzhou, Zhejiang, China
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
                <MailOutlined style={{ marginRight: 8 }} />
                <Text strong>Email:</Text>{" "}
                <a href="mailto:admin@google-data-analysis.top">
                  admin@google-data-analysis.top
                </a>
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
                <GlobalOutlined style={{ marginRight: 8 }} />
                <Text strong>Website:</Text>{" "}
                <a
                  href="https://google-data-analysis.top"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  google-data-analysis.top
                </a>
              </Paragraph>
            </div>
          </Space>
        </Card>

        <Divider />

        <div style={{ textAlign: "center", color: "#999" }}>
          <Paragraph style={{ color: "#999", marginBottom: 4 }}>
            © 2026 Wenzhou Fengdu Advertising &amp; Media Co., Ltd. All rights
            reserved.
          </Paragraph>
          <Space split={<Divider type="vertical" />}>
            <Link href="/privacy-policy">Privacy Policy</Link>
            <Link href="/terms-of-service">Terms of Service</Link>
          </Space>
        </div>
      </div>
    </div>
  );
}
