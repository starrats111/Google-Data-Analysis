"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Table, Tag, Button, Input, InputNumber, Space, Typography, Card, Row, Col,
  Tooltip, App, Statistic, Switch, Tabs, Popconfirm, Badge,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  SwapOutlined, ThunderboltOutlined, LinkOutlined,
  CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined,
  KeyOutlined, CopyOutlined, SyncOutlined, WarningOutlined, BellOutlined,
  AimOutlined, LoadingOutlined,
} from "@ant-design/icons";
import AppPageHeader from "@/components/AppPageHeader";

const { Text, Paragraph } = Typography;

interface StockInfo { available: number; leased: number; consumed: number }
interface ClickTaskInfo { status: string; target: number; done: number; finishedAt: string | null }
interface CampaignRow {
  campaignId: string;
  googleCampaignId: string | null;
  campaignName: string | null;
  country: string;
  googleStatus: string | null;
  platform: string;
  mid: string;
  matched: boolean;
  merchantId: string | null;
  merchantName: string | null;
  trackingLink: string | null;
  linkStatus: string;
  linkCheckReason: string | null;
  parentNetwork: string | null;
  parentBlacklisted: boolean;
  suffixEnabled: boolean;
  lastApplyAt: string | null;
  lastSuffix: string | null;
  stock: StockInfo;
  lowStock: boolean;
  clickTask: ClickTaskInfo | null;
}
interface AlertRow {
  id: string;
  campaignId: string | null;
  type: string;
  level: string;
  message: string;
  context: Record<string, unknown> | null;
  status: string;
  occurCount: number;
  lastSeenAt: string | null;
}
interface OverviewData {
  rows: CampaignRow[];
  apiKey: string | null;
  defaultClickCount: number;
  summary: { total: number; matched: number; totalAvailable: number; lowStockCount: number; alertOpen: number };
  alertSummary: Record<string, number>;
  stockConfig: { target: number; lowWatermark: number };
}

const ALERT_TYPE_LABEL: Record<string, string> = {
  invalid_link: "链接无效",
  merchant_not_found: "商家库找不到",
  low_stock: "库存偏低",
  replenish_failed: "补货失败",
};

function LinkStatusTag({ status, reason }: { status: string; reason?: string | null }) {
  if (status === "valid") return <Tag icon={<CheckCircleOutlined />} color="success">有效</Tag>;
  if (status === "invalid") return (
    <Tooltip title={reason ?? "链接无效"}><Tag icon={<CloseCircleOutlined />} color="error">无效</Tag></Tooltip>
  );
  return <Tag icon={<QuestionCircleOutlined />} color="default">未验证</Tag>;
}

