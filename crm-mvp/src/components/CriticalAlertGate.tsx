"use client";

/**
 * D-266 批四：全员危险事件弹窗（07 批复 #6）
 *
 * 轮询 /api/user/notifications/popup（60 秒），有未确认的 MCC 级危险告警
 * （Sheet 被封 / 表格结构未识别 / 统一脚本停更等）即弹阻断式弹窗。
 *
 * 活动感知：用户正在广告创建流程（广告预览页 / 竞品情报四步向导）时不打断，
 * 等其发布完成离开创建页后再弹——靠 pathname 判定，发布完成必然跳转离开这些路径。
 */

import { useCallback, useEffect, useState } from "react";
import { Modal, Typography, Tag, Button } from "antd";
import { WarningOutlined } from "@ant-design/icons";
import { usePathname } from "next/navigation";

const { Text, Paragraph } = Typography;

/** 广告创建等不可打断的活动路径前缀 */
const BUSY_PATH_PREFIXES = ["/user/ad-preview", "/user/rival-ad-create"];

interface PopupAlert {
  id: string;
  title: string;
  content: string;
  created_at: string;
}

const POLL_MS = 60_000;

export default function CriticalAlertGate() {
  const pathname = usePathname();
  const [alerts, setAlerts] = useState<PopupAlert[]>([]);
  const [acking, setAcking] = useState(false);

  const busy = BUSY_PATH_PREFIXES.some((p) => pathname?.startsWith(p));

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/user/notifications/popup").then((r) => r.json());
      if (res.code === 0 && Array.isArray(res.data?.list)) {
        setAlerts(res.data.list);
      }
    } catch {
      /* 静默：告警轮询失败不打扰主界面 */
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // 离开创建流程页时立刻补查一次（延迟弹出的触发点，不等下一轮 60s）
  useEffect(() => {
    if (!busy) poll();
  }, [busy, poll]);

  const ackAll = useCallback(async () => {
    setAcking(true);
    try {
      await Promise.all(
        alerts.map((a) => fetch(`/api/user/notifications/${a.id}/read`, { method: "PUT" })),
      );
      setAlerts([]);
    } catch {
      /* 失败下一轮还会弹，不吞告警 */
    }
    setAcking(false);
  }, [alerts]);

  if (busy || alerts.length === 0) return null;

  return (
    <Modal
      open
      title={
        <span style={{ color: "#cf1322" }}>
          <WarningOutlined style={{ marginRight: 8 }} />
          系统重大风险告警（{alerts.length} 条）
        </span>
      }
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={
        <Button type="primary" danger loading={acking} onClick={ackAll}>
          我知道了
        </Button>
      }
      width={560}
    >
      {alerts.map((a) => (
        <div key={a.id} style={{ marginBottom: 16, padding: "10px 12px", background: "#fff1f0", border: "1px solid #ffa39e", borderRadius: 6 }}>
          <div style={{ marginBottom: 6 }}>
            <Tag color="red">危险</Tag>
            <Text strong>{a.title}</Text>
          </div>
          <Paragraph style={{ marginBottom: 4, whiteSpace: "pre-wrap", fontSize: 13 }}>{a.content}</Paragraph>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(a.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）
          </Text>
        </div>
      ))}
    </Modal>
  );
}
