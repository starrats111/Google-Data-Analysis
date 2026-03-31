"use client";

import { Typography, Space, Card, Divider, Button } from "antd";
import {
  RocketOutlined,
  ArrowLeftOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import Link from "next/link";

const { Title, Paragraph, Text } = Typography;

export default function PrivacyPolicyPage() {
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
          <SafetyOutlined style={{ marginRight: 12 }} />
          Privacy Policy
        </Title>
        <Paragraph
          style={{ textAlign: "center", color: "#999", marginBottom: 40 }}
        >
          Last updated: March 31, 2026
        </Paragraph>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>1. Introduction</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            Wenzhou Fengdu Advertising &amp; Media Co., Ltd. (&quot;we&quot;,
            &quot;us&quot;, or &quot;our&quot;) operates the Ad Automation
            Platform at google-data-analysis.top (the &quot;Service&quot;). This
            Privacy Policy describes how we collect, use, and protect information
            when you use our Service.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>2. Information We Collect</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            We collect the following types of information:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              <Text strong>Account Information:</Text> Username, email address,
              and role information required for platform access.
            </li>
            <li>
              <Text strong>Google Ads Data:</Text> Campaign performance metrics,
              account identifiers, and advertising data accessed through the
              Google Ads API on behalf of authorized users.
            </li>
            <li>
              <Text strong>Usage Data:</Text> Log data, access timestamps, and
              feature usage information for platform operation and improvement.
            </li>
            <li>
              <Text strong>Affiliate Transaction Data:</Text> Commission and
              transaction records from affiliated advertising platforms for
              reporting purposes.
            </li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>3. How We Use Information</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            We use the collected information for the following purposes:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Operating and maintaining the advertising campaign management
              platform.
            </li>
            <li>
              Managing Google Ads campaigns, including creation, optimization,
              budget control, and performance reporting.
            </li>
            <li>
              Synchronizing campaign data between Google Ads and our internal
              database for analytics and reporting.
            </li>
            <li>
              Generating performance reports and data visualizations for
              authorized team members.
            </li>
            <li>Ensuring platform security and preventing unauthorized access.</li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>4. Data Protection</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            We implement appropriate technical and organizational measures to
            protect information, including:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              Encrypted data transmission using HTTPS/TLS for all communications.
            </li>
            <li>
              Secure authentication using bcrypt password hashing and JWT tokens
              with httpOnly cookies.
            </li>
            <li>
              Role-based access control separating user and administrator
              privileges.
            </li>
            <li>
              Rate limiting to prevent brute-force attacks and unauthorized
              access attempts.
            </li>
            <li>
              Security response headers including X-Frame-Options, HSTS, and
              X-Content-Type-Options.
            </li>
            <li>
              Restricted API access with developer tokens and service account
              authentication for Google Ads API integration.
            </li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>5. Third-Party Services</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            Our platform integrates with the following third-party services:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>
              <Text strong>Google Ads API:</Text> For campaign management,
              performance reporting, and account operations. Use of Google Ads
              data is governed by{" "}
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
              <Text strong>Affiliate Networks:</Text> For commission tracking and
              transaction data synchronization.
            </li>
            <li>
              <Text strong>AI Services:</Text> For content generation and keyword
              optimization, processing only non-personal advertising data.
            </li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>6. Data Retention</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            We retain data for as long as necessary to provide our services and
            comply with legal obligations. Campaign performance data is retained
            for reporting and analysis purposes. Users may request data deletion
            by contacting us at the email address below.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>7. Your Rights</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            Authorized users of our platform have the right to:
          </Paragraph>
          <ul style={{ fontSize: 15, lineHeight: 2 }}>
            <li>Access their personal data stored in the platform.</li>
            <li>Request correction of inaccurate information.</li>
            <li>Request deletion of their account and associated data.</li>
            <li>
              Receive information about how their data is processed and stored.
            </li>
          </ul>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>8. Changes to This Policy</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            We may update this Privacy Policy from time to time. We will notify
            users of any material changes by posting the updated policy on this
            page with a revised &quot;Last updated&quot; date.
          </Paragraph>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Title level={3}>9. Contact Us</Title>
          <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
            If you have any questions about this Privacy Policy, please contact
            us:
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
            <Link href="/terms-of-service">Terms of Service</Link>
          </Space>
        </div>
      </div>
    </div>
  );
}
