"use client";

import { Card, Row, Col, Statistic, Typography } from "antd";
import { UserOutlined, RobotOutlined, SettingOutlined, ApiOutlined } from "@ant-design/icons";
import { useApi } from "@/lib/swr";

const { Title } = Typography;

export default function AdminDashboard() {
  const { data: stats } = useApi<{ users: number; providers: number; models: number; configs: number }>("/api/admin/stats");

  return (
    <div>
      <Title level={4} style={{ marginBottom: 24 }}>管理员仪表盘</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}><Card><Statistic title="用户总数" value={stats?.users || 0} prefix={<UserOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="AI 供应商" value={stats?.providers || 0} prefix={<ApiOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="模型配置" value={stats?.models || 0} prefix={<RobotOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="系统配置" value={stats?.configs || 0} prefix={<SettingOutlined />} /></Card></Col>
      </Row>
    </div>
  );
}
