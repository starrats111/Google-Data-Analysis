"use client";

import { Layout, Menu, Typography, Button, Space, Dropdown, Badge, Popover, Empty, Spin, Modal, Tag, Table } from "antd";
import {
  ShopOutlined,
  FileTextOutlined,
  SettingOutlined,
  LogoutOutlined,
  UserOutlined,
  BellOutlined,
  AppstoreOutlined,
  FundOutlined,
  TableOutlined,
  AccountBookOutlined,
  FormOutlined,
  UnorderedListOutlined,
  TeamOutlined,
  BulbOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { COLORS } from "@/styles/themeConfig";
import { useApi } from "@/lib/swr";
import type { MenuProps } from "antd";

const { Sider, Content, Header } = Layout;
const { Text } = Typography;

type MenuItem = Required<MenuProps>["items"][number];

// 普通用户菜单
const userMenuItems: MenuItem[] = [
  {
    key: "merchant-group",
    label: "商家管理",
    type: "group" as const,
    children: [
      { key: "/user/merchants", icon: <ShopOutlined />, label: "我的商家" },
    ],
  },
  {
    key: "data-center-group",
    label: "数据中心",
    type: "group" as const,
    children: [
      { key: "/user/data-center", icon: <TableOutlined />, label: "数据中心" },
      { key: "/user/data-center/settlement", icon: <AccountBookOutlined />, label: "结算查询" },
      { key: "/user/data-center/insights", icon: <BulbOutlined />, label: "AI 浏览" },
    ],
  },
  {
    key: "article-group",
    label: "文章管理",
    type: "group" as const,
    children: [
      { key: "/user/articles/publish", icon: <FormOutlined />, label: "文章发布" },
      { key: "/user/articles", icon: <UnorderedListOutlined />, label: "文章管理" },
    ],
  },
  {
    key: "settings-group",
    label: "系统设置",
    type: "group" as const,
    children: [
      { key: "/user/settings", icon: <SettingOutlined />, label: "个人设置" },
    ],
  },
];

// 组长菜单
const leaderMenuItems: MenuItem[] = [
  {
    key: "team-group",
    label: "团队管理",
    type: "group" as const,
    children: [
      { key: "/user/team-overview", icon: <FundOutlined />, label: "小组总览" },
      { key: "/user/team-members", icon: <TeamOutlined />, label: "员工管理" },
    ],
  },
  {
    key: "leader-data-group",
    label: "数据中心",
    type: "group" as const,
    children: [
      { key: "/user/data-center/settlement", icon: <AccountBookOutlined />, label: "结算查询" },
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
  has_detail?: boolean;
}

interface NotificationDetail {
  removed?: { name: string; platform: string }[];
  added?: { name: string; platform: string }[];
  invalidLinks?: { name: string; platform: string; reason: string }[];
}

export default function UserLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // ─── 登录页直接渲染，不做 auth 检查 ───
  const isLoginPage = pathname === "/user/login";

  // ─── 用 SWR 缓存 auth 状态 — 页面切换不再重复请求 ───
  const { data: authData, error: authError, isLoading: authLoading } = useApi<{
    username: string;
    role: string;
    userId: string;
    team_id?: string;
    display_name?: string;
  }>(isLoginPage ? null : "/api/auth/me?role=user", {
    dedupingInterval: 60000,      // 60 秒内不重复请求
    revalidateOnFocus: false,
    revalidateIfStale: false,     // 有缓存就不自动刷新
    errorRetryCount: 2,
    errorRetryInterval: 2000,
  });

  // 根据角色选择菜单：组长只看团队管理，普通用户看完整菜单
  const currentMenuItems = useMemo(() => {
    if (authData?.role === "leader") return leaderMenuItems;
    return userMenuItems;
  }, [authData?.role]);

  // auth 状态 — 仅用于显示用户名，不做跳转
  // 跳转由 middleware 统一处理（检查 user_token cookie）
  const authVerifiedRef = useRef(false);
  useEffect(() => {
    if (isLoginPage) return;
    if (authData && (authData.role === "user" || authData.role === "leader")) {
      authVerifiedRef.current = true;
    }
  }, [authData, isLoginPage]);

  // ─── 用 SWR 缓存未读数量 — 自动去重 + 60 秒刷新 ───
  const { data: unreadData, mutate: mutateUnread } = useApi<{ count: number }>(
    isLoginPage ? null : "/api/user/notifications/unread-count",
    {
      refreshInterval: 60000,       // 60 秒自动刷新
      dedupingInterval: 10000,      // 10 秒去重
      revalidateOnFocus: false,
    }
  );
  const unreadCount = unreadData?.count || 0;

  // 通知列表（仅在打开面板时请求）
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifLoadedRef = useRef(false);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/user/notifications?page_size=20").then((r) => r.json());
      if (res.code === 0) {
        setNotifications(res.data.list);
        notifLoadedRef.current = true;
      }
    } catch { /* ignore */ }
  }, []);

  const handleNotifOpen = useCallback((open: boolean) => {
    setNotifOpen(open);
    if (open) fetchNotifications();
  }, [fetchNotifications]);

  const markAsRead = useCallback(async (id: string) => {
    await fetch(`/api/user/notifications/${id}/read`, { method: "PUT" });
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, is_read: 1 } : n));
    mutateUnread();
  }, [mutateUnread]);

  const markAllRead = useCallback(async () => {
    await fetch("/api/user/notifications/read-all", { method: "PUT" });
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
    mutateUnread();
  }, [mutateUnread]);

  const [detailModal, setDetailModal] = useState<{ open: boolean; title: string; loading: boolean; data: NotificationDetail | null }>({
    open: false, title: "", loading: false, data: null,
  });

  const openNotifDetail = useCallback(async (n: Notification) => {
    if (!n.is_read) {
      setNotifications((prev) => prev.map((x) => x.id === n.id ? { ...x, is_read: 1 } : x));
      mutateUnread();
    }
    setDetailModal({ open: true, title: n.title, loading: true, data: null });
    setNotifOpen(false);
    try {
      const res = await fetch(`/api/user/notifications/${n.id}`).then((r) => r.json());
      if (res.code === 0 && res.data?.metadata) {
        setDetailModal((prev) => ({ ...prev, loading: false, data: res.data.metadata }));
      } else {
        setDetailModal((prev) => ({ ...prev, loading: false, data: null }));
      }
    } catch {
      setDetailModal((prev) => ({ ...prev, loading: false }));
    }
  }, [mutateUnread]);

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/user/login");
  }, [router]);

  // ─── 菜单选中项 — useMemo 避免每次渲染重算 ───
  const selectedKey = useMemo(() => {
    if (pathname === "/user/settings") return "/user/settings";
    if (pathname === "/user/data-center/settlement") return "/user/data-center/settlement";
    if (pathname === "/user/data-center") return "/user/data-center";
    if (pathname === "/user/articles/publish") return "/user/articles/publish";
    if (pathname === "/user/articles") return "/user/articles";
    if (pathname === "/user/team-overview") return "/user/team-overview";
    if (pathname === "/user/team-members") return "/user/team-members";
    return pathname;
  }, [pathname]);

  const handleMenuClick = useCallback(({ key }: { key: string }) => {
    router.push(key);
  }, [router]);

  // ─── 通知面板内容 — useMemo 避免每次渲染重建 ───
  const notificationContent = useMemo(() => (
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
            onClick={() => n.has_detail ? openNotifDetail(n) : (!n.is_read && markAsRead(n.id))}
          >
            <div style={{ display: "flex", alignItems: "flex-start" }}>
              <span className={`notification-dot ${n.is_read ? "read" : "unread"}`} style={{ marginTop: 6 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: n.is_read ? 400 : 600, fontSize: 14, color: COLORS.textPrimary }}>
                  {n.title}
                  {n.has_detail && <RightOutlined style={{ fontSize: 10, marginLeft: 6, color: COLORS.textSecondary }} />}
                </div>
                <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.content}</div>
                <div style={{ fontSize: 12, color: "#9AA0A6", marginTop: 4 }}>
                  {new Date(n.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                  {n.has_detail && <span style={{ marginLeft: 8, color: COLORS.primary, fontSize: 12 }}>点击查看详情</span>}
                </div>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  ), [notifications, unreadCount, markAsRead, markAllRead, openNotifDetail]);

  // auth 加载中显示全屏 loading（仅首次加载，有缓存时不显示）
  if (!isLoginPage && authLoading && !authData && !authVerifiedRef.current) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }

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
          {!collapsed && <span className="sidebar-logo-text">CRM 管理平台</span>}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={currentMenuItems}
          onClick={handleMenuClick}
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
          <Text strong style={{ fontSize: 15, color: COLORS.textPrimary }}>CRM 用户管理平台</Text>
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
                  { key: "settings", icon: <SettingOutlined />, label: "个人设置", onClick: () => router.push("/user/settings?tab=platforms") },
                  { type: "divider" },
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: handleLogout, danger: true },
                ],
              }}
            >
              <Space style={{ cursor: "pointer" }}>
                <UserOutlined />
                <Text>{authData?.display_name || authData?.username || "用户"}</Text>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ margin: 16 }} className="page-content">{children}</Content>
      </Layout>

      <Modal
        title={detailModal.title}
        open={detailModal.open}
        onCancel={() => setDetailModal((prev) => ({ ...prev, open: false }))}
        footer={null}
        width={640}
      >
        {detailModal.loading ? (
          <div style={{ textAlign: "center", padding: 40 }}><Spin /></div>
        ) : detailModal.data ? (
          <div>
            {detailModal.data.removed && detailModal.data.removed.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <Text strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>
                  <Tag color="red">剔除</Tag>以下 {detailModal.data.removed.length} 个商家已非 joined 状态
                </Text>
                <Table
                  dataSource={detailModal.data.removed}
                  columns={[
                    { title: "商家名称", dataIndex: "name", key: "name" },
                    { title: "平台", dataIndex: "platform", key: "platform", width: 120, render: (v: string) => <Tag>{v}</Tag> },
                  ]}
                  rowKey={(_, i) => String(i)}
                  size="small"
                  pagination={detailModal.data.removed.length > 10 ? { pageSize: 10 } : false}
                />
              </div>
            )}
            {detailModal.data.added && detailModal.data.added.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <Text strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>
                  <Tag color="green">新增</Tag>以下 {detailModal.data.added.length} 个 joined 商家已自动同步
                </Text>
                <Table
                  dataSource={detailModal.data.added}
                  columns={[
                    { title: "商家名称", dataIndex: "name", key: "name" },
                    { title: "平台", dataIndex: "platform", key: "platform", width: 120, render: (v: string) => <Tag>{v}</Tag> },
                  ]}
                  rowKey={(_, i) => String(i)}
                  size="small"
                  pagination={detailModal.data.added.length > 10 ? { pageSize: 10 } : false}
                />
              </div>
            )}
            {detailModal.data.invalidLinks && detailModal.data.invalidLinks.length > 0 && (
              <div>
                <Text strong style={{ fontSize: 14, display: "block", marginBottom: 8 }}>
                  <Tag color="orange">异常</Tag>以下 {detailModal.data.invalidLinks.length} 个商家链接无效
                </Text>
                <Table
                  dataSource={detailModal.data.invalidLinks}
                  columns={[
                    { title: "商家名称", dataIndex: "name", key: "name" },
                    { title: "平台", dataIndex: "platform", key: "platform", width: 120, render: (v: string) => <Tag>{v}</Tag> },
                    { title: "原因", dataIndex: "reason", key: "reason", width: 160 },
                  ]}
                  rowKey={(_, i) => String(i)}
                  size="small"
                  pagination={detailModal.data.invalidLinks.length > 10 ? { pageSize: 10 } : false}
                />
              </div>
            )}
          </div>
        ) : (
          <Empty description="暂无详细数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Modal>
    </Layout>
  );
}
