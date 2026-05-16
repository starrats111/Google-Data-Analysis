"use client";

import { Typography } from "antd";
import { SafetyOutlined } from "@ant-design/icons";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";
import { MARKETING, MK_SPACING, MK_RADIUS } from "@/styles/marketingTokens";

const { Title, Paragraph, Text } = Typography;

const i18n = {
  en: {
    pageTitle: "Privacy Policy",
    lastUpdated: "Last updated: March 31, 2026",
    sections: [
      {
        title: "1. Introduction",
        content: 'Wenzhou Fengdu Advertising & Media Co., Ltd. ("we", "us", or "our") is an affiliate marketing company that operates the Ad Automation CRM platform at fengdu-ads.top (the "Service"). The Service is an internal tool used exclusively by our employees to manage our own Google Ads campaigns under our own Google Ads Manager (MCC) account. This Privacy Policy describes how we collect, use, and protect information when authorized employees use our Service.',
      },
      {
        title: "2. Information We Collect",
        content: "We collect the following types of information:",
        items: [
          { bold: "Account Information:", text: " Username, email address, and role information required for platform access." },
          { bold: "Google Ads Data:", text: " Campaign performance metrics, account identifiers, and advertising data accessed through the Google Ads API on behalf of authorized users." },
          { bold: "Usage Data:", text: " Log data, access timestamps, and feature usage information for platform operation and improvement." },
          { bold: "Affiliate Transaction Data:", text: " Commission and transaction records from affiliated advertising platforms for reporting purposes." },
        ],
      },
      {
        title: "3. How We Use Information",
        content: "We use the collected information for the following purposes:",
        items: [
          { text: "Operating and maintaining the advertising campaign management platform." },
          { text: "Managing Google Ads campaigns, including creation, optimization, budget control, and performance reporting." },
          { text: "Synchronizing campaign data between Google Ads and our internal database for analytics and reporting." },
          { text: "Generating performance reports and data visualizations for authorized team members." },
          { text: "Ensuring platform security and preventing unauthorized access." },
        ],
      },
      {
        title: "4. Data Protection",
        content: "We implement appropriate technical and organizational measures to protect information, including:",
        items: [
          { text: "Encrypted data transmission using HTTPS/TLS for all communications." },
          { text: "Secure authentication using bcrypt password hashing and JWT tokens with httpOnly cookies." },
          { text: "Role-based access control separating user and administrator privileges." },
          { text: "Rate limiting to prevent brute-force attacks and unauthorized access attempts." },
          { text: "Security response headers including X-Frame-Options, HSTS, and X-Content-Type-Options." },
          { text: "Restricted API access with developer tokens and service account authentication for Google Ads API integration." },
        ],
      },
      {
        title: "5. Third-Party Services",
        content: "Our platform integrates with the following third-party services:",
        items: [
          { bold: "Google Ads API:", text: " For campaign management, performance reporting, and account operations. Use of Google Ads data is governed by Google Ads API Terms and Conditions." },
          { bold: "Affiliate Networks:", text: " For commission tracking and transaction data synchronization." },
          { bold: "AI Services:", text: " For content generation and keyword optimization, processing only non-personal advertising data." },
        ],
      },
      {
        title: "6. Data Retention",
        content: "We retain data for as long as necessary to provide our services and comply with legal obligations. Campaign performance data is retained for reporting and analysis purposes. Users may request data deletion by contacting us at the email address below.",
      },
      {
        title: "7. Your Rights",
        content: "Authorized users of our platform have the right to:",
        items: [
          { text: "Access their personal data stored in the platform." },
          { text: "Request correction of inaccurate information." },
          { text: "Request deletion of their account and associated data." },
          { text: "Receive information about how their data is processed and stored." },
        ],
      },
      {
        title: "8. Changes to This Policy",
        content: 'We may update this Privacy Policy from time to time. We will notify users of any material changes by posting the updated policy on this page with a revised "Last updated" date.',
      },
      {
        title: "9. Contact Us",
        content: "If you have any questions about this Privacy Policy, please contact us:",
        contact: { name: "Wenzhou Fengdu Advertising & Media Co., Ltd.", addr: "Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County, Wenzhou, Zhejiang, China", emailLabel: "Email: " },
      },
    ],
  },
  zh: {
    pageTitle: "隐私政策",
    lastUpdated: "最后更新：2026年3月31日",
    sections: [
      {
        title: "1. 简介",
        content: "温州丰度广告传媒有限公司（以下简称\u201c我们\u201d）是一家联盟营销公司，运营位于 fengdu-ads.top 的 Ad Automation CRM 平台（以下简称\u201c本服务\u201d）。本服务为内部工具，仅供公司员工在我们自有的 Google Ads 经理账户（MCC）下管理自有的 Google 广告。本隐私政策说明授权员工使用本服务时我们如何收集、使用和保护信息。",
      },
      {
        title: "2. 我们收集的信息",
        content: "我们收集以下类型的信息：",
        items: [
          { bold: "账户信息：", text: "平台访问所需的用户名、电子邮箱和角色信息。" },
          { bold: "Google Ads 数据：", text: "通过 Google Ads API 代表授权用户访问的广告系列效果指标、账户标识和广告数据。" },
          { bold: "使用数据：", text: "用于平台运营和改进的日志数据、访问时间戳和功能使用信息。" },
          { bold: "联盟交易数据：", text: "来自联盟广告平台的佣金和交易记录，用于报告目的。" },
        ],
      },
      {
        title: "3. 信息用途",
        content: "我们将收集的信息用于以下目的：",
        items: [
          { text: "运营和维护广告系列管理平台。" },
          { text: "管理 Google Ads 广告系列，包括创建、优化、预算控制和效果报告。" },
          { text: "在 Google Ads 和内部数据库之间同步广告数据用于分析和报告。" },
          { text: "为授权团队成员生成效果报告和数据可视化。" },
          { text: "确保平台安全并防止未授权访问。" },
        ],
      },
      {
        title: "4. 数据保护",
        content: "我们实施适当的技术和组织措施来保护信息，包括：",
        items: [
          { text: "所有通信均使用 HTTPS/TLS 加密传输。" },
          { text: "使用 bcrypt 密码哈希和 httpOnly Cookie 的 JWT 令牌进行安全认证。" },
          { text: "基于角色的访问控制，分离用户和管理员权限。" },
          { text: "速率限制以防止暴力破解和未授权访问。" },
          { text: "安全响应头，包括 X-Frame-Options、HSTS 和 X-Content-Type-Options。" },
          { text: "使用开发者令牌和服务账户认证限制 Google Ads API 访问。" },
        ],
      },
      {
        title: "5. 第三方服务",
        content: "我们的平台与以下第三方服务集成：",
        items: [
          { bold: "Google Ads API：", text: "用于广告管理、效果报告和账户操作。Google Ads 数据的使用受 Google Ads API 条款和条件约束。" },
          { bold: "联盟网络：", text: "用于佣金跟踪和交易数据同步。" },
          { bold: "AI 服务：", text: "用于内容生成和关键词优化，仅处理非个人广告数据。" },
        ],
      },
      {
        title: "6. 数据保留",
        content: "我们在提供服务和遵守法律义务所需的时间内保留数据。广告效果数据保留用于报告和分析。用户可通过以下邮箱联系我们请求删除数据。",
      },
      {
        title: "7. 您的权利",
        content: "本平台的授权用户有权：",
        items: [
          { text: "访问存储在平台中的个人数据。" },
          { text: "请求更正不准确的信息。" },
          { text: "请求删除其账户和关联数据。" },
          { text: "了解其数据的处理和存储方式。" },
        ],
      },
      {
        title: "8. 政策变更",
        content: "我们可能不时更新本隐私政策。我们将通过在本页面发布更新后的政策并修改\u201c最后更新\u201d日期来通知用户重大变更。",
      },
      {
        title: "9. 联系我们",
        content: "如您对本隐私政策有任何疑问，请联系我们：",
        contact: { name: "温州丰度广告传媒有限公司", addr: "浙江省温州市泰顺县罗阳镇新城大道华鸿心广场29幢1110室-2", emailLabel: "邮箱：" },
      },
    ],
  },
};