export default function LinkExchangePage() {
  const { message } = App.useApp();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyVisible, setKeyVisible] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [replenishing, setReplenishing] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("links");
  const [brushCounts, setBrushCounts] = useState<Record<string, number>>({});
  const [brushing, setBrushing] = useState<string | null>(null);
  const [brushAllCount, setBrushAllCount] = useState<number>(10);
  const [brushingAll, setBrushingAll] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/user/link-exchange/overview").then((r) => r.json());
      if (res.code === 0) setData(res.data);
      else message.error(res.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true);
    try {
      const res = await fetch("/api/user/link-exchange/alerts?status=open&limit=200").then((r) => r.json());
      if (res.code === 0) setAlerts(res.data.rows);
    } finally {
      setAlertsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); fetchAlerts(); }, [fetchData, fetchAlerts]);

  const hasRunningBrush = (data?.rows ?? []).some(
    (r) => r.clickTask && (r.clickTask.status === "running" || r.clickTask.status === "pending"),
  );

  // 进入「库存管理」或有刷点击任务进行中时，每 10 秒轮询刷新进度
  useEffect(() => {
    const needPoll = activeTab === "stock" || (activeTab === "links" && hasRunningBrush);
    if (needPoll) {
      if (!pollRef.current) pollRef.current = setInterval(fetchData, 10000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [activeTab, hasRunningBrush, fetchData]);

  const handleResetKey = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/user/settings/script-api-key", { method: "POST" }).then((r) => r.json());
      if (res.code === 0) {
        message.success("API Key 已重置，请更新已部署的脚本");
        setKeyVisible(true);
        fetchData();
      } else message.error(res.message ?? "重置失败");
    } finally {
      setResetting(false);
    }
  };

  const handleGenerateKey = async () => {
    const res = await fetch("/api/user/settings/script-api-key", { method: "POST" }).then((r) => r.json());
    if (res.code === 0) { message.success("API Key 已生成"); setKeyVisible(true); fetchData(); }
    else message.error(res.message ?? "生成失败");
  };

  const handleReplenish = async (campaignId: string) => {
    setReplenishing(campaignId);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "replenish", campaignId }),
      }).then((r) => r.json());
      if (res.code === 0) {
        const d = res.data;
        if (d.skipped) message.info(`已跳过：${d.reason}`);
        else message.success(`补货完成：新增 ${d.generated} 条（失败 ${d.failed}），当前可用 ${d.after}`);
        fetchData(); fetchAlerts();
      } else message.error(res.message ?? "补货失败");
    } finally {
      setReplenishing(null);
    }
  };

  const handleReplenishAll = async () => {
    const res = await fetch("/api/user/link-exchange/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "replenishAll" }),
    }).then((r) => r.json());
    if (res.code === 0) {
      message.success(`已为 ${res.data.queued} 个低库存广告系列触发后台补货，稍后刷新查看`);
      setTimeout(() => { fetchData(); fetchAlerts(); }, 3000);
    } else message.error(res.message ?? "操作失败");
  };

  const handleBrushAll = async (count: number) => {
    setBrushingAll(true);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "brushAll", count }),
      }).then((r) => r.json());
      if (res.code === 0) {
        const d = res.data;
        if (d.queued > 0) message.success(`已为 ${d.queued} 个广告系列各启动刷 ${count} 次点击（跳过 ${d.skipped} 个），后台执行中`);
        else message.info(`没有可刷的广告系列（共 ${d.total} 个，均已在刷或未匹配）`);
        fetchData();
      } else message.error(res.message ?? "一次性刷点击启动失败");
    } finally {
      setBrushingAll(false);
    }
  };

  const handleSyncLinks = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "syncLinks" }),
      }).then((r) => r.json());
      if (res.code === 0) {
        if (res.data.queued > 0) {
          message.success(`已为 ${res.data.queued} 个商家触发后台同步（解析链接 + 校验上级联盟），稍后自动刷新`);
          setTimeout(() => { fetchData(); fetchAlerts(); }, 5000);
        } else {
          message.info("当前已启用广告系列的链接均已同步，无需处理");
          fetchData(); fetchAlerts();
        }
      } else message.error(res.message ?? "同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const handleBrush = async (campaignId: string, count: number) => {
    setBrushing(campaignId);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "brushClicks", campaignId, count }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(`已开始刷点击：目标 ${res.data.target} 次，后台执行中`);
        fetchData();
      } else message.error(res.message ?? "刷点击启动失败");
    } finally {
      setBrushing(null);
    }
  };

  const handleToggle = async (campaignId: string, enabled: boolean) => {
    const res = await fetch("/api/user/link-exchange/action", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle", campaignId, enabled }),
    }).then((r) => r.json());
    if (res.code === 0) {
      setData((prev) => prev ? { ...prev, rows: prev.rows.map((r) => r.campaignId === campaignId ? { ...r, suffixEnabled: enabled } : r) } : prev);
    } else message.error(res.message ?? "操作失败");
  };

  const handleResolveAlert = async (ids: string[]) => {
    const res = await fetch("/api/user/link-exchange/alerts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).then((r) => r.json());
    if (res.code === 0) { message.success(`已处理 ${res.data.resolved} 条告警`); fetchAlerts(); fetchData(); }
    else message.error(res.message ?? "操作失败");
  };

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const lowWatermark = data?.stockConfig.lowWatermark ?? 6;
  const defaultClickCount = data?.defaultClickCount ?? 10;
  // 链接管理只展示已启用（Google Ads ENABLED / 默认）的广告系列
  const enabledRows = rows.filter((r) => (r.googleStatus ?? "ENABLED") === "ENABLED");

  // ───────── 链接管理列 ─────────
  const linkColumns: ColumnsType<CampaignRow> = [
    {
      title: "广告系列", dataIndex: "campaignName", width: 230, ellipsis: true,
      render: (name: string | null, row) => (
        <Tooltip title={name}>
          <Space size={4}>
            {!row.matched && <Tag color="red" style={{ margin: 0, fontSize: 11 }}>未匹配</Tag>}
            <Text style={{ fontSize: 13 }}>{name ?? row.googleCampaignId ?? "—"}</Text>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: "平台 / MID", width: 110,
      render: (_: unknown, row) => row.platform ? (
        <Space size={2} direction="vertical" style={{ gap: 0 }}>
          <Tag color="blue" style={{ margin: 0 }}>{row.platform}</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>{row.mid}</Text>
        </Space>
      ) : <Text type="secondary" style={{ fontSize: 12 }}>未解析</Text>,
    },
    {
      title: "上级联盟", width: 100,
      render: (_: unknown, row) => {
        if (!row.matched) return <Text type="secondary">—</Text>;
        if (!row.parentNetwork) return <Text type="secondary" style={{ fontSize: 12 }}>未识别</Text>;
        return row.parentBlacklisted
          ? <Tooltip title="命中上级联盟黑名单"><Tag color="red" style={{ margin: 0 }}>{row.parentNetwork}</Tag></Tooltip>
          : <Tag color="geekblue" style={{ margin: 0 }}>{row.parentNetwork}</Tag>;
      },
    },
    { title: "国家", dataIndex: "country", width: 70, render: (v: string) => v ? <Tag>{v}</Tag> : "—" },
    {
      title: "商家追踪链接", width: 180,
      render: (_: unknown, row) => row.trackingLink ? (
        <Tooltip title={row.trackingLink}>
          <Button size="small" type="link" icon={<LinkOutlined />} style={{ padding: 0, fontSize: 12 }}
            onClick={() => { navigator.clipboard.writeText(row.trackingLink!); message.success("已复制"); }}>
            {row.merchantName ?? "复制链接"}
          </Button>
        </Tooltip>
      ) : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    {
      title: "链接状态", width: 90, align: "center",
      render: (_: unknown, row) => row.matched ? <LinkStatusTag status={row.linkStatus} reason={row.linkCheckReason} /> : <Text type="secondary">—</Text>,
    },
    {
      title: "换链开关", width: 90, align: "center",
      render: (_: unknown, row) => (
        <Switch size="small" checked={row.suffixEnabled} disabled={!row.matched}
          onChange={(checked) => handleToggle(row.campaignId, checked)} />
      ),
    },
    {
      title: "刷点击", width: 160, align: "center",
      render: (_: unknown, row) => {
        const task = row.clickTask;
        const running = task && (task.status === "running" || task.status === "pending");
        if (running) {
          return (
            <Tooltip title="刷点击进行中，每 10 秒自动刷新进度">
              <Space size={4}>
                <LoadingOutlined style={{ color: "#1677ff" }} />
                <Text style={{ fontSize: 12 }}>{task!.done}/{task!.target}</Text>
              </Space>
            </Tooltip>
          );
        }
        if (!row.matched) return <Text type="secondary">—</Text>;
        const count = brushCounts[row.campaignId] ?? defaultClickCount;
        return (
          <Space size={4}>
            <InputNumber size="small" min={1} max={1000} value={count} controls={false}
              style={{ width: 64 }}
              onChange={(v) => setBrushCounts((p) => ({ ...p, [row.campaignId]: Number(v) || 1 }))} />
            <Popconfirm
              title={`为该广告系列刷 ${count} 次点击？`}
              description="将通过代理访问联盟链接生成点击，产出的后缀进入换链库存。"
              onConfirm={() => handleBrush(row.campaignId, count)} okText="开始" cancelText="取消"
            >
              <Button size="small" type="primary" ghost icon={<AimOutlined />}
                loading={brushing === row.campaignId}>刷</Button>
            </Popconfirm>
            {task && task.status === "done" && <Tooltip title={`上次完成 ${task.done}/${task.target}`}><CheckCircleOutlined style={{ color: "#52c41a" }} /></Tooltip>}
            {task && task.status === "failed" && <Tooltip title="上次刷点击失败，见告警中心"><CloseCircleOutlined style={{ color: "#ff4d4f" }} /></Tooltip>}
          </Space>
        );
      },
    },
    {
      title: "最近换链", dataIndex: "lastApplyAt", width: 150,
      render: (v: string | null) => v ? <Text style={{ fontSize: 12 }}>{new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</Text> : <Text type="secondary">—</Text>,
    },
  ];

  // ───────── 库存管理列 ─────────
  const stockColumns: ColumnsType<CampaignRow> = [
    {
      title: "广告系列", dataIndex: "campaignName", width: 230, ellipsis: true,
      render: (name: string | null, row) => <Tooltip title={name}><Text style={{ fontSize: 13 }}>{name ?? row.googleCampaignId ?? "—"}</Text></Tooltip>,
    },
    { title: "平台/MID", width: 100, render: (_: unknown, row) => row.platform ? <Text style={{ fontSize: 12 }}>{row.platform}/{row.mid}</Text> : "—" },
    {
      title: "可用库存", width: 110, align: "center", sorter: (a, b) => a.stock.available - b.stock.available,
      render: (_: unknown, row) => (
        <Text style={{ fontSize: 14, fontWeight: 600, color: row.stock.available <= lowWatermark ? "#ff4d4f" : "#52c41a" }}>
          {row.stock.available}
          {row.matched && row.suffixEnabled && row.stock.available <= lowWatermark && <WarningOutlined style={{ marginLeft: 4 }} />}
        </Text>
      ),
    },
    { title: "占用中", dataIndex: ["stock", "leased"], width: 80, align: "center", render: (v: number) => <Text type="secondary">{v}</Text> },
    {
      title: "最近后缀", dataIndex: "lastSuffix", ellipsis: true,
      render: (v: string | null) => v ? <Tooltip title={v}><Text style={{ fontSize: 12 }} code>{v.length > 40 ? v.slice(0, 40) + "…" : v}</Text></Tooltip> : <Text type="secondary">—</Text>,
    },
    {
      title: "操作", width: 100, align: "center",
      render: (_: unknown, row) => (
        <Button size="small" type="primary" ghost icon={<ThunderboltOutlined />}
          loading={replenishing === row.campaignId} disabled={!row.matched || !row.suffixEnabled}
          onClick={() => handleReplenish(row.campaignId)}>补货</Button>
      ),
    },
  ];

  // ───────── 告警中心列 ─────────
  const alertColumns: ColumnsType<AlertRow> = [
    { title: "类型", dataIndex: "type", width: 120, render: (t: string) => <Tag color={t === "merchant_not_found" || t === "invalid_link" ? "red" : t === "replenish_failed" ? "volcano" : "orange"}>{ALERT_TYPE_LABEL[t] ?? t}</Tag> },
    { title: "级别", dataIndex: "level", width: 80, render: (l: string) => <Tag color={l === "error" ? "error" : l === "warning" ? "warning" : "default"}>{l}</Tag> },
    { title: "告警内容", dataIndex: "message", ellipsis: true, render: (m: string) => <Tooltip title={m}><Text style={{ fontSize: 13 }}>{m}</Text></Tooltip> },
    { title: "次数", dataIndex: "occurCount", width: 70, align: "center", render: (c: number) => <Badge count={c} overflowCount={999} style={{ backgroundColor: "#faad14" }} /> },
    { title: "最近", dataIndex: "lastSeenAt", width: 150, render: (v: string | null) => v ? <Text style={{ fontSize: 12 }}>{new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</Text> : "—" },
    {
      title: "操作", width: 90, align: "center",
      render: (_: unknown, row) => (
        <Popconfirm title="标记为已解决？" onConfirm={() => handleResolveAlert([row.id])} okText="确认" cancelText="取消">
          <Button size="small" type="link">处理</Button>
        </Popconfirm>
      ),
    },
  ];

  const apiKey = data?.apiKey ?? null;
  const maskedKey = apiKey ? apiKey.slice(0, 12) + "•".repeat(16) + apiKey.slice(-4) : "";

  return (
    <div>
      <AppPageHeader
        icon={<SwapOutlined />}
        title="换链接管理"
        extra={
          <Tooltip title="扫描已启用广告系列，为缺少链接/上级联盟的商家自动解析并验证联盟追踪链接">
            <Button type="primary" icon={<SyncOutlined />} onClick={handleSyncLinks} loading={syncing}>
              手动同步链接
            </Button>
          </Tooltip>
        }
      />

      {/* 概览统计 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="广告系列" value={summary?.total ?? 0} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="已匹配商家" value={summary?.matched ?? 0} styles={{ content: { color: "#52c41a" } }} /></Card></Col>
        <Col xs={12} sm={6}><Card size="small"><Statistic title="可用库存总量" value={summary?.totalAvailable ?? 0} /></Card></Col>
        <Col xs={12} sm={6}>
          <Card size="small">
            <Statistic title="待处理告警" value={summary?.alertOpen ?? 0}
              prefix={<BellOutlined style={{ color: (summary?.alertOpen ?? 0) > 0 ? "#ff4d4f" : undefined }} />}
              styles={{ content: { color: (summary?.alertOpen ?? 0) > 0 ? "#ff4d4f" : undefined } }} />
          </Card>
        </Col>
      </Row>

      {/* API Key 卡片 */}
      <Card size="small" style={{ marginBottom: 16 }} title={<Space><KeyOutlined /> 脚本 API Key</Space>}>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          统一 Google Ads 脚本（数据采集 + 换链接）通过此 Key 鉴权。脚本在「个人设置 → Google Ads MCC → 复制脚本」处生成，已自动填入此 Key，无需手动配置。
        </Paragraph>
        {apiKey ? (
          <Space wrap>
            <Input readOnly value={keyVisible ? apiKey : maskedKey} style={{ width: 380, fontFamily: "monospace" }} />
            <Button onClick={() => setKeyVisible((v) => !v)}>{keyVisible ? "隐藏" : "显示"}</Button>
            <Button icon={<CopyOutlined />} onClick={() => { navigator.clipboard.writeText(apiKey); message.success("API Key 已复制"); }}>复制</Button>
            <Popconfirm title="重置后旧 Key 立即失效，需更新所有已部署脚本，确认重置？" onConfirm={handleResetKey} okText="确认重置" cancelText="取消">
              <Button danger loading={resetting} icon={<SyncOutlined />}>重置</Button>
            </Popconfirm>
          </Space>
        ) : (
          <Button type="primary" icon={<KeyOutlined />} onClick={handleGenerateKey}>生成 API Key</Button>
        )}
      </Card>

      <Card size="small">
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: "links",
              label: "链接管理",
              children: (
                <>
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Text type="secondary" style={{ fontSize: 12 }}>每个系列刷</Text>
                    <InputNumber size="small" min={1} max={1000} value={brushAllCount} controls={false}
                      style={{ width: 72 }}
                      onChange={(v) => setBrushAllCount(Number(v) || 1)} />
                    <Text type="secondary" style={{ fontSize: 12 }}>次</Text>
                    <Popconfirm
                      title={`为全部已启用换链的广告系列各刷 ${brushAllCount} 次点击？`}
                      description="将为每个已匹配商家的系列后台生成点击（产出后缀进入换链库存），已在刷的自动跳过。"
                      onConfirm={() => handleBrushAll(brushAllCount)} okText="开始" cancelText="取消"
                    >
                      <Button type="primary" icon={<AimOutlined />} loading={brushingAll}>一次性刷点击（全部）</Button>
                    </Popconfirm>
                    <Text type="secondary" style={{ fontSize: 12 }}>仅对已开换链开关、已匹配商家的系列生效</Text>
                  </Space>
                  <Table<CampaignRow>
                    columns={linkColumns} dataSource={enabledRows} rowKey="campaignId" size="small" loading={loading}
                    pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
                    rowClassName={(row) => row.matched && row.linkStatus === "invalid" ? "row-invalid-link" : (!row.matched ? "row-unmatched" : "")}
                    scroll={{ x: 1240 }}
                  />
                </>
              ),
            },
            {
              key: "stock",
              label: <Space size={4}>库存管理 {(summary?.lowStockCount ?? 0) > 0 && <Badge count={summary?.lowStockCount} size="small" />}</Space>,
              children: (
                <>
                  <Space style={{ marginBottom: 12 }}>
                    <Popconfirm title="将为所有低库存且已启用换链的广告系列触发后台补货，确认？" onConfirm={handleReplenishAll} okText="确认" cancelText="取消">
                      <Button type="primary" icon={<ThunderboltOutlined />}>一键补货（低库存）</Button>
                    </Popconfirm>
                    <Text type="secondary" style={{ fontSize: 12 }}>低水位 ≤ {lowWatermark}，目标 {data?.stockConfig.target ?? 20}；进入此页每 10 秒自动刷新</Text>
                  </Space>
                  <Table<CampaignRow>
                    columns={stockColumns} dataSource={rows.filter((r) => r.matched)} rowKey="campaignId" size="small" loading={loading}
                    pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
                    rowClassName={(row) => row.suffixEnabled && row.stock.available <= lowWatermark ? "row-invalid-link" : ""}
                    scroll={{ x: 900 }}
                  />
                </>
              ),
            },
            {
              key: "alerts",
              label: <Space size={4}>告警中心 {alerts.length > 0 && <Badge count={alerts.length} size="small" />}</Space>,
              children: (
                <Table<AlertRow>
                  columns={alertColumns} dataSource={alerts} rowKey="id" size="small" loading={alertsLoading}
                  pagination={{ defaultPageSize: 20, showTotal: (t) => `共 ${t} 条` }}
                  locale={{ emptyText: "暂无待处理告警" }}
                />
              ),
            },
          ]}
        />
      </Card>

      <style>{`
        .row-unmatched td { background: #fff7f7 !important; }
        .row-invalid-link td { background: #fff1f0 !important; }
      `}</style>
    </div>
  );
}
