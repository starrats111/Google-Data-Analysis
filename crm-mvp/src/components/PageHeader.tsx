"use client";

import { Button, Space, Typography } from "antd";
import {
  RocketOutlined,
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
        padding: "20px 40px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <Space>
        <RocketOutlined style={{ fontSize: 28, color: "#4DA6FF" }} />
        <Text strong style={{ fontSize: 16, color: "#1A7FDB" }}>
          {lang === "en" ? "Wenzhou Fengdu Advertising & Media" : "温州丰度广告传媒有限公司"}
        </Text>
        <Text style={{ fontSize: 12, color: "#888", marginLeft: 4 }}>
          {lang === "en" ? "· Internal Ad Automation CRM" : "· 内部广告管理系统"}
        </Text>
      </Space>
      <Space>
        <Button icon={<GlobalOutlined />} onClick={toggle}>
          {lang === "en" ? "中文" : "EN"}
        </Button>
        {showHome && (
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => router.push("/")}
          >
            {lang === "en" ? "Home" : "首页"}
          </Button>
        )}
      </Space>
    </div>
  );
}
