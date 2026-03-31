"use client";

import { Typography, Space, Card, Divider, Button } from "antd";
import {
  RocketOutlined,
  ArrowLeftOutlined,
  FileProtectOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import Link from "next/link";

const { Title, Paragraph, Text } = Typography;

export default function TermsOfServicePage() {
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
          <FileProtectOutlined style={{ marginRight: 12 }} />
          Terms of Service
        </Title>
        <Paragraph
          style={{ textAlign: "center", color: "#999", marginBottom: 40 }}
        >
          Last updated: March 31, 2026
        </Paragraph>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>1. Acceptance of Terms</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            By accessing or using the Ad Automation Platform operated by Wenzhou
            Fengdu Advertising &amp; Media Co., Ltd. (&quot;we&quot;,
            &quot;us&quot;, or &quot;the Company&quot;), you agree to be bound by
            these Terms of Service. If you do not agree to these terms, you may
            not access or use the Service.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>2. Description of Service</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            The Service is an internal advertising campaign management and
            reporting platform designed for authorized team members. It provides
            the following capabilities:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Google Ads campaign creation, management, and optimization.
            </li>
            <li>Campaign budget and bid control.</li>
            <li>
              Performance reporting and analytics with daily data
              synchronization.
            </li>
            <li>
              Multi-account (MCC) management for Google Ads accounts.
            </li>
            <li>
              Ad asset management including sitelinks, callouts, promotions,
              price extensions, and image assets.
            </li>
            <li>
              AI-powered content generation for SEO articles and advertising
              copy.
            </li>
            <li>Affiliate transaction tracking and commission reporting.</li>
          </ul>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            The Service is intended for internal use by the Company&apos;s
            authorized personnel and is not offered as a public or third-party
            service.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>3. User Accounts</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            Access to the Service requires an authorized user account. Users are
            responsible for:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Maintaining the confidentiality of their account credentials.
            </li>
            <li>
              All activities that occur under their account.
            </li>
            <li>
              Notifying the administrator immediately of any unauthorized use of
              their account.
            </li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>4. Acceptable Use</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            Users agree to use the Service only for its intended purpose of
            advertising campaign management and in compliance with:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              All applicable laws and regulations.
            </li>
            <li>
              <a
                href="https://ads.google.com/intl/en/home/terms/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google Ads Terms of Service
              </a>{" "}
              and{" "}
              <a
                href="https://developers.google.com/google-ads/api/docs/terms"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google Ads API Terms and Conditions
              </a>
              .
            </li>
            <li>
              Company policies regarding advertising content and spending.
            </li>
          </ul>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            Users must not attempt to gain unauthorized access to any part of the
            Service, interfere with its operation, or use the Service for any
            unlawful purpose.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>5. Intellectual Property</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            The Service, including its design, code, features, and content, is
            the intellectual property of Wenzhou Fengdu Advertising &amp; Media
            Co., Ltd. Users are granted a limited, non-transferable right to use
            the Service for authorized purposes only.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>6. Data and Google Ads API Usage</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            The Service accesses Google Ads data through the Google Ads API. All
            Google Ads data is used in accordance with Google&apos;s API Terms
            and Conditions. Users acknowledge that:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Google Ads campaign operations performed through the Service are
              subject to Google Ads policies.
            </li>
            <li>
              The Company is responsible for ensuring compliant use of the Google
              Ads API.
            </li>
            <li>
              Campaign data synchronized to the platform is used for internal
              reporting and optimization purposes.
            </li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>7. Limitation of Liability</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            The Service is provided &quot;as is&quot; without warranties of any
            kind. The Company shall not be liable for any indirect, incidental,
            special, or consequential damages arising from the use of the
            Service, including but not limited to:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Advertising campaign performance or advertising spend outcomes.
            </li>
            <li>
              Data loss or service interruptions.
            </li>
            <li>
              Third-party service availability (including Google Ads API).
            </li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>8. Termination</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            The Company reserves the right to suspend or terminate any
            user&apos;s access to the Service at any time, with or without cause.
            Upon termination, the user&apos;s right to access the Service will
            immediately cease.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>9. Changes to Terms</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            We reserve the right to modify these Terms of Service at any time.
            Changes will be posted on this page with an updated &quot;Last
            updated&quot; date. Continued use of the Service after any changes
            constitutes acceptance of the revised terms.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>10. Governing Law</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            These Terms shall be governed by and construed in accordance with the
            laws of the People&apos;s Republic of China. Any disputes arising
            from the use of the Service shall be subject to the jurisdiction of
            the competent courts in Wenzhou, Zhejiang, China.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>11. Contact</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            For questions about these Terms of Service, please contact:
          </Paragraph>
          <Paragraph style={{ fontSize: 15 }}>
            <Text strong>Wenzhou Fengdu Advertising &amp; Media Co., Ltd.</Text>
            <br />
            Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue,
            Luoyang Town, Taishun County, Wenzhou, Zhejiang, China
            <br />
            Email:{" "}
            <a href="mailto:admin@google-data-analysis.top">
              admin@google-data-analysis.top
            </a>
          </Paragraph>
        </Card>

        <Divider />

        <div style={{ textAlign: "center", color: "#999" }}>
          <Paragraph style={{ color: "#999", marginBottom: 4 }}>
            © 2026 Wenzhou Fengdu Advertising &amp; Media Co., Ltd. All rights
            reserved.
          </Paragraph>
          <Space split={<Divider type="vertical" />}>
            <Link href="/about">About Us</Link>
            <Link href="/privacy-policy">Privacy Policy</Link>
          </Space>
        </div>
      </div>
    </div>
  );
}
