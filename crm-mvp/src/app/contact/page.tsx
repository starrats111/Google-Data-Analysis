"use client";

import { Typography, Space, Card, Divider, Button } from "antd";
import {
  MailOutlined,
  PhoneOutlined,
  EnvironmentOutlined,
  GlobalOutlined,
  ClockCircleOutlined,
  ContactsOutlined,
} from "@ant-design/icons";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";

const { Title, Paragraph, Text } = Typography;

const COMPANY_PHONE = "+86 13958988973";
const COMPANY_EMAIL = "google-ads-api@fengdu-ads.top";
const COMPANY_ADDRESS_EN =
  "Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County, Wenzhou, Zhejiang, China";
const COMPANY_ADDRESS_ZH = "中国 浙江省 温州市 泰顺县 罗阳镇 新城大道 华鸿心广场 29 幢 1110 室-2";
const POSTAL_CODE = "325500";

const i18n = {
  en: {
    pageTitle: "Contact Us",
    intro:
      "We welcome inquiries from partner merchants, affiliate networks, and Google business representatives. Please reach out using the channels below.",
    contactBlock: "Contact Information",
    companyLabel: "Company:",
    companyName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    cnLabel: "Chinese Name:",
    cnName: "温州丰度广告传媒有限公司",
    phoneLabel: "Phone (China):",
    emailLabel: "Email:",
    addrLabel: "Address (China):",
    postalLabel: "Postal Code:",
    websiteLabel: "Website:",
    hoursTitle: "Business Hours",
    hoursContent: "Monday – Friday, 09:00 – 18:00 (China Standard Time, GMT+8)",
    hoursNote: "We respond to email inquiries within one business day.",
    emailCtaTitle: "Prefer email?",
    emailCtaDesc: "Click the button below to compose an email to our team directly.",
    emailCtaBtn: "Email Us Now",
    callCtaTitle: "Prefer phone?",
    callCtaDesc: "Tap to call our office line during business hours.",
    callCtaBtn: "Call Us Now",
  },
  zh: {
    pageTitle: "联系我们",
    intro:
      "我们欢迎合作商家、联盟营销网络以及 Google 业务方的咨询。请通过以下方式与我们联系。",
    contactBlock: "联系方式",
    companyLabel: "公司名称：",
    companyName: "温州丰度广告传媒有限公司",
    cnLabel: "英文名称：",
    cnName: "Wenzhou Fengdu Advertising & Media Co., Ltd.",
    phoneLabel: "中国联系电话：",
    emailLabel: "电子邮箱：",
    addrLabel: "中国联系地址：",
    postalLabel: "邮政编码：",
    websiteLabel: "公司网址：",
    hoursTitle: "工作时间",
    hoursContent: "周一至周五，09:00 – 18:00（北京时间，GMT+8）",
    hoursNote: "我们将在 1 个工作日内回复邮件咨询。",
    emailCtaTitle: "邮件咨询",
    emailCtaDesc: "点击下方按钮，直接给我们发送邮件。",
    emailCtaBtn: "立即发送邮件",
    callCtaTitle: "电话咨询",
    callCtaDesc: "工作时间内可拨打我们的联系电话。",
    callCtaBtn: "立即拨打电话",
  },
};

