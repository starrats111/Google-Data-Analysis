"use client";

import { Button, Space, Typography } from "antd";
import {
  GlobalOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";

const { Text } = Typography;

export default function PageHeader({ showHome = false }: { showHome?: boolean }) {
  const router = useRouter();
  const { lang, toggle } = useLanguage();

  return (
    <div
      style={{
        padding: "16px 40px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: "linear-gradient(135deg, #0f4c35 0%, #1a7a50 100%)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      }}
    >
      <Space size={10} align="center">
        {/* 白绿配色 logo 图标 */}
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: "rgba(255,255,255,0.15)",
            border: "1.5px solid rgba(255,255,255,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M3 14 L9 4 L15 14 Z" fill="white" opacity="0.9" />
            <circle cx="9" cy="13.5" r="1.5" fill="#4ADE80" />
          </svg>
        </div>
        <Text strong style={{ fontSize: 17, color: "#ffffff", letterSpacing: 0.5 }}>
          fengdu-ads
        </Text>
        <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginLeft: 2 }}>
          {lang === "en" ? "Ad Automation CRM" : "广告自动化系统"}
        </Text>
      </Space>
      <Space>
        <Button
          icon={<GlobalOutlined />}
          onClick={toggle}
          style={{
            background: "rgba(255,255,255,0.12)",
            border: "1px solid rgba(255,255,255,0.3)",
            color: "#ffffff",
          }}
        >
          {lang === "en" ? "中文" : "EN"}
        </Button>
        {showHome && (
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => router.push("/")}
            style={{
              background: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.3)",
              color: "#ffffff",
            }}
          >
            {lang === "en" ? "Home" : "首页"}
          </Button>
        )}
      </Space>
    </div>
  );
}
