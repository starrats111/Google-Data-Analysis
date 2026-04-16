"use client";

import { Typography, Card, Divider } from "antd";
import { FileProtectOutlined } from "@ant-design/icons";
import { useLanguage } from "@/contexts/LanguageContext";
import PageHeader from "@/components/PageHeader";
import PageFooter from "@/components/PageFooter";

const { Title, Paragraph, Text } = Typography;

const i18n = {
  en: {
    pageTitle: "Terms of Service",
    lastUpdated: "Last updated: March 31, 2026",
    sections: [
      {
        title: "1. Acceptance of Terms",
        content: 'By accessing or using the Ad Automation Platform operated by Wenzhou Fengdu Advertising & Media Co., Ltd. ("we", "us", or "the Company"), you agree to be bound by these Terms of Service. If you do not agree to these terms, you may not access or use the Service.',
      },
      {
        title: "2. Description of Service",
        content: "The Service is an internal advertising campaign management and reporting platform designed for authorized team members. It provides the following capabilities:",
        items: [
          "Google Ads campaign creation, management, and optimization.",
          "Campaign budget and bid control.",
          "Performance reporting and analytics with daily data synchronization.",
          "Multi-account (MCC) management for Google Ads accounts.",
          "Ad asset management including sitelinks, callouts, promotions, price extensions, and image assets.",
          "AI-powered content generation for SEO articles and advertising copy.",
          "Affiliate transaction tracking and commission reporting.",
        ],
        postContent: "The Service is intended for internal use by the Company's authorized personnel and is not offered as a public or third-party service.",
      },
      {
        title: "3. User Accounts",
        content: "Access to the Service requires an authorized user account. Users are responsible for:",
        items: [
          "Maintaining the confidentiality of their account credentials.",
          "All activities that occur under their account.",
          "Notifying the administrator immediately of any unauthorized use of their account.",
        ],
      },
      {
        title: "4. Acceptable Use",
        content: "Users agree to use the Service only for its intended purpose of advertising campaign management and in compliance with:",
        items: [
          "All applicable laws and regulations.",
          "Google Ads Terms of Service and Google Ads API Terms and Conditions.",
          "Company policies regarding advertising content and spending.",
        ],
        postContent: "Users must not attempt to gain unauthorized access to any part of the Service, interfere with its operation, or use the Service for any unlawful purpose.",
      },
      {
        title: "5. Intellectual Property",
        content: "The Service, including its design, code, features, and content, is the intellectual property of Wenzhou Fengdu Advertising & Media Co., Ltd. Users are granted a limited, non-transferable right to use the Service for authorized purposes only.",
      },
      {
        title: "6. Data and Google Ads API Usage",
        content: "The Service accesses Google Ads data through the Google Ads API. All Google Ads data is used in accordance with Google's API Terms and Conditions. Users acknowledge that:",
        items: [
          "Google Ads campaign operations performed through the Service are subject to Google Ads policies.",
          "The Company is responsible for ensuring compliant use of the Google Ads API.",
          "Campaign data synchronized to the platform is used for internal reporting and optimization purposes.",
        ],
      },
      {
        title: "7. Limitation of Liability",
        content: 'The Service is provided "as is" without warranties of any kind. The Company shall not be liable for any indirect, incidental, special, or consequential damages arising from the use of the Service, including but not limited to:',
        items: [
          "Advertising campaign performance or advertising spend outcomes.",
          "Data loss or service interruptions.",
          "Third-party service availability (including Google Ads API).",
        ],
      },
      {
        title: "8. Termination",
        content: "The Company reserves the right to suspend or terminate any user's access to the Service at any time, with or without cause. Upon termination, the user's right to access the Service will immediately cease.",
      },
      {
        title: "9. Changes to Terms",
        content: 'We reserve the right to modify these Terms of Service at any time. Changes will be posted on this page with an updated "Last updated" date. Continued use of the Service after any changes constitutes acceptance of the revised terms.',
      },
      {
        title: "10. Governing Law",
        content: "These Terms shall be governed by and construed in accordance with the laws of the People's Republic of China. Any disputes arising from the use of the Service shall be subject to the jurisdiction of the competent courts in Wenzhou, Zhejiang, China.",
      },
      {
        title: "11. Contact",
        content: "For questions about these Terms of Service, please contact:",
        contact: { name: "Wenzhou Fengdu Advertising & Media Co., Ltd.", addr: "Room 1110-2, Building 29, Huahong Xin Plaza, Xincheng Avenue, Luoyang Town, Taishun County, Wenzhou, Zhejiang, China", emailLabel: "Email: " },
      },
    ],
  },
  zh: {
    pageTitle: "服务条款",
    lastUpdated: "最后更新：2026年3月31日",
    sections: [
      {
        title: "1. 条款接受",
        content: "访问或使用由温州丰度广告传媒有限公司（以下简称\u201c本公司\u201d）运营的 Ad Automation 平台，即表示您同意受本服务条款的约束。如您不同意本条款，请勿访问或使用本服务。",
      },
      {
        title: "2. 服务描述",
        content: "本服务是为授权团队成员设计的内部广告系列管理和报告平台，提供以下能力：",
        items: [
          "Google Ads 广告系列创建、管理和优化。",
          "广告预算和出价控制。",
          "效果报告和数据分析，每日数据同步。",
          "Google Ads 多账户（MCC）管理。",
          "广告素材管理，包括站内链接、宣传信息、促销、价格扩展和图片素材。",
          "AI 驱动的 SEO 文章和广告文案生成。",
          "联盟交易跟踪和佣金报告。",
        ],
        postContent: "本服务仅供公司授权人员内部使用，不作为公共或第三方服务提供。",
      },
      {
        title: "3. 用户账户",
        content: "使用本服务需要授权用户账户。用户有责任：",
        items: [
          "保管账户凭证的保密性。",
          "对其账户下发生的所有活动负责。",
          "发现任何未授权使用时立即通知管理员。",
        ],
      },
      {
        title: "4. 合理使用",
        content: "用户同意仅将本服务用于其广告管理目的，并遵守：",
        items: [
          "所有适用的法律法规。",
          "Google Ads 服务条款和 Google Ads API 条款与条件。",
          "公司关于广告内容和支出的政策。",
        ],
        postContent: "用户不得试图未经授权访问本服务的任何部分、干扰其运行或将本服务用于任何非法目的。",
      },
      {
        title: "5. 知识产权",
        content: "本服务（包括其设计、代码、功能和内容）是温州丰度广告传媒有限公司的知识产权。用户仅获得有限的、不可转让的权利，用于授权目的。",
      },
      {
        title: "6. 数据和 Google Ads API 使用",
        content: "本服务通过 Google Ads API 访问 Google Ads 数据。所有 Google Ads 数据的使用均遵循 Google API 条款与条件。用户确认：",
        items: [
          "通过本服务执行的 Google Ads 广告操作受 Google Ads 政策约束。",
          "本公司负责确保 Google Ads API 的合规使用。",
          "同步到平台的广告数据用于内部报告和优化目的。",
        ],
      },
      {
        title: "7. 责任限制",
        content: "本服务按\u201c现状\u201d提供，不提供任何形式的保证。本公司不对因使用本服务而产生的任何间接、附带、特殊或后果性损害承担责任，包括但不限于：",
        items: [
          "广告系列效果或广告支出结果。",
          "数据丢失或服务中断。",
          "第三方服务可用性（包括 Google Ads API）。",
        ],
      },
      {
        title: "8. 终止",
        content: "本公司保留随时暂停或终止任何用户访问本服务的权利，无论是否有原因。终止后，用户访问本服务的权利将立即停止。",
      },
      {
        title: "9. 条款变更",
        content: "我们保留随时修改本服务条款的权利。变更将在本页面发布，并更新\u201c最后更新\u201d日期。任何变更后继续使用本服务即表示接受修订后的条款。",
      },
      {
        title: "10. 适用法律",
        content: "本条款受中华人民共和国法律管辖和解释。因使用本服务产生的任何争议应由浙江省温州市有管辖权的法院管辖。",
      },
      {
        title: "11. 联系方式",
        content: "如对本服务条款有任何疑问，请联系：",
        contact: { name: "温州丰度广告传媒有限公司", addr: "浙江省温州市泰顺县罗阳镇新城大道华鸿心广场29幢1110室-2", emailLabel: "邮箱：" },
      },
    ],
  },
};