export default function PrivacyPolicyPage() {
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: MARKETING.bgPage, color: MARKETING.text }}>
      <PageHeader showHome />

      {/* Hero */}
      <section
        style={{
          background: MARKETING.bgHeroGradient,
          padding: `${MK_SPACING.hero}px 24px ${MK_SPACING.lg}px`,
          textAlign: "center",
          borderBottom: `1px solid ${MARKETING.border}`,
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              borderRadius: MK_RADIUS.lg,
              background: MARKETING.primaryLight,
              color: MARKETING.primaryDark,
              fontSize: 24,
              marginBottom: 20,
              boxShadow: MARKETING.shadowMedium,
            }}
          >
            <SafetyOutlined />
          </div>
          <Title
            style={{
              fontSize: "clamp(28px, 4.5vw, 40px)",
              fontWeight: 800,
              color: MARKETING.text,
              margin: "0 0 12px",
              letterSpacing: -0.3,
              lineHeight: 1.15,
            }}
          >
            {t.pageTitle}
          </Title>
          <Paragraph style={{ color: MARKETING.textMuted, fontSize: 14, margin: 0 }}>
            {t.lastUpdated}
          </Paragraph>
        </div>
      </section>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: `${MK_SPACING.lg}px 24px ${MK_SPACING.xl}px` }}>
        {t.sections.map((s) => (
          <div
            key={s.title}
            style={{
              background: MARKETING.bgCard,
              border: `1px solid ${MARKETING.border}`,
              borderRadius: MK_RADIUS.lg,
              padding: `${MK_SPACING.md}px ${MK_SPACING.lg}px`,
              boxShadow: MARKETING.shadowMedium,
              marginBottom: MK_SPACING.md,
            }}
          >
            <Title level={2} style={{ fontSize: 20, fontWeight: 700, color: MARKETING.text, marginTop: 0, marginBottom: 12 }}>
              {s.title}
            </Title>
            <Paragraph style={{ fontSize: 15, lineHeight: 1.8, color: MARKETING.textSub }}>{s.content}</Paragraph>
            {s.items && (
              <ul style={{ fontSize: 15, lineHeight: 1.95, paddingLeft: 20, color: MARKETING.textSub }}>
                {s.items.map((item, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    {item.bold && <Text strong style={{ color: MARKETING.text }}>{item.bold}</Text>}
                    {item.text}
                  </li>
                ))}
              </ul>
            )}
            {s.contact && (
              <div
                style={{
                  marginTop: 12,
                  padding: 14,
                  background: MARKETING.primaryLight,
                  borderRadius: MK_RADIUS.md,
                  fontSize: 14.5,
                  color: MARKETING.text,
                  lineHeight: 1.75,
                }}
              >
                <Text strong style={{ color: MARKETING.text }}>{s.contact.name}</Text>
                <br />
                {s.contact.addr}
                <br />
                {s.contact.emailLabel}
                <a href="mailto:connect@fengdu-ads.top" style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>
                  connect@fengdu-ads.top
                </a>
              </div>
            )}
          </div>
        ))}
      </div>

      <PageFooter />
    </div>
  );
}
