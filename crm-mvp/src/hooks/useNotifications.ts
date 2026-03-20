"use client";

import { useState, useEffect, useCallback } from "react";

interface Notification {
  id: string;
  title: string;
  content: string;
  type: string;
  is_read: number;
  created_at: string;
}

/**
 * 通知系统共享 Hook — 消除 UserLayout / AdminLayout 中的重复代码
 */
export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // 获取未读数量
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch("/api/user/notifications/unread-count").then((r) => r.json());
      if (res.code === 0) setUnreadCount(res.data.count);
    } catch {
      // 静默失败
    }
  }, []);

  // 获取通知列表
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/user/notifications?page_size=20").then((r) => r.json());
      if (res.code === 0) setNotifications(res.data.list);
    } catch {
      // 静默失败
    } finally {
      setLoading(false);
    }
  }, []);

  // 定时轮询未读数量
  useEffect(() => {
    fetchUnreadCount();
    const timer = setInterval(fetchUnreadCount, 60000);
    return () => clearInterval(timer);
  }, [fetchUnreadCount]);

  // 打开/关闭通知面板
  const handleNotifOpen = useCallback(
    (open: boolean) => {
      setNotifOpen(open);
      if (open) fetchNotifications();
    },
    [fetchNotifications]
  );

  // 标记单条已读
  const markAsRead = useCallback(async (id: string) => {
    try {
      await fetch(`/api/user/notifications/${id}/read`, { method: "PUT" });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // 静默失败
    }
  }, []);

  // 全部已读
  const markAllRead = useCallback(async () => {
    try {
      await fetch("/api/user/notifications/read-all", { method: "PUT" });
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
      setUnreadCount(0);
    } catch {
      // 静默失败
    }
  }, []);

  return {
    notifications,
    unreadCount,
    notifOpen,
    loading,
    handleNotifOpen,
    markAsRead,
    markAllRead,
  };
}
