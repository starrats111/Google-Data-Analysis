"use client";

import { Button, Space, Typography } from "antd";
import {
  GlobalOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";

const { Text } = Typography;

/**
 * D-010：公开页（marketing）顶部 nav bar
 * - 保留品牌绿色（#0F4C35 → #1A7A50），是 fengdu-ads 品牌色
 * - 微调：减小内边距、统一字号、按钮 outline 风格更现代
 * - 高度 64px（标准 SaaS nav）
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
        background: "linear-gradient(135deg, #0F4C35 0%, #1A7A50 100%)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.05) inset, 0 2px 12px rgba(15,76,53,0.18)",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <Space size={12} align="center">
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: "rgba(255,255,255,0.15)",
            border: "1.5px solid rgba(255,255,255,0.32)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          aria-hidden="true"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M3 14 L9 4 L15 14 Z" fill="white" opacity="0.92" />
            <circle cx="9" cy="13.5" r="1.6" fill="#4ADE80" />
          </svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <Text strong style={{ fontSize: 17, color: "#ffffff", letterSpacing: 0.4 }}>
            fengdu-ads
          </Text>
          <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.62)", letterSpacing: 0.3 }}>
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
