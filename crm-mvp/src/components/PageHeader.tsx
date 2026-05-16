"use client";

import { Button, Space, Typography } from "antd";
import {
  GlobalOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import BrandLogo from "@/components/BrandLogo";

const { Text } = Typography;

/**
 * D-011：公开页（marketing）顶部 nav bar
 * - 与 app dashboard 主色统一：蓝色 brand gradient #1A7FDB → #4DA6FF（Google Ads 派）
 * - 64px 标准 SaaS nav 高度
 * - 共享 BrandLogo（F + 琥珀点）作品牌 mark
 */
export default function PageHeader({ showHome = false }: { showHome?: boolean }) {
  const router = useRouter();
  const { lang, toggle } = useLanguage();

  return (
    <header
      style={{
        height: 64,
        padding: "0 32px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: "linear-gradient(135deg, #1A7FDB 0%, #4DA6FF 100%)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.10) inset, 0 2px 12px rgba(26,127,219,0.20)",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <Space size={12} align="center">
        <BrandLogo size={36} withShadow={false} />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <Text strong style={{ fontSize: 17, color: "#ffffff", letterSpacing: 0.4 }}>
            fengdu-ads
          </Text>
          <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.72)", letterSpacing: 0.3 }}>
            {lang === "en" ? "Ad Automation CRM" : "广告自动化平台"}
          </Text>
        </div>
      </Space>

      <Space size={8}>
        <Button
          icon={<GlobalOutlined />}
          onClick={toggle}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.32)",
            color: "#ffffff",
            height: 36,
            fontWeight: 500,
          }}
        >
          {lang === "en" ? "中文" : "EN"}
        </Button>
        {showHome && (
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => router.push("/")}
            style={{
              background: "rgba(255,255,255,0.10)",
              border: "1px solid rgba(255,255,255,0.32)",
              color: "#ffffff",
              height: 36,
              fontWeight: 500,
            }}
          >
            {lang === "en" ? "Home" : "首页"}
          </Button>
        )}
      </Space>
    </header>
  );
}
