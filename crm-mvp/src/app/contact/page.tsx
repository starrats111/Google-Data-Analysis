"use client";

import { useState } from "react";
import { Typography, Button, message } from "antd";
import {
  MailOutlined,
  PhoneOutlined,
  EnvironmentOutlined,
  GlobalOutlined,
  ClockCircleOutlined,
  ContactsOutlined,
  BankOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";
import { MARKETING, MK_SPACING, MK_FONT, MK_RADIUS } from "@/styles/marketingTokens";

const { Title, Paragraph, Text } = Typography;

const COMPANY_PHONE = "+86 13958988973";
const COMPANY_EMAIL = "connect@fengdu-ads.top";

function buildMailtoHref(lang: "en" | "zh") {
  const subject = encodeURIComponent(
    lang === "zh" ? "咨询 — 温州丰度广告传媒有限公司" : "Inquiry — Wenzhou Fengdu Advertising & Media",
  );
  const body = encodeURIComponent(
    lang === "zh"
      ? "您好，\n\n我想咨询：\n\n（请在此填写您的问题）\n\n谢谢。"
      : "Hello,\n\nI would like to inquire about:\n\n(Please describe your question here)\n\nThank you.",
  );
  return `mailto:${COMPANY_EMAIL}?subject=${subject}&body=${body}`;
}

function buildGmailComposeHref(lang: "en" | "zh") {
  const subject = lang === "zh" ? "咨询 — 温州丰度广告传媒有限公司" : "Inquiry — Wenzhou Fengdu Advertising & Media";
  const body =
    lang === "zh"
      ? "您好，\n\n我想咨询：\n\n（请在此填写您的问题）\n\n谢谢。"
      : "Hello,\n\nI would like to inquire about:\n\n(Please describe your question here)\n\nThank you.";
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: COMPANY_EMAIL,
    su: subject,
    body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}
const COMPANY_ADDRESS_EN =
  "Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County, Wenzhou, Zhejiang, China";
const COMPANY_ADDRESS_ZH = "中国 浙江省 温州市 泰顺县 罗阳镇 新城大道 华鸿心广场 29 幢 1110 室-2";
const POSTAL_CODE = "325500";

const i18n = {
  en: {
    pageTitle: "Get in touch",
    pageSubtitle:
      "Wenzhou Fengdu Advertising & Media Co., Ltd., founded December 2025 — we welcome inquiries from partner merchants, affiliate networks, and Google business representatives.",
    contactBlock: "Contact Information",
    companyLabel: "Company",
    companyName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    cnLabel: "Chinese Name",
    cnName: "温州丰度广告传媒有限公司",
    phoneLabel: "Phone (China)",
    emailLabel: "Email",
    addrLabel: "Address (China)",
    postalLabel: "Postal Code",
    websiteLabel: "Website",
    hoursTitle: "Business Hours",
    hoursContent: "Monday – Friday, 09:00 – 18:00 (China Standard Time, GMT+8)",
    hoursNote: "We respond to email inquiries within one business day.",
    emailCtaTitle: "Send us an email",
    emailCtaDesc: "Compose a message directly to our team. We reply within one business day.",
    emailCtaBtn: "Email Us Now",
    gmailCtaBtn: "Open in Gmail (web)",
    copyEmailBtn: "Copy email address",
    copyEmailOk: "Email copied to clipboard",
    mailtoHint:
      "If nothing opens when you click, your PC may not have a default mail app. Use Gmail (web) or copy the address and send from your mailbox.",
    callCtaTitle: "Call our office",
    callCtaDesc: "Reach us by phone during business hours (GMT+8).",
    callCtaBtn: "Call Us Now",
  },
  zh: {
    pageTitle: "联系我们",
    pageSubtitle:
      "温州丰度广告传媒有限公司成立于 2025 年 12 月，欢迎合作商家、联盟营销网络以及 Google 业务方的咨询。",
    contactBlock: "联系方式",
    companyLabel: "公司名称",
    companyName: "温州丰度广告传媒有限公司",
    cnLabel: "英文名称",
    cnName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    phoneLabel: "中国联系电话",
    emailLabel: "电子邮箱",
    addrLabel: "中国联系地址",
    postalLabel: "邮政编码",
    websiteLabel: "公司网址",
    hoursTitle: "工作时间",
    hoursContent: "周一至周五，09:00 – 18:00（北京时间，GMT+8）",
    hoursNote: "我们将在 1 个工作日内回复邮件咨询。",
    emailCtaTitle: "发送邮件",
    emailCtaDesc: "点击下方按钮直接给我们发送邮件，1 个工作日内回复。",
    emailCtaBtn: "立即发送邮件",
    gmailCtaBtn: "在 Gmail 网页版写信",
    copyEmailBtn: "复制邮箱地址",
    copyEmailOk: "邮箱已复制到剪贴板",
    mailtoHint:
      "若点击后没有弹出邮件程序，说明本机未设置默认邮件客户端。请用「Gmail 网页版写信」或复制邮箱后，在您常用的邮箱里手动发送。",
    callCtaTitle: "电话咨询",
    callCtaDesc: "工作时间内可拨打我们的联系电话（GMT+8）。",
    callCtaBtn: "立即拨打电话",
  },
} as const;

function InfoRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "14px 0",
        borderBottom: `1px solid ${MARKETING.border}`,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: MK_RADIUS.md,
          background: MARKETING.primaryLight,
          color: MARKETING.primaryDark,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 18,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            color: MARKETING.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          {label}
        </div>
        <div style={{ fontSize: 15, color: MARKETING.text, lineHeight: 1.6, wordBreak: "break-word" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function ContactPage() {
  const { lang } = useLanguage();
  const t = i18n[lang];
  const [copying, setCopying] = useState(false);
  const mailtoHref = buildMailtoHref(lang);

  const copyEmail = async () => {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(COMPANY_EMAIL);
      message.success(t.copyEmailOk);
    } catch {
      message.info(COMPANY_EMAIL);
    } finally {
      setCopying(false);
    }
  };

  const btnBaseStyle: React.CSSProperties = {
    width: "100%",
    height: 42,
    fontWeight: 600,
    borderRadius: MK_RADIUS.md,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    textDecoration: "none",
    boxSizing: "border-box",
  };

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
              width: 64,
              height: 64,
              borderRadius: MK_RADIUS.lg,
              background: MARKETING.primaryLight,
              color: MARKETING.primaryDark,
              fontSize: 28,
              marginBottom: 20,
              boxShadow: MARKETING.shadowMedium,
            }}
          >
            <ContactsOutlined />
          </div>
          <Title
            style={{
              fontSize: "clamp(32px, 5vw, 44px)",
              fontWeight: 800,
              color: MARKETING.text,
              margin: "0 0 12px",
              letterSpacing: -0.3,
              lineHeight: 1.15,
            }}
          >
            {t.pageTitle}
          </Title>
          <Paragraph
            style={{
              color: MARKETING.textSub,
              fontSize: MK_FONT.body,
              maxWidth: 600,
              margin: "0 auto",
              lineHeight: 1.7,
            }}
          >
            {t.pageSubtitle}
          </Paragraph>
        </div>
      </section>

      {/* 主内容 */}
      <section style={{ padding: `${MK_SPACING.lg}px 24px ${MK_SPACING.xl}px` }}>
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
            gap: MK_SPACING.md,
          }}
          className="contact-grid"
        >
          {/* 左：联系信息 */}
          <div
            style={{
              background: MARKETING.bgCard,
              border: `1px solid ${MARKETING.border}`,
              borderRadius: MK_RADIUS.lg,
              padding: `${MK_SPACING.md}px ${MK_SPACING.lg}px`,
              boxShadow: MARKETING.shadowMedium,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <BankOutlined style={{ color: MARKETING.primaryDark, fontSize: 18 }} />
              <Text strong style={{ fontSize: 18, color: MARKETING.text }}>
                {t.contactBlock}
              </Text>
            </div>

            <InfoRow icon={<BankOutlined />} label={t.companyLabel}>
              {t.companyName}
            </InfoRow>
            <InfoRow icon={<BankOutlined />} label={t.cnLabel}>
              {t.cnName}
            </InfoRow>
            <InfoRow icon={<PhoneOutlined />} label={t.phoneLabel}>
              <a href={`tel:${COMPANY_PHONE.replace(/\s/g, "")}`} style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>
                {COMPANY_PHONE}
              </a>
            </InfoRow>
            <InfoRow icon={<MailOutlined />} label={t.emailLabel}>
              <a href={mailtoHref} style={{ color: MARKETING.primaryDark, fontWeight: 600 }}>
                {COMPANY_EMAIL}
              </a>
            </InfoRow>
            <InfoRow icon={<EnvironmentOutlined />} label={t.addrLabel}>
              {lang === "en" ? COMPANY_ADDRESS_EN : COMPANY_ADDRESS_ZH}
              <div style={{ color: MARKETING.textMuted, fontSize: 13, marginTop: 4 }}>
                {t.postalLabel}: {POSTAL_CODE}
              </div>
            </InfoRow>
            <div style={{ marginBottom: -14 }}>
              <InfoRow icon={<GlobalOutlined />} label={t.websiteLabel}>
                <a
                  href="https://fengdu-ads.top"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: MARKETING.primaryDark, fontWeight: 600 }}
                >
                  https://fengdu-ads.top
                </a>
              </InfoRow>
            </div>
          </div>

          {/* 右：CTA + 工作时间 */}
          <div style={{ display: "flex", flexDirection: "column", gap: MK_SPACING.md }}>
            {/* Email CTA */}
            <div
              style={{
                background: MARKETING.bgCard,
                border: `1px solid ${MARKETING.border}`,
                borderRadius: MK_RADIUS.lg,
                padding: MK_SPACING.md,
                boxShadow: MARKETING.shadowMedium,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: MK_RADIUS.md,
                  background: MARKETING.primaryLight,
                  color: MARKETING.primaryDark,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  marginBottom: 12,
                }}
              >
                <MailOutlined />
              </div>
              <Text strong style={{ fontSize: 16, color: MARKETING.text, display: "block", marginBottom: 4 }}>
                {t.emailCtaTitle}
              </Text>
              <Paragraph style={{ color: MARKETING.textSub, fontSize: 13.5, marginBottom: 12, lineHeight: 1.65 }}>
                {t.emailCtaDesc}
              </Paragraph>
              <Paragraph style={{ color: MARKETING.textMuted, fontSize: 12.5, marginBottom: 12, lineHeight: 1.6 }}>
                {t.mailtoHint}
              </Paragraph>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <a
                  href={mailtoHref}
                  style={{
                    ...btnBaseStyle,
                    background: MARKETING.primaryDark,
                    color: "#fff",
                    boxShadow: "0 4px 14px rgba(26,127,219,0.28)",
                  }}
                >
                  <MailOutlined />
                  {t.emailCtaBtn}
                </a>
                <a
                  href={buildGmailComposeHref(lang)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    ...btnBaseStyle,
                    background: "#fff",
                    color: MARKETING.primaryDark,
                    border: `1px solid ${MARKETING.border}`,
                  }}
                >
                  <MailOutlined />
                  {t.gmailCtaBtn}
                </a>
                <Button
                  icon={<CopyOutlined />}
                  loading={copying}
                  onClick={copyEmail}
                  style={{ ...btnBaseStyle, height: 42 }}
                >
                  {t.copyEmailBtn}
                </Button>
              </div>
            </div>

            {/* Phone CTA */}
            <div
              style={{
                background: MARKETING.bgCard,
                border: `1px solid ${MARKETING.border}`,
                borderRadius: MK_RADIUS.lg,
                padding: MK_SPACING.md,
                boxShadow: MARKETING.shadowMedium,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: MK_RADIUS.md,
                  background: "#ECFDF5",
                  color: MARKETING.accentGreen,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  marginBottom: 12,
                }}
              >
                <PhoneOutlined />
              </div>
              <Text strong style={{ fontSize: 16, color: MARKETING.text, display: "block", marginBottom: 4 }}>
                {t.callCtaTitle}
              </Text>
              <Paragraph style={{ color: MARKETING.textSub, fontSize: 13.5, marginBottom: 16, lineHeight: 1.65 }}>
                {t.callCtaDesc}
              </Paragraph>
              <Button
                icon={<PhoneOutlined />}
                href={`tel:${COMPANY_PHONE.replace(/\s/g, "")}`}
                style={{
                  width: "100%",
                  height: 42,
                  fontWeight: 600,
                  borderRadius: MK_RADIUS.md,
                  background: MARKETING.accentGreen,
                  borderColor: MARKETING.accentGreen,
                  color: "#fff",
                  boxShadow: "0 4px 14px rgba(34,197,94,0.28)",
                }}
              >
                {t.callCtaBtn}
              </Button>
            </div>

            {/* 工作时间 */}
            <div
              style={{
                background: MARKETING.bgSection,
                border: `1px solid ${MARKETING.border}`,
                borderRadius: MK_RADIUS.lg,
                padding: MK_SPACING.md,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <ClockCircleOutlined style={{ color: MARKETING.accentAmber, fontSize: 16 }} />
                <Text strong style={{ fontSize: 14, color: MARKETING.text }}>
                  {t.hoursTitle}
                </Text>
              </div>
              <Paragraph style={{ fontSize: 13.5, color: MARKETING.textSub, marginBottom: 4, lineHeight: 1.65 }}>
                {t.hoursContent}
              </Paragraph>
              <Paragraph style={{ fontSize: 12.5, color: MARKETING.textMuted, marginBottom: 0 }}>
                {t.hoursNote}
              </Paragraph>
            </div>
          </div>
        </div>
      </section>

      <PageFooter />

      <style jsx>{`
        @media (max-width: 880px) {
          :global(.contact-grid) {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
}
