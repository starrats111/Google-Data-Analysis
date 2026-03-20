"use client";

import { Button, Typography, Card, Row, Col, Space } from "antd";
import {
  RocketOutlined,
  ShopOutlined,
  FileTextOutlined,
  BarChartOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph, Text } = Typography;

const features = [
  {
    icon: <ShopOutlined style={{ fontSize: 32, color: "#4DA6FF" }} />,
    title: "商家管理",
    desc: "统一管理 7 大联盟平台商家，一键领取、自动创建广告",
  },
  {
    icon: <FileTextOutlined style={{ fontSize: 32, color: "#52c41a" }} />,
    title: "文章管理",
    desc: "AI 自动生成 SEO 文章，支持多站点一键发布",
  },
  {
    icon: <BarChartOutlined style={{ fontSize: 32, color: "#fa8c16" }} />,
    title: "数据看板",
    desc: "实时数据可视化，费用/佣金/ROI 一目了然",
  },
  {
    icon: <SettingOutlined style={{ fontSize: 32, color: "#1A7FDB" }} />,
    title: "智能投放",
    desc: "广告默认设置 + 节日营销，自动优化投放策略",
  },
];

export default function HomePage() {
  const router = useRouter();

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      {/* Header */}
      <div style={{ padding: "20px 40px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Space>
          <RocketOutlined style={{ fontSize: 28, color: "#4DA6FF" }} />
          <Text strong style={{ fontSize: 20, color: "#1A7FDB" }}>广告自动化发布</Text>
        </Space>
        <Space>
          <Button onClick={() => router.push("/user/login")}>
            用户登录
          </Button>
          <Button type="primary" onClick={() => router.push("/admin/login")}>
            管理员入口
          </Button>
        </Space>
      </div>

      {/* Hero */}
      <div style={{ textAlign: "center", padding: "80px 20px 60px" }}>
        <Title style={{ color: "#1A7FDB", fontSize: 48, marginBottom: 16 }}>
          广告自动化发布平台
        </Title>
        <Paragraph style={{ color: "#666", fontSize: 18, maxWidth: 600, margin: "0 auto 40px" }}>
          商家领取 → 广告自动创建 → 文章自动生成 → 数据自动分析，一站式闭环管理
        </Paragraph>
        <Space size="large">
          <Button
            type="primary"
            size="large"
            icon={<UserOutlined />}
            onClick={() => router.push("/user/login")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            进入用户平台
          </Button>
          <Button
            size="large"
            icon={<SettingOutlined />}
            onClick={() => router.push("/admin/login")}
            style={{ height: 48, paddingInline: 32, fontSize: 16 }}
          >
            进入总控制台
          </Button>
        </Space>
      </div>

      {/* Features */}
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 20px 80px" }}>
        <Row gutter={[24, 24]}>
          {features.map((f) => (
            <Col xs={24} sm={12} key={f.title}>
              <Card hoverable style={{ height: "100%", borderRadius: 12 }}>
                <Space orientation="vertical" size={12}>
                  {f.icon}
                  <Title level={4} style={{ margin: 0 }}>{f.title}</Title>
                  <Text type="secondary">{f.desc}</Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", padding: "20px", color: "#999" }}>
        <Text style={{ color: "#999" }}>© 2026 广告自动化发布</Text>
      </div>
    </div>
  );
}
