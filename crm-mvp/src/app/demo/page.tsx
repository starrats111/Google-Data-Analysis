"use client";

import { Typography, Space, Card, Divider, Button, Tag } from "antd";
import {
  RocketOutlined,
  ArrowLeftOutlined,
  ApiOutlined,
  BarChartOutlined,
  SettingOutlined,
  CloudSyncOutlined,
  DollarOutlined,
  TeamOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";

const { Title, Paragraph, Text } = Typography;

interface Screenshot {
  src?: string;
  images?: { src: string; caption: string }[];
  title: string;
  icon: React.ReactNode;
  apiTag: string;
  description: string;
  features: string[];
}

const screenshots: Screenshot[] = [
  {
    src: "/images/demo/data-center.png",
    title: "Data Center — Campaign Performance Dashboard",
    icon: <BarChartOutlined style={{ color: "#fa8c16" }} />,
    apiTag: "googleAds:searchStream",
    description:
      "Real-time campaign performance dashboard showing all Google Ads campaigns managed through our platform. Displays CID (Customer ID), campaign names, budget, max CPC, cost, clicks, commissions, refunds, net profit, and ROI for each campaign. Data is fetched daily from the Google Ads API using GAQL queries on campaign metrics (cost_micros, clicks, impressions, average_cpc, conversions).",
    features: [
      "Campaign-level metrics: cost, clicks, impressions, average CPC, conversions",
      "Date range filtering for historical performance analysis",
      "Filter by MCC account, campaign status, and campaign type",
      "Sync buttons for transaction data, MCC data, and CID accounts",
    ],
  },
  {
    images: [
      {
        src: "/images/demo/ad-creation-1.png",
        caption:
          "Step 1: Campaign setup — RSA headlines & descriptions, keyword configuration, MCC/CID account selection, budget, CPC, language, and network settings",
      },
      {
        src: "/images/demo/ad-creation-2.png",
        caption:
          "Step 2: Ad extensions — Sitelinks with URL validation, merchant image generation & upload for Google Ads compliance",
      },
      {
        src: "/images/demo/ad-creation-3.png",
        caption:
          "Step 3: Additional extensions — Callouts, Promotions, Price, Call, and Structured Snippets, all auto-generated from merchant data",
      },
    ],
    title: "Ad Creation — Full Campaign Setup & Submission",
    icon: <SettingOutlined style={{ color: "#1A7FDB" }} />,
    apiTag: "googleAds:mutate",
    description:
      "Complete campaign creation workflow. This page allows our team to build a full Google Search campaign in one interface — including 15 Responsive Search Ad headlines, 4 descriptions, keyword selection with match types, and all ad extensions (sitelinks, callouts, promotions, price, call, structured snippets). Once configured, the campaign is submitted directly to Google Ads via the API mutate endpoint.",
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
      "Our team sources merchants from major international affiliate networks such as CJ (Commission Junction), Impact, ShareASale, Awin, Rakuten, Creatorflare, and others. Each merchant is assigned to a team member who then creates and manages Google Ads Search campaigns to promote the merchant's products. Commissions earned from resulting sales are tracked in our platform's data center.",
    features: [
      "Merchant discovery from 7+ international affiliate networks",
      "Merchant assignment to team members for campaign management",
      "Commission and ROI tracking per merchant/campaign",
    ],
  },
];

export default function DemoPage() {
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
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.push("/")}>
          Home
        </Button>
      </div>

      <div
        style={{ maxWidth: 960, margin: "0 auto", padding: "40px 20px 80px" }}
      >
        <Title level={1} style={{ color: "#1A7FDB", textAlign: "center" }}>
          <ApiOutlined style={{ marginRight: 12 }} />
          Platform Demo
        </Title>
        <Paragraph
          style={{
            textAlign: "center",
            color: "#666",
            fontSize: 16,
            maxWidth: 700,
            margin: "0 auto 16px",
          }}
        >
          Below are screenshots of our Ad Automation CRM platform in
          production, demonstrating how we use the Google Ads API for campaign
          management, reporting, and optimization.
        </Paragraph>
        <Paragraph
          style={{ textAlign: "center", color: "#999", marginBottom: 48 }}
        >
          This platform is used exclusively by our internal team at Wenzhou
          Fengdu Advertising &amp; Media Co., Ltd.
        </Paragraph>

        {screenshots.map((s, idx) => (
          <Card
            key={idx}
            style={{
              borderRadius: 12,
              marginBottom: 32,
              overflow: "hidden",
            }}
          >
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                {s.icon}
                <Title level={3} style={{ margin: 0, flex: 1 }}>
                  {s.title}
                </Title>
                <Tag
                  color="blue"
                  style={{ fontSize: 13, padding: "2px 10px" }}
                >
                  API: {s.apiTag}
                </Tag>
              </div>

              {s.images ? (
                <Space
                  direction="vertical"
                  size={16}
                  style={{ width: "100%" }}
                >
                  {s.images.map((img, ii) => (
                    <div key={ii}>
                      <div
                        style={{
                          border: "1px solid #f0f0f0",
                          borderRadius: 8,
                          overflow: "hidden",
                          background: "#fafafa",
                        }}
                      >
                        <Image
                          src={img.src}
                          alt={img.caption}
                          width={920}
                          height={0}
                          style={{ width: "100%", height: "auto" }}
                          unoptimized
                        />
                      </div>
                      <Text
                        type="secondary"
                        style={{
                          display: "block",
                          textAlign: "center",
                          marginTop: 8,
                          fontSize: 13,
                        }}
                      >
                        {img.caption}
                      </Text>
                    </div>
                  ))}
                </Space>
              ) : (
                <div
                  style={{
                    border: "1px solid #f0f0f0",
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "#fafafa",
                  }}
                >
                  <Image
                    src={s.src!}
                    alt={s.title}
                    width={920}
                    height={0}
                    style={{ width: "100%", height: "auto" }}
                    unoptimized
                  />
                </div>
              )}

              <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
                {s.description}
              </Paragraph>

              <div>
                <Text strong style={{ fontSize: 14 }}>
                  Key Features:
                </Text>
                <ul style={{ fontSize: 14, lineHeight: 2, marginTop: 4 }}>
                  {s.features.map((f, fi) => (
                    <li key={fi}>{f}</li>
                  ))}
                </ul>
              </div>
            </Space>
          </Card>
        ))}

        <Card
          style={{
            borderRadius: 12,
            marginBottom: 32,
            background: "#f6f9fc",
          }}
        >
          <Title level={3} style={{ textAlign: "center" }}>
            Google Ads API Integration Summary
          </Title>
          <Paragraph
            style={{ textAlign: "center", fontSize: 15, lineHeight: 1.8 }}
          >
            Our platform integrates with the Google Ads API v23 via two
            primary REST endpoints:
          </Paragraph>
          <div
            style={{
              display: "flex",
              gap: 24,
              justifyContent: "center",
              flexWrap: "wrap",
              marginTop: 16,
            }}
          >
            <Card style={{ flex: 1, minWidth: 300, borderRadius: 8 }}>
              <Title level={4} style={{ color: "#1A7FDB" }}>
                Read Operations
              </Title>
              <Paragraph>
                <code>POST /customers/&#123;id&#125;/googleAds:searchStream</code>
              </Paragraph>
              <ul style={{ fontSize: 14, lineHeight: 2 }}>
                <li>Campaign performance metrics (daily)</li>
                <li>Campaign status and budget queries</li>
                <li>MCC child account enumeration</li>
                <li>CID availability checking</li>
                <li>Post-mutation status verification</li>
              </ul>
            </Card>
            <Card style={{ flex: 1, minWidth: 300, borderRadius: 8 }}>
              <Title level={4} style={{ color: "#52c41a" }}>
                Write Operations
              </Title>
              <Paragraph>
                <code>POST /customers/&#123;id&#125;/googleAds:mutate</code>
              </Paragraph>
              <ul style={{ fontSize: 14, lineHeight: 2 }}>
                <li>Campaign + budget + ad group + RSA creation</li>
                <li>Keyword addition with match types</li>
                <li>Ad asset creation (6 types + images)</li>
                <li>Budget and CPC bid updates</li>
                <li>Campaign enable/pause/remove</li>
              </ul>
            </Card>
          </div>
        </Card>

        <Divider />

        <div style={{ textAlign: "center", color: "#999" }}>
          <Paragraph style={{ color: "#999", marginBottom: 4 }}>
            &copy; 2026 Wenzhou Fengdu Advertising &amp; Media Co., Ltd. All
            rights reserved.
          </Paragraph>
          <Space split={<Divider type="vertical" />}>
            <Link href="/about">About Us</Link>
            <Link href="/privacy-policy">Privacy Policy</Link>
            <Link href="/terms-of-service">Terms of Service</Link>
          </Space>
        </div>
      </div>
    </div>
  );
}
