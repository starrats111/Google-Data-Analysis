"use client";

import { Layout, Menu, Typography, Button, Space, Dropdown, Badge, Popover, Empty } from "antd";
import {
  UserOutlined,
  SettingOutlined,
  DashboardOutlined,
  LogoutOutlined,
  ApiOutlined,
  BellOutlined,
  TeamOutlined,
  ToolOutlined,
  AppstoreOutlined,
  SafetyCertificateOutlined,
  AuditOutlined,
} from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect, useCallback } from "react";
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

interface Notification {
  id: string;
  title: string;
  content: string;
  type: string;
  is_read: number;
  created_at: string;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [username, setUsername] = useState("");

  // ─── 登录页直接渲染，不做 auth 检查 ───
  const isLoginPage = pathname === "/admin/login";

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);

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

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch("/api/user/notifications/unread-count").then((r) => r.json());
      if (res.code === 0) setUnreadCount(res.data.count);
    } catch { /* ignore */ }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/user/notifications?page_size=20").then((r) => r.json());
      if (res.code === 0) setNotifications(res.data.list);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (isLoginPage) return;
    fetchUnreadCount();
    const timer = setInterval(fetchUnreadCount, 60000);
    return () => clearInterval(timer);
  }, [fetchUnreadCount, isLoginPage]);

  const handleNotifOpen = (open: boolean) => {
    setNotifOpen(open);
    if (open) fetchNotifications();
  };

  const markAsRead = async (id: string) => {
    await fetch(`/api/user/notifications/${id}/read`, { method: "PUT" });
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, is_read: 1 } : n));
    setUnreadCount((prev) => Math.max(0, prev - 1));
  };

  const markAllRead = async () => {
    await fetch("/api/user/notifications/read-all", { method: "PUT" });
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
    setUnreadCount(0);
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/admin/login");
  };

  const notificationContent = (
    <div className="notification-panel">
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #F0F0F0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Text strong>消息通知</Text>
        {unreadCount > 0 && (
          <Button type="link" size="small" onClick={markAllRead}>全部已读</Button>
        )}
      </div>
      {notifications.length === 0 ? (
        <div style={{ padding: 32 }}>
          <Empty description="暂无消息" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      ) : (
        notifications.map((n) => (
          <div
            key={n.id}
            className={`notification-item ${n.is_read ? "" : "unread"}`}
            onClick={() => !n.is_read && markAsRead(n.id)}
          >
            <div style={{ display: "flex", alignItems: "flex-start" }}>
              <span className={`notification-dot ${n.is_read ? "read" : "unread"}`} style={{ marginTop: 6 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: n.is_read ? 400 : 600, fontSize: 14, color: COLORS.textPrimary }}>{n.title}</div>
                <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.content}</div>
                <div style={{ fontSize: 12, color: "#9AA0A6", marginTop: 4 }}>{new Date(n.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</div>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );

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
            <Popover
              content={notificationContent}
              trigger="click"
              open={notifOpen}
              onOpenChange={handleNotifOpen}
              placement="bottomRight"
              arrow={false}
            >
              <Badge count={unreadCount} offset={[-2, 2]} size="small">
                <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} />
              </Badge>
            </Popover>
            <Dropdown
              menu={{
                items: [
                  { type: "divider" },
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
