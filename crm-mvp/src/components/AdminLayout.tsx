"use client";

import { Layout, Menu, Typography, Space, Dropdown } from "antd";
import {
  UserOutlined,
  SettingOutlined,
  DashboardOutlined,
  LogoutOutlined,
  ApiOutlined,
  ToolOutlined,
  AppstoreOutlined,
  SafetyCertificateOutlined,
  AuditOutlined,
  GlobalOutlined,
} from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { COLORS } from "@/styles/themeConfig";
import type { MenuProps } from "antd";

const { Sider, Content, Header } = Layout;
const { Text } = Typography;

type MenuItem = Required<MenuProps>["items"][number];

const menuItems: MenuItem[] = [
  {
    key: "overview-group",
    label: "总览",
    type: "group" as const,
    children: [
      { key: "/admin/dashboard", icon: <DashboardOutlined />, label: "仪表盘" },
    ],
  },
  {
    key: "user-group",
    label: "用户管理",
    type: "group" as const,
    children: [
      { key: "/admin/users", icon: <UserOutlined />, label: "用户列表" },
    ],
  },
  {
    key: "merchant-group",
    label: "商家管理",
    type: "group" as const,
    children: [
      { key: "/admin/merchant-sheet", icon: <SafetyCertificateOutlined />, label: "商家黑名单" },
      { key: "/admin/policy-categories", icon: <AuditOutlined />, label: "政策类别管理" },
    ],
  },
  {
    key: "site-group",
    label: "站点管理",
    type: "group" as const,
    children: [
      { key: "/admin/sites", icon: <AppstoreOutlined />, label: "站点管理" },
    ],
  },
  {
    key: "link-exchange-group",
    label: "换链接",
    type: "group" as const,
    children: [
      { key: "/admin/proxies", icon: <GlobalOutlined />, label: "代理管理" },
    ],
  },
  {
    key: "system-group",
    label: "系统配置",
    type: "group" as const,
    children: [
      { key: "/admin/ai-config", icon: <ApiOutlined />, label: "AI 配置" },
      { key: "/admin/semrush-config", icon: <ToolOutlined />, label: "SemRush 配置" },
      { key: "/admin/system-config", icon: <SettingOutlined />, label: "系统参数" },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [username, setUsername] = useState("");

  // ─── 登录页直接渲染，不做 auth 检查 ───
  const isLoginPage = pathname === "/admin/login";

  useEffect(() => {
    if (isLoginPage) return;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0 && res.data?.role === "admin") {
          setUsername(res.data.username);
        }
        // 不再在这里做跳转，由 middleware 统一处理
      })
      .catch(() => { /* ignore — middleware 会处理未登录跳转 */ });
  }, [isLoginPage]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/admin/login");
  };

  // 登录页直接渲染，不包裹 Layout
  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        width={220}
        collapsedWidth={80}
        style={{ background: COLORS.bgSidebar, position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 20 }}
      >
        <div className="sidebar-logo">
          <AppstoreOutlined style={{ fontSize: 20, color: COLORS.primary, marginRight: collapsed ? 0 : 8 }} />
          {!collapsed && <span className="sidebar-logo-text">CRM 总控制台</span>}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[pathname]}
          items={menuItems}
          onClick={({ key }) => router.push(key)}
          style={{ borderRight: "none" }}
        />
      </Sider>
      <Layout style={{ marginLeft: collapsed ? 80 : 220, transition: "margin-left 0.2s" }}>
        <Header
          className="crm-header"
          style={{
            background: COLORS.bgCard,
            padding: "0 24px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            height: 56,
            lineHeight: "56px",
          }}
        >
          <Text strong style={{ fontSize: 15, color: COLORS.textPrimary }}>CRM 管理控制台</Text>
          <Space size={16}>
            <Dropdown
              menu={{
                items: [
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: handleLogout, danger: true },
                ],
              }}
            >
              <Space style={{ cursor: "pointer" }}>
                <UserOutlined />
                <Text>{username || "管理员"}</Text>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ margin: 16 }} className="page-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
