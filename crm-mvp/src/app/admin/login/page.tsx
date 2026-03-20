"use client";

import { Card, Form, Input, Button, Typography, App } from "antd";
import { LockOutlined, UserOutlined, SettingOutlined } from "@ant-design/icons";
import { useState } from "react";

const { Title, Text } = Typography;

export default function AdminLoginPage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, role: "admin" }),
      });
      const data = await res.json();
      if (data.code === 0) {
        message.success("登录成功");
        window.location.href = "/admin/dashboard";
      } else {
        message.error(data.message || "登录失败");
      }
    } catch {
      message.error("网络错误");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      background: "#fff",
    }}>
      <Card style={{ width: 400, borderRadius: 12, boxShadow: "0 2px 12px rgba(77,166,255,0.10)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <SettingOutlined style={{ fontSize: 40, color: "#4DA6FF" }} />
          <Title level={3} style={{ marginTop: 12, marginBottom: 4 }}>总控制台</Title>
          <Text type="secondary">管理员登录</Text>
        </div>
        <Form layout="vertical" onFinish={onFinish} autoComplete="off">
          <Form.Item name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
