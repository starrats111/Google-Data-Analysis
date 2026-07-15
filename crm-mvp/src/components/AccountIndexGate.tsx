"use client";

/**
 * D-180：联盟序号确认强制弹窗
 *
 * 用户存在「某平台 ≥2 个在用连接、且有未确认序号」时，进系统强制弹窗，
 * 必须为每个平台的每个连接指定唯一、连续 1..N 的联盟序号后才能继续操作。
 * 单连接平台由后端自动确认，不会进入此弹窗。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Select, Table, Typography, Alert, message, Tag } from "antd";

const { Text, Paragraph } = Typography;

interface ConnRow {
  id: string;
  account_name: string;
  account_index: number | null;
  confirmed: boolean;
}
interface PlatformGroup {
  platform: string;
  connections: ConnRow[];
}

export default function AccountIndexGate() {
  const [platforms, setPlatforms] = useState<PlatformGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 平台 -> (连接id -> 选定序号)
  const [sel, setSel] = useState<Record<string, Record<string, number>>>({});

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/user/account-index/status").then((r) => r.json());
      if (res.code === 0 && res.data?.needsConfirm) {
        const ps: PlatformGroup[] = res.data.platforms;
        setPlatforms(ps);
        // 预填当前序号
        const init: Record<string, Record<string, number>> = {};
        for (const p of ps) {
          init[p.platform] = {};
          p.connections.forEach((c, i) => {
            init[p.platform][c.id] = c.account_index ?? i + 1;
          });
        }
        setSel(init);
        setOpen(true);
      }
    } catch {
      /* 静默：不阻塞主界面 */
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const setConnIndex = useCallback((platform: string, connId: string, idx: number) => {
    setSel((prev) => ({ ...prev, [platform]: { ...prev[platform], [connId]: idx } }));
  }, []);

  // 校验每个平台：序号唯一且覆盖 1..N
  const platformValid = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const p of platforms) {
      const n = p.connections.length;
      const vals = p.connections.map((c) => sel[p.platform]?.[c.id]);
      const uniq = new Set(vals);
      map[p.platform] =
        vals.every((v) => Number.isInteger(v) && v >= 1 && v <= n) && uniq.size === n;
    }
    return map;
  }, [platforms, sel]);

  const allValid = platforms.every((p) => platformValid[p.platform]);

  const handleConfirm = useCallback(async () => {
    if (!allValid) return;
    setSaving(true);
    try {
      for (const p of platforms) {
        const assignments = p.connections.map((c) => ({
          connectionId: c.id,
          accountIndex: sel[p.platform][c.id],
        }));
        const res = await fetch("/api/user/account-index/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: p.platform, assignments }),
        }).then((r) => r.json());
        if (res.code !== 0) {
          message.error(`${p.platform}：${res.message || "保存失败"}`);
          setSaving(false);
          return;
        }
      }
      message.success("联盟序号已确认，广告归属已按新序号重排");
      // 重新拉状态：若仍有未确认平台（理论上不会），继续弹
      setLoading(true);
      const res = await fetch("/api/user/account-index/status").then((r) => r.json());
      setLoading(false);
      if (res.code === 0 && res.data?.needsConfirm) {
        setPlatforms(res.data.platforms);
      } else {
        setOpen(false);
      }
    } catch {
      message.error("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  }, [allValid, platforms, sel]);

  if (!open) return null;

  return (
    <Modal
      title="确认联盟账号序号"
      open={open}
      closable={false}
      maskClosable={false}
      keyboard={false}
      confirmLoading={saving || loading}
      okText="确认并保存"
      okButtonProps={{ disabled: !allValid }}
      cancelButtonProps={{ style: { display: "none" } }}
      onOk={handleConfirm}
      width={720}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="你在以下平台有多个联盟账号，请为每个账号确认序号"
        description="广告系列名里的平台段序号（如 LH1 / PM2）会按此映射到具体联盟账号。序号错了会导致换链接、刷点击串号或失效。确认后系统会自动按新序号重排受影响的广告归属。"
      />
      {platforms.map((p) => {
        const n = p.connections.length;
        const options = Array.from({ length: n }, (_, i) => ({ value: i + 1, label: `${p.platform}${i + 1}` }));
        return (
          <div key={p.platform} style={{ marginBottom: 20 }}>
            <Paragraph style={{ marginBottom: 8 }}>
              <Text strong>{p.platform} 平台</Text>
              <Text type="secondary">（{n} 个账号，序号需 1~{n} 各不相同）</Text>
              {!platformValid[p.platform] && (
                <Tag color="red" style={{ marginLeft: 8 }}>序号有重复或缺失</Tag>
              )}
            </Paragraph>
            <Table
              dataSource={p.connections}
              rowKey="id"
              size="small"
              pagination={false}
              columns={[
                { title: "联盟账号", dataIndex: "account_name", key: "account_name", render: (v: string) => v || "(未命名)" },
                {
                  title: "序号",
                  key: "idx",
                  width: 160,
                  render: (_: unknown, row: ConnRow) => (
                    <Select
                      style={{ width: 120 }}
                      value={sel[p.platform]?.[row.id]}
                      options={options}
                      onChange={(v) => setConnIndex(p.platform, row.id, v)}
                    />
                  ),
                },
              ]}
            />
          </div>
        );
      })}
    </Modal>
  );
}