export default function TermsOfServicePage() {
  const { lang } = useLanguage();
  const t = i18n[lang];

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      <PageHeader showHome />

      <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px 80px" }}>
        <Title level={1} style={{ color: "#1A7FDB", textAlign: "center" }}>
          <FileProtectOutlined style={{ marginRight: 12 }} />
          {t.pageTitle}
        </Title>
        <Paragraph style={{ textAlign: "center", color: "#999", marginBottom: 40 }}>
          {t.lastUpdated}
        </Paragraph>

        {t.sections.map((s) => (
          <Card key={s.title} style={{ borderRadius: 12, marginBottom: 24 }}>
            <Title level={3}>{s.title}</Title>
            <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>{s.content}</Paragraph>
            {s.items && (
              <ul style={{ fontSize: 15, lineHeight: 2 }}>
                {s.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            )}
            {s.postContent && (
              <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>{s.postContent}</Paragraph>
            )}
            {s.contact && (
              <Paragraph style={{ fontSize: 15 }}>
                <Text strong>{s.contact.name}</Text>
                <br />
                {s.contact.addr}
                <br />
                {s.contact.emailLabel}
                <a href="mailto:admin@fengdu-ads.top">admin@fengdu-ads.top</a>
              </Paragraph>
            )}
          </Card>
        ))}

        <Divider />
        <PageFooter />
      </div>
    </div>
  );
}
