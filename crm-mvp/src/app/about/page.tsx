"use client";

import { Typography, Space, Card, Divider, Button } from "antd";
import {
  RocketOutlined,
  EnvironmentOutlined,
  MailOutlined,
  TeamOutlined,
  GlobalOutlined,
  ArrowLeftOutlined,
  LinkOutlined,
  DollarOutlined,
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
              <DollarOutlined style={{ marginRight: 8, color: "#fa8c16" }} />
              Our Business Model
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              Wenzhou Fengdu Advertising &amp; Media Co., Ltd. is an{" "}
              <Text strong>affiliate marketing company</Text>. Our business
              involves identifying commercial opportunities through major
              international affiliate networks — including Commission Junction
              (CJ), Impact, ShareASale, Awin, Rakuten, and others — and
              promoting these partner merchants by running Google Search
              Advertising campaigns that drive qualified traffic to their
              websites. We earn commissions on resulting sales or conversions.
            </Paragraph>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              Our internal team of advertising professionals manages all Google
              Ads campaigns in-house. To operate this affiliate marketing
              business at scale across multiple international markets and
              languages, we have developed the Ad Automation CRM — an internal
              platform that integrates with the Google Ads API to automate and
              streamline the full campaign management workflow.
            </Paragraph>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              All advertising campaigns are run exclusively by our internal
              employees. We do not offer advertising management or this platform
              as a service to third-party clients.
            </Paragraph>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <GlobalOutlined style={{ marginRight: 8, color: "#52c41a" }} />
              Platform Capabilities
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              Our Ad Automation CRM platform provides the following capabilities
              to support our affiliate marketing operations:
            </Paragraph>
            <ul style={{ fontSize: 16, lineHeight: 2.2, paddingLeft: 24 }}>
              <li>
                <Text strong>Affiliate Merchant Management</Text> — Source and
                manage partner merchants from 7 major international affiliate
                networks; assign merchants to team members and track campaign
                status.
              </li>
              <li>
                <Text strong>Google Ads Campaign Automation</Text> — Automated
                creation and management of Google Search campaigns, including
                budget allocation, bidding strategies (Manual CPC, Target CPA,
                Maximize Clicks), geographic and language targeting, ad groups,
                Responsive Search Ads, and keyword management.
              </li>
              <li>
                <Text strong>Budget &amp; Bid Control</Text> — Real-time
                campaign budget adjustments and ad group CPC bid updates
                directly from our dashboard.
              </li>
              <li>
                <Text strong>Performance &amp; ROI Reporting</Text> — Daily
                campaign performance metrics (cost, clicks, impressions, average
                CPC, conversions) combined with affiliate commission tracking
                for ROI analysis and data-driven optimization.
              </li>
              <li>
                <Text strong>MCC Account Management</Text> — Multi-account
                management under MCC manager accounts, including child account
                listing, availability checking, and spending attribution per
                merchant.
              </li>
              <li>
                <Text strong>Ad Asset Management</Text> — Creation and
                management of campaign-level assets including sitelinks,
                callouts, promotions, price extensions, call extensions,
                structured snippets, and image assets.
              </li>
              <li>
                <Text strong>Data Synchronization</Text> — Automated daily
                synchronization of campaign metrics and status updates between
                Google Ads and our internal database.
              </li>
              <li>
                <Text strong>Content Automation</Text> — AI-powered SEO article
                generation and multi-site publishing to support organic
                promotion of affiliate merchants alongside paid search
                campaigns.
              </li>
            </ul>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 32 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={3} style={{ margin: 0 }}>
              <LinkOutlined style={{ marginRight: 8, color: "#722ed1" }} />
              How We Use the Google Ads API
            </Title>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              Our platform integrates with the Google Ads API v23 to manage
              Search campaigns across multiple Google Ads accounts under our
              MCC manager accounts. The API is used exclusively for internal
              campaign management and reporting operations. Key API functions
              include:
            </Paragraph>
            <ul style={{ fontSize: 16, lineHeight: 2.2, paddingLeft: 24 }}>
              <li>
                Creating and modifying campaigns, ad groups, Responsive Search
                Ads, keywords, and campaign-level assets via{" "}
                <Text code>googleAds:mutate</Text>
              </li>
              <li>
                Querying campaign performance metrics, account information, and
                status via <Text code>googleAds:searchStream</Text> (GAQL)
              </li>
              <li>
                Managing multiple Google Ads sub-accounts under our MCC,
                including child account enumeration and availability checking
              </li>
              <li>
                Performing automated daily data synchronization to update
                campaign metrics and status in our internal database
              </li>
            </ul>
            <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
              All Google Ads data accessed through the API is used solely for
              our internal affiliate marketing campaign management and
              reporting. We do not share, resell, or expose this data to
              external parties.
            </Paragraph>
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
                <a href="mailto:admin@fengdu-ads.top">
                  admin@fengdu-ads.top
                </a>
              </Paragraph>
              <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
                <GlobalOutlined style={{ marginRight: 8 }} />
                <Text strong>Website:</Text>{" "}
                <a
                  href="https://fengdu-ads.top"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  fengdu-ads.top
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
