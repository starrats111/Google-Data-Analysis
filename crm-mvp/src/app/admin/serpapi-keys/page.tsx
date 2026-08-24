"use client";

// D-275：SerpApi Key 池管理（原「个人设置 → 广告情报」上收到管理员控制台）
// Key 自 D-215 起即全局共享池，ATC 情报 / 品牌评估 / 上广告竞品创意 / Hermes 商家情报统一取用。

import {
  Card, Table, Button, Input, Space, Tag, Typography, Popconfirm, App, Tooltip,
} from "antd";
import { PlusOutlined, SaveOutlined, EyeOutlined, ReloadOutlined } from "@ant-design/icons";
import { useEffect, useState, useCallback } from "react";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

interface KeyRow {
  id: string;
  key_name: string;
  masked_key: string;
  owner: string;
  is_active: boolean;
  exhausted_at: string | null;
  exhausted_msg: string | null;
  created_at: string;
}

export default function SerpApiKeysPage() {
  const { message } = App.useApp();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addVisible, setAddVisible] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testingNew, setTestingNew] = useState(false);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/serpapi-keys").then((r) => r.json());
      if (res.code === 0) setKeys(res.data);
      else message.error(res.message || "加载 Key 列表失败");
    } catch {
      message.error("加载 Key 列表失败，请刷新重试");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const handleAdd = async () => {
    const key = newKey.trim();
    if (!key) { message.warning("请输入 API Key"); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/serpapi-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, key_name: newKeyName.trim() || undefined }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("添加成功");
        setNewKey(""); setNewKeyName(""); setAddVisible(false); fetchKeys();
      } else message.error(res.message);
    } catch {
      message.error("网络异常，添加失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch("/api/admin/serpapi-keys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).then((r) => r.json());
      if (res.code === 0) { message.success("已删除"); fetchKeys(); }
      else message.error(res.message);
    } catch {
      message.error("网络异常，删除失败，请重试");
    }
  };

  const handleToggle = async (id: string, is_active: boolean) => {
    try {
      const res = await fetch("/api/admin/serpapi-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, is_active: !is_active }),
      }).then((r) => r.json());
      if (res.code === 0) { message.success(is_active ? "已禁用" : "已启用"); fetchKeys(); }
      else message.error(res.message);
    } catch {
      message.error("网络异常，操作失败，请重试");
    }
  };

  const handleTestExisting = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch("/api/admin/serpapi-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).then((r) => r.json());
      if (res.code === 0) message.success(res.message);
      else message.error(res.message);
    } catch {
      message.error("网络异常，测试失败，请重试");
    } finally {
      setTestingId(null);
    }
  };

  const handleTestNew = async () => {
    const key = newKey.trim();
    if (!key) { message.warning("请先输入 Key"); return; }
    setTestingNew(true);
    try {
      const res = await fetch("/api/admin/serpapi-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key }),
      }).then((r) => r.json());
      if (res.code === 0) message.success(res.message);
      else message.error(res.message);
    } catch {
      message.error("网络异常，测试失败，请重试");
    } finally {
      setTestingNew(false);
    }
  };

  const activeCount = keys.filter((k) => k.is_active).length;

  const columns = [
    { title: "备注名", dataIndex: "key_name", width: 130, render: (v: string) => <Text strong>{v}</Text> },
    { title: "Key（脱敏）", dataIndex: "masked_key", render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text> },
    { title: "录入人", dataIndex: "owner", width: 110 },
    {
      title: "状态", width: 140,
      render: (_: unknown, rec: KeyRow) => {
        if (!rec.is_active) return <Tag color="default">禁用</Tag>;
        if (rec.exhausted_at) {
          return (
            <Tooltip title={`${rec.exhausted_msg || "额度耗尽/限流"}（${new Date(rec.exhausted_at).toLocaleString("zh-CN")} 标记）`}>
              <Tag color="orange">冷却中</Tag>
            </Tooltip>
          );
        }
        return <Tag color="green">启用</Tag>;
      },
    },
    {
      title: "操作", width: 200,
      render: (_: unknown, rec: KeyRow) => (
        <Space size={4}>
          <Button size="small" loading={testingId === rec.id} onClick={() => handleTestExisting(rec.id)}>测试</Button>
          <Button size="small" onClick={() => handleToggle(rec.id, rec.is_active)}>{rec.is_active ? "禁用" : "启用"}</Button>
          <Popconfirm title="确认删除此 Key？" onConfirm={() => handleDelete(rec.id)}>
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <AppPageHeader
        icon={<EyeOutlined />}
        title="SerpApi Key 池"
        subtitle="全局共享池：广告情报(ATC) / 品牌评估 / 上广告竞品创意 / Hermes 商家情报统一取用"
      />
      <Card
        size="small"
        style={{ maxWidth: 860 }}
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={fetchKeys}>刷新</Button>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setAddVisible(true)}>添加 Key</Button>
          </Space>
        }
        title="Key 清单"
        loading={loading}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {keys.length > 0 && (
            <div style={{ background: "#f0f7ff", borderRadius: 6, padding: "8px 14px", fontSize: 12, color: "#1677ff" }}>
              池内 <strong>{keys.length}</strong> 个 Key，启用 <strong>{activeCount}</strong> 个 ·
              合计免费额度 <strong>{activeCount * 250}</strong> 次/月
            </div>
          )}

          {keys.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0", color: "#bfbfbf" }}>
              <EyeOutlined style={{ fontSize: 32, marginBottom: 8 }} />
              <div>池内暂无 Key，点击右上角「添加 Key」</div>
            </div>
          ) : (
            <Table dataSource={keys} columns={columns} rowKey="id" size="small" pagination={false} />
          )}

          {addVisible && (
            <Card size="small" style={{ background: "#fafafa" }} title="添加新 Key">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>备注名（选填）</Text>
                  <Input
                    placeholder={`Key ${keys.length + 1}`}
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    style={{ maxWidth: 200 }}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>SerpApi API Key</Text>
                  <Space.Compact style={{ width: "100%" }}>
                    <Input.Password
                      placeholder="粘贴 SerpApi API Key"
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <Button loading={testingNew} onClick={handleTestNew}>测试</Button>
                    <Button type="primary" loading={saving} icon={<SaveOutlined />} onClick={handleAdd}>添加</Button>
                    <Button onClick={() => { setAddVisible(false); setNewKey(""); setNewKeyName(""); }}>取消</Button>
                  </Space.Compact>
                </div>
              </div>
            </Card>
          )}

          <div style={{ background: "#f6f8fa", borderRadius: 6, padding: "10px 14px", fontSize: 12, color: "#666", lineHeight: "1.8" }}>
            <div><strong>免费额度</strong>：每 Key 250 次/月，多 Key 额度叠加</div>
            <div><strong>获取地址</strong>：<a href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer">serpapi.com → Dashboard → API Key</a></div>
            <div><strong>选取策略</strong>：随机轮换 + 撞额度自动换下一个；被判耗尽的 Key 进入冷却（限流 6h / 月额度 24h），期间不取用</div>
            <div><strong>冷却中</strong>：橙色标记表示该 Key 被 SerpApi 判额度耗尽/限流，冷却到期或测试成功后自动恢复</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
