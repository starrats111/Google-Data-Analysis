"use client";

import { Card, Form, Input, Button, Typography, App } from "antd";
import { LockOutlined, UserOutlined, RocketOutlined } from "@ant-design/icons";
import { useState } from "react";
import { globalMutate } from "@/lib/swr";

const { Title, Text } = Typography;

export default function UserLoginPage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, role: "user" }),
      });
      const data = await res.json();
      if (data.code === 0) {
        message.success("登录成功");
        // 预填 SWR auth 缓存，避免跳转后 UserLayout 误判
        globalMutate("/api/auth/me", {
          id: data.data.id,
          username: data.data.username,
          role: data.data.role,
        }, { revalidate: false });
        // 组长跳转到小组总览，普通用户跳转到商家管理
        const targetPath = data.data.role === "leader" ? "/user/team-overview" : "/user/merchants";
        window.location.href = targetPath;
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
          <RocketOutlined style={{ fontSize: 40, color: "#4DA6FF" }} />
          <Title level={3} style={{ marginTop: 12, marginBottom: 4 }}>用户平台</Title>
          <Text type="secondary">广告自动化发布系统</Text>
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