export default function ContactPage() {
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <PageHeader showHome />

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px 80px" }}>
        <Title level={1} style={{ color: "#1A7FDB", textAlign: "center" }}>
          <ContactsOutlined style={{ marginRight: 12 }} />
          {t.pageTitle}
        </Title>
        <Paragraph style={{ textAlign: "center", color: "#666", fontSize: 16, maxWidth: 700, margin: "0 auto 32px" }}>
          {t.intro}
        </Paragraph>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Title level={2} style={{ margin: 0, fontSize: 22 }}>
              <ContactsOutlined style={{ marginRight: 8, color: "#1A7FDB" }} />
              {t.contactBlock}
            </Title>

            <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
              <Text strong>{t.companyLabel}</Text> {t.companyName}
            </Paragraph>
            <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
              <Text strong>{t.cnLabel}</Text> {t.cnName}
            </Paragraph>

            <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
              <PhoneOutlined style={{ marginRight: 8, color: "#52c41a" }} />
              <Text strong>{t.phoneLabel}</Text>{" "}
              <a href={`tel:${COMPANY_PHONE.replace(/\s/g, "")}`} style={{ color: "#1A7FDB" }}>
                {COMPANY_PHONE}
              </a>
            </Paragraph>

            <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
              <MailOutlined style={{ marginRight: 8, color: "#fa8c16" }} />
              <Text strong>{t.emailLabel}</Text>{" "}
              <a href={`mailto:${COMPANY_EMAIL}`} style={{ color: "#1A7FDB" }}>
                {COMPANY_EMAIL}
              </a>
            </Paragraph>

            <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
              <EnvironmentOutlined style={{ marginRight: 8, color: "#722ed1" }} />
              <Text strong>{t.addrLabel}</Text>{" "}
              {lang === "en" ? COMPANY_ADDRESS_EN : COMPANY_ADDRESS_ZH}
            </Paragraph>

            <Paragraph style={{ fontSize: 16, marginBottom: 8 }}>
              <Text strong>{t.postalLabel}</Text> {POSTAL_CODE}
            </Paragraph>

            <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>
              <GlobalOutlined style={{ marginRight: 8, color: "#13c2c2" }} />
              <Text strong>{t.websiteLabel}</Text>{" "}
              <a href="https://fengdu-ads.top" target="_blank" rel="noopener noreferrer" style={{ color: "#1A7FDB" }}>
                https://fengdu-ads.top
              </a>
            </Paragraph>
          </Space>
        </Card>

        <Card style={{ borderRadius: 12, marginBottom: 24 }}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Title level={2} style={{ margin: 0, fontSize: 22 }}>
              <ClockCircleOutlined style={{ marginRight: 8, color: "#fa8c16" }} />
              {t.hoursTitle}
            </Title>
            <Paragraph style={{ fontSize: 16, marginBottom: 0 }}>{t.hoursContent}</Paragraph>
            <Paragraph style={{ fontSize: 14, color: "#888", marginBottom: 0 }}>{t.hoursNote}</Paragraph>
          </Space>
        </Card>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Card style={{ flex: 1, minWidth: 280, borderRadius: 12 }}>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Title level={3} style={{ margin: 0, fontSize: 18 }}>
                <MailOutlined style={{ marginRight: 8, color: "#fa8c16" }} />
                {t.emailCtaTitle}
              </Title>
              <Paragraph style={{ fontSize: 14, color: "#666", marginBottom: 0 }}>{t.emailCtaDesc}</Paragraph>
              <Button
                type="primary"
                size="large"
                icon={<MailOutlined />}
                href={`mailto:${COMPANY_EMAIL}`}
                style={{ width: "100%", height: 44 }}
              >
                {t.emailCtaBtn}
              </Button>
            </Space>
          </Card>

          <Card style={{ flex: 1, minWidth: 280, borderRadius: 12 }}>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Title level={3} style={{ margin: 0, fontSize: 18 }}>
                <PhoneOutlined style={{ marginRight: 8, color: "#52c41a" }} />
                {t.callCtaTitle}
              </Title>
              <Paragraph style={{ fontSize: 14, color: "#666", marginBottom: 0 }}>{t.callCtaDesc}</Paragraph>
              <Button
                size="large"
                icon={<PhoneOutlined />}
                href={`tel:${COMPANY_PHONE.replace(/\s/g, "")}`}
                style={{ width: "100%", height: 44, background: "#52c41a", color: "#fff", borderColor: "#52c41a" }}
              >
                {t.callCtaBtn}
              </Button>
            </Space>
          </Card>
        </div>

        <Divider />
        <PageFooter />
      </div>
    </div>
  );
}
