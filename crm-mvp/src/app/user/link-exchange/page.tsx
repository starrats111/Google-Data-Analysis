"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Table, Tag, Button, Input, InputNumber, Space, Typography, Card, Row, Col,
  Tooltip, App, Statistic, Switch, Tabs, Popconfirm, Badge, Alert, Segmented, AutoComplete,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  SwapOutlined, ThunderboltOutlined, LinkOutlined,
  CheckCircleOutlined, CloseCircleOutlined, QuestionCircleOutlined,
  KeyOutlined, CopyOutlined, SyncOutlined, WarningOutlined, BellOutlined,
  AimOutlined, LoadingOutlined, EditOutlined, HistoryOutlined,
} from "@ant-design/icons";
import AppPageHeader from "@/components/AppPageHeader";
import { ALL_COUNTRIES } from "@/lib/constants";

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
  isStatic: boolean;
  todayClicks: number;
  todayOrders: number;
  conversion: number | null;
  refererUrl: string | null;
  refererSource: "manual" | "article" | "website" | "none";
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
  clickControlEnabled: boolean;
  clickControlRatio: { minPct: number; maxPct: number };
  scriptLoopIntervalSeconds: number | null;
  scriptLoopIntervalDefault: number;
  summary: { total: number; matched: number; totalAvailable: number; lowStockCount: number; alertOpen: number };
  alertSummary: Record<string, number>;
  stockConfig: { target: number; lowWatermark: number };
  proxyStatus: { kookeeyLow: boolean; kookeeyLeftGB: number | null; thresholdGB: number } | null;
}

interface HistoryDailyRow {
  date: string;
  brushSuccess: number;
  brushFailed: number;
  replenished: number;
  affiliateClicks: number;
}
interface HistoryCampaignRow {
  date: string;
  campaignId: string;
  campaignName: string | null;
  success: number;
  failed: number;
}
interface HistoryData {
  days: number;
  daily: HistoryDailyRow[];
  byCampaign: HistoryCampaignRow[];
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
  if (status === "no_link") return (
    <Tooltip title="该商家未配置联盟链接，点商家追踪链接列的编辑图标手动填写后会自动验证"><Tag icon={<WarningOutlined />} color="warning">缺链接</Tag></Tooltip>
  );
  if (status === "recheck") return (
    <Tooltip title={`链接可达，但巡航未跟到底（多为代理/网络波动），不代表链接无效，系统会自动重试。原因：${reason ?? "巡航未完成"}`}>
      <Tag icon={<SyncOutlined />} color="processing">待验证</Tag>
    </Tooltip>
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
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDays, setHistoryDays] = useState(7);
  const [activeTab, setActiveTab] = useState("links");
  const [brushCounts, setBrushCounts] = useState<Record<string, number>>({});
  const [brushing, setBrushing] = useState<string | null>(null);
  const [brushAllCount, setBrushAllCount] = useState<number>(10);
  const [brushingAll, setBrushingAll] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  // 「取链接」工具：输入联盟链接 + 国家 → 用该国动态住宅代理跟链，返回最终落地 URL
  const [fetchLinkInput, setFetchLinkInput] = useState("");
  const [fetchLinkCountry, setFetchLinkCountry] = useState<string>("US");
  const [fetchLinkLoading, setFetchLinkLoading] = useState(false);
  const [fetchLinkResult, setFetchLinkResult] = useState<{ finalUrl: string; hasTracking: boolean } | null>(null);
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
      else message.error(res.message ?? "预警加载失败");
    } finally {
      setAlertsLoading(false);
    }
  }, [message]);

  const fetchHistory = useCallback(async (days: number) => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/user/link-exchange/history?days=${days}`).then((r) => r.json());
      if (res.code === 0) setHistory(res.data);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); fetchAlerts(); }, [fetchData, fetchAlerts]);

  // 打开「历史记录」页或切换天数时按需加载
  useEffect(() => {
    if (activeTab === "history") fetchHistory(historyDays);
  }, [activeTab, historyDays, fetchHistory]);

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

  const [generatingKey, setGeneratingKey] = useState(false);
  const handleGenerateKey = async () => {
    if (generatingKey) return;
    setGeneratingKey(true);
    try {
      const res = await fetch("/api/user/settings/script-api-key", { method: "POST" }).then((r) => r.json());
      if (res.code === 0) { message.success("API Key 已生成"); setKeyVisible(true); fetchData(); }
      else message.error(res.message ?? "生成失败");
    } catch { message.error("网络异常，请重试"); }
    finally { setGeneratingKey(false); }
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

  const [replenishingAll, setReplenishingAll] = useState(false);
  const handleReplenishAll = async () => {
    if (replenishingAll) return;
    setReplenishingAll(true);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "replenishAll" }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(`已为 ${res.data.queued} 个低库存广告系列触发后台补货，稍后刷新查看`);
        setTimeout(() => { fetchData(); fetchAlerts(); }, 3000);
      } else message.error(res.message ?? "操作失败");
    } catch { message.error("网络异常，请重试"); }
    finally { setReplenishingAll(false); }
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
        if (d.queued > 0) message.success(`已为 ${d.queued} 个广告系列各排程刷 ${count} 次点击（跳过 ${d.skipped} 个），将按真人作息分散在今天自然执行`);
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

  const handleSaveLink = async (campaignId: string) => {
    const link = linkDraft.trim();
    if (!/^https?:\/\//i.test(link)) { message.error("请填写有效的 http(s) 链接"); return; }
    setSavingLink(true);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "updateLink", campaignId, trackingLink: link }),
      }).then((r) => r.json());
      if (res.code === 0) {
        if (res.data.validating) {
          message.success("链接已保存，正在后台验证，稍后刷新查看状态");
        } else {
          const ts = res.data.trackingStatus;
          const label = ts === "ok" ? "有效" : ts === "forbidden_network" ? "命中黑名单" : ts === "no_tracking" ? "未取到追踪参数" : ts === "resolve_failed" ? "解析失败" : (ts ?? "已保存");
          message.success(`链接已保存并验证：${label}`);
        }
        setEditingLinkId(null);
        fetchData(); fetchAlerts();
      } else message.error(res.message ?? "保存失败");
    } finally {
      setSavingLink(false);
    }
  };

  const handleFetchLink = async () => {
    const url = fetchLinkInput.trim();
    if (!/^https?:\/\//i.test(url)) { message.error("请填写有效的 http(s) 联盟链接"); return; }
    if (!/^[A-Z]{2}$/.test(fetchLinkCountry)) { message.error("请输入 2 位国家代码，如 US、ES、DE"); return; }
    setFetchLinkLoading(true);
    setFetchLinkResult(null);
    try {
      const res = await fetch("/api/user/link-exchange/fetch-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ affiliateUrl: url, country: fetchLinkCountry }),
      }).then((r) => r.json());
      if (res.code === 0 && res.data?.finalUrl) {
        setFetchLinkResult({ finalUrl: res.data.finalUrl, hasTracking: !!res.data.hasTracking });
        if (res.data.hasTracking) message.success("取链接成功，已跟到带追踪参数的最终链接");
        else message.warning("已跟到最终页面，但未检出追踪参数，请确认链接是否正确");
      } else message.error(res.message ?? "取链接失败");
    } catch {
      message.error("请求失败，请重试");
    } finally {
      setFetchLinkLoading(false);
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
        message.success(`已排程刷点击：目标 ${res.data.target} 次，将按真人作息分散在今天自然执行`);
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

  const [clickControlSaving, setClickControlSaving] = useState(false);
  const handleToggleClickControl = async (enabled: boolean) => {
    setClickControlSaving(true);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setClickControl", enabled }),
      }).then((r) => r.json());
      if (res.code === 0) {
        setData((prev) => prev ? { ...prev, clickControlEnabled: enabled } : prev);
        message.success(enabled ? "已开启订单/点击比自动补刷" : "已关闭订单/点击比自动补刷");
      } else message.error(res.message ?? "操作失败");
    } finally {
      setClickControlSaving(false);
    }
  };

  // 转化率(订单/点击)控制区间
  const [ratioMin, setRatioMin] = useState<number>(5);
  const [ratioMax, setRatioMax] = useState<number>(10);
  const [ratioSaving, setRatioSaving] = useState(false);
  useEffect(() => {
    if (data?.clickControlRatio) { setRatioMin(data.clickControlRatio.minPct); setRatioMax(data.clickControlRatio.maxPct); }
  }, [data?.clickControlRatio?.minPct, data?.clickControlRatio?.maxPct]);
  const handleSaveRatio = async () => {
    if (!(ratioMin >= 1 && ratioMax <= 100 && ratioMin < ratioMax)) { message.error("转化率区间需 1~100 且下限<上限"); return; }
    setRatioSaving(true);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setClickControl", ratioMinPct: ratioMin, ratioMaxPct: ratioMax }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("转化率区间已保存");
        setData((prev) => prev ? { ...prev, clickControlRatio: { minPct: ratioMin, maxPct: ratioMax } } : prev);
      } else message.error(res.message ?? "保存失败");
    } finally { setRatioSaving(false); }
  };

  // 换链脚本轮询间隔(秒)：用户自助。空=用默认15。改后脚本下一轮启动自动生效，无需重发脚本
  const scriptIntervalDefault = data?.scriptLoopIntervalDefault ?? 15;
  const [intervalSec, setIntervalSec] = useState<number | null>(null);
  const [intervalSaving, setIntervalSaving] = useState(false);
  useEffect(() => {
    if (data) setIntervalSec(data.scriptLoopIntervalSeconds ?? null);
  }, [data?.scriptLoopIntervalSeconds]);
  const handleSaveInterval = async (val: number | null) => {
    if (val != null && !(Number.isInteger(val) && val >= 10 && val <= 120)) {
      message.error("轮询间隔须为 10~120 秒整数（留空恢复默认15）"); return;
    }
    setIntervalSaving(true);
    try {
      const res = await fetch("/api/user/link-exchange/action", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setScriptInterval", loopIntervalSeconds: val }),
      }).then((r) => r.json());
      if (res.code === 0) {
        const saved = (res.data?.loopIntervalSeconds ?? null) as number | null;
        setIntervalSec(saved);
        setData((prev) => prev ? { ...prev, scriptLoopIntervalSeconds: saved } : prev);
        message.success(saved == null ? `已恢复默认 ${scriptIntervalDefault} 秒` : `换链轮询间隔已设为 ${saved} 秒`);
      } else message.error(res.message ?? "保存失败");
    } finally { setIntervalSaving(false); }
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
      title: "来路", width: 90, align: "center",
      render: (_: unknown, row) => {
        if (!row.matched) return <Text type="secondary">—</Text>;
        const meta: Record<CampaignRow["refererSource"], { t: string; c: string; tip: string }> = {
          manual: { t: "手动", c: "blue", tip: "商家手动配置的来路" },
          article: { t: "文章", c: "green", tip: "该商家最新已发布文章链接" },
          website: { t: "网站", c: "geekblue", tip: "联盟账号绑定的网站首页" },
          none: { t: "随机", c: "default", tip: "未配置来路，刷点击/补货时从随机来路池选取" },
        };
        const m = meta[row.refererSource] ?? meta.none;
        if (row.refererSource === "none" || !row.refererUrl) {
          return <Tooltip title={m.tip}><Tag style={{ margin: 0 }}>{m.t}</Tag></Tooltip>;
        }
        return (
          <Tooltip title={`${m.tip}：${row.refererUrl}（点击复制）`}>
            <Tag color={m.c} style={{ margin: 0, cursor: "pointer" }}
              onClick={() => { navigator.clipboard.writeText(row.refererUrl!); message.success("已复制来路"); }}>
              {m.t}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: "商家追踪链接", width: 260,
      render: (_: unknown, row) => {
        if (editingLinkId === row.campaignId) {
          return (
            <Space.Compact style={{ width: "100%" }}>
              <Input size="small" value={linkDraft} placeholder="https://联盟追踪链接"
                autoFocus disabled={savingLink}
                onChange={(e) => setLinkDraft(e.target.value)}
                onPressEnter={() => handleSaveLink(row.campaignId)} />
              <Button size="small" type="primary" loading={savingLink}
                onClick={() => handleSaveLink(row.campaignId)}>保存</Button>
              <Button size="small" disabled={savingLink} onClick={() => setEditingLinkId(null)}>取消</Button>
            </Space.Compact>
          );
        }
        if (!row.matched) {
          // 未匹配/孤儿：放开手动填链接入口，保存时后端按系列名自动关联或新建商家（自愈）
          return (
            <Space size={2}>
              <Text type="secondary" style={{ fontSize: 12 }}>未匹配商家</Text>
              <Tooltip title="手动填写联盟链接，系统将按系列名自动关联商家">
                <Button size="small" type="text" icon={<EditOutlined />}
                  onClick={() => { setEditingLinkId(row.campaignId); setLinkDraft(""); }} />
              </Tooltip>
            </Space>
          );
        }
        return (
          <Space size={2}>
            {row.trackingLink ? (
              <Tooltip title={row.trackingLink}>
                <Button size="small" type="link" icon={<LinkOutlined />} style={{ padding: 0, fontSize: 12 }}
                  onClick={() => { navigator.clipboard.writeText(row.trackingLink!); message.success("已复制"); }}>
                  {row.merchantName ?? "复制链接"}
                </Button>
              </Tooltip>
            ) : <Text type="secondary" style={{ fontSize: 12 }}>未填写</Text>}
            <Tooltip title="手动填写/编辑链接并立即验证">
              <Button size="small" type="text" icon={<EditOutlined />}
                onClick={() => { setEditingLinkId(row.campaignId); setLinkDraft(row.trackingLink ?? ""); }} />
            </Tooltip>
          </Space>
        );
      },
    },
    {
      title: <Tooltip title="今日(北京时间)该商家的联盟平台点击数">点击数</Tooltip>, width: 80, align: "center",
      render: (_: unknown, row) => <Text style={{ fontSize: 12 }}>{row.todayClicks}</Text>,
    },
    {
      title: <Tooltip title="今日(北京时间)该商家的联盟订单数">订单数</Tooltip>, width: 80, align: "center",
      render: (_: unknown, row) => <Text style={{ fontSize: 12 }}>{row.todayOrders}</Text>,
    },
    {
      title: <Tooltip title="转化率 = 订单 / 点击。目标区间内为绿色，高于上限(点击偏少)为红色，会自动补刷">转化率</Tooltip>, width: 90, align: "center",
      render: (_: unknown, row) => {
        if (row.conversion == null) return <Text type="secondary">—</Text>;
        const pct = row.conversion * 100;
        const min = data?.clickControlRatio?.minPct ?? 5;
        const max = data?.clickControlRatio?.maxPct ?? 10;
        const color = pct > max ? "#ff4d4f" : pct < min ? "#faad14" : "#52c41a";
        return <Text style={{ fontSize: 12, color, fontWeight: 500 }}>{pct.toFixed(1)}%</Text>;
      },
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
      title: "可用库存", width: 120, align: "center", sorter: (a, b) => a.stock.available - b.stock.available,
      render: (_: unknown, row) => {
        // 静态后缀商家：落地页参数固定（无 per-click clickid/token），库存天然只能维持在「不同内容数」（多为 1）。
        // 这是商家链接特性而非补货故障——不标红、不加告警图标，改用中性色 + 说明，消费后 lease 会自动重生成同一条。
        if (row.isStatic) {
          return (
            <Tooltip title="该商家落地页参数固定，不随每次点击变化，库存无法超过 1 条。这是正常现象，不影响换链——脚本领取后会自动重新生成，无需补货。">
              <Space size={4}>
                <Text style={{ fontSize: 14, fontWeight: 600, color: "#8c8c8c" }}>{row.stock.available}</Text>
                <Tag color="default" style={{ fontSize: 11, marginInlineEnd: 0 }}>静态链接</Tag>
              </Space>
            </Tooltip>
          );
        }
        const isLow = row.matched && row.suffixEnabled && row.stock.available <= lowWatermark;
        return (
          <Text style={{ fontSize: 14, fontWeight: 600, color: row.stock.available <= lowWatermark ? "#ff4d4f" : "#52c41a" }}>
            {row.stock.available}
            {isLow && <WarningOutlined style={{ marginLeft: 4 }} />}
          </Text>
        );
      },
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
        <Popconfirm
          title={row.type === "merchant_not_found" ? "确认点掉这条告警？" : "标记为已解决？"}
          description={
            row.type === "merchant_not_found"
              ? "若该商家确实没有佣金回流，可点掉；点掉后只要不再有新交易就不会重复提醒，一旦又有新订单才会再次告警。"
              : undefined
          }
          onConfirm={() => handleResolveAlert([row.id])}
          okText="确认"
          cancelText="取消"
        >
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
          <Space>
            <Tooltip title="开启后：有联盟订单时，系统按「每订单 10-20 次点击」自动补刷联盟点击，使转化率落在 5%-10%；每小时补量上限=该商家近7天日均点击的1/4，1小时内随机分散、真人化执行">
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 13 }}>订单/点击比自动补刷</Text>
                <Switch
                  size="small"
                  checked={data?.clickControlEnabled ?? false}
                  loading={clickControlSaving}
                  onChange={handleToggleClickControl}
                />
              </Space>
            </Tooltip>
            <Tooltip title="目标转化率(订单/点击)区间。系统会把转化率高于上限(点击偏少)的商家自动补刷到此区间内。例：5%~10% = 每订单 10~20 次点击">
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 13 }}>转化率区间</Text>
                <InputNumber size="small" min={1} max={99} value={ratioMin} controls={false}
                  style={{ width: 52 }} onChange={(v) => setRatioMin(Number(v) || 0)} addonAfter="%" />
                <Text type="secondary">~</Text>
                <InputNumber size="small" min={2} max={100} value={ratioMax} controls={false}
                  style={{ width: 52 }} onChange={(v) => setRatioMax(Number(v) || 0)} addonAfter="%" />
                <Button size="small" type="primary" ghost loading={ratioSaving} onClick={handleSaveRatio}>保存</Button>
              </Space>
            </Tooltip>
            <Tooltip title="换链脚本检测点击增长的轮询间隔（秒）。越小换链越快但增加 Google Ads 脚本负载；范围 10~120，留空=默认15。改后脚本下一轮启动自动生效，无需重新粘贴脚本到 MCC。">
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 13 }}>换链轮询间隔</Text>
                <InputNumber size="small" min={10} max={120} value={intervalSec} controls={false}
                  style={{ width: 78 }} placeholder={`默认${scriptIntervalDefault}`} addonAfter="秒"
                  onChange={(v) => setIntervalSec(v == null ? null : Number(v))} />
                <Button size="small" type="primary" ghost loading={intervalSaving} onClick={() => handleSaveInterval(intervalSec)}>保存</Button>
              </Space>
            </Tooltip>
            <Tooltip title="扫描已启用广告系列，为缺少链接/上级联盟的商家自动解析并验证联盟追踪链接">
              <Button type="primary" icon={<SyncOutlined />} onClick={handleSyncLinks} loading={syncing}>
                手动同步链接
              </Button>
            </Tooltip>
          </Space>
        }
      />

      {/* 换链接代理 kookeey 流量耗尽预警横幅：剩余 ≤ 阈值(默认5GB)时提示重置 */}
      {data?.proxyStatus?.kookeeyLow && (
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 16 }}
          message="换链接代理 kookeey 流量即将耗尽，请重置"
          description={
            <>
              kookeey 动态住宅流量仅剩{" "}
              <Text strong style={{ color: "#cf1322" }}>
                {data.proxyStatus.kookeeyLeftGB != null ? `${data.proxyStatus.kookeeyLeftGB} GB` : `≤ ${data.proxyStatus.thresholdGB} GB`}
              </Text>
              （告警阈值 {data.proxyStatus.thresholdGB} GB）。流量耗尽后 SOCKS5 会认证失败、换链接补货中断。
              请尽快登录 kookeey 后台重置/购买动态代理流量包。
            </>
          }
        />
      )}

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

      {/* API Key + 取链接 工具卡片 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={12}>
          <Card size="small" style={{ height: "100%" }} title={<Space><KeyOutlined /> 脚本 API Key</Space>}>
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
              <Button type="primary" icon={<KeyOutlined />} loading={generatingKey} onClick={handleGenerateKey}>生成 API Key</Button>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" style={{ height: "100%" }} title={<Space><LinkOutlined /> 取链接</Space>}>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              输入联盟链接 → 输入国家代码（如 US、ES、DE）→ 验证。用对应国家的动态住宅 IP 访问并跟随跳转，跳转到最终链接为成功（不换链、不入库存）。
            </Paragraph>
            <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
              <Input
                placeholder="粘贴联盟链接，如 https://www.linkhaitao.com/index.php?mod=lhdeal&track=..."
                value={fetchLinkInput}
                onChange={(e) => setFetchLinkInput(e.target.value)}
                onPressEnter={handleFetchLink}
                allowClear
              />
              <AutoComplete
                value={fetchLinkCountry}
                onChange={(v) => setFetchLinkCountry((v || "").toUpperCase().slice(0, 2))}
                style={{ width: 130 }}
                placeholder="国家代码"
                options={ALL_COUNTRIES.map((c) => ({ value: c.code, label: `${c.flag} ${c.code} ${c.name}` }))}
                filterOption={(input, option) =>
                  !!option && String(option.label).toUpperCase().includes(input.toUpperCase())
                }
              />
              <Button type="primary" loading={fetchLinkLoading} onClick={handleFetchLink}>
                {fetchLinkLoading ? "跟链中" : "验证"}
              </Button>
            </Space.Compact>
            {fetchLinkLoading && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                <LoadingOutlined /> 正在用 {fetchLinkCountry} 动态住宅 IP 跟随跳转，最长约 1 分钟…
              </Text>
            )}
            {fetchLinkResult && (
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  readOnly
                  value={fetchLinkResult.finalUrl}
                  style={{ fontFamily: "monospace", fontSize: 12 }}
                  status={fetchLinkResult.hasTracking ? undefined : "warning"}
                  prefix={fetchLinkResult.hasTracking
                    ? <CheckCircleOutlined style={{ color: "#52c41a" }} />
                    : <WarningOutlined style={{ color: "#faad14" }} />}
                />
                <Button icon={<CopyOutlined />}
                  onClick={() => { navigator.clipboard.writeText(fetchLinkResult.finalUrl); message.success("最终链接已复制"); }}>
                  复制
                </Button>
              </Space.Compact>
            )}
          </Card>
        </Col>
      </Row>

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
                    scroll={{ x: 1320 }}
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
                      <Button type="primary" icon={<ThunderboltOutlined />} loading={replenishingAll}>一键补货（低库存）</Button>
                    </Popconfirm>
                    <Text type="secondary" style={{ fontSize: 12 }}>低水位 ≤ {lowWatermark}，目标 {data?.stockConfig.target ?? 20}；进入此页每 10 秒自动刷新</Text>
                  </Space>
                  <Table<CampaignRow>
                    columns={stockColumns} dataSource={enabledRows.filter((r) => r.matched)} rowKey="campaignId" size="small" loading={loading}
                    pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true }}
                    rowClassName={(row) => !row.isStatic && row.suffixEnabled && row.stock.available <= lowWatermark ? "row-invalid-link" : ""}
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
            {
              key: "history",
              label: <Space size={4}><HistoryOutlined />历史记录</Space>,
              children: (
                <>
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Segmented
                      size="small"
                      value={historyDays}
                      onChange={(v) => setHistoryDays(Number(v))}
                      options={[{ label: "近7天", value: 7 }, { label: "近14天", value: 14 }, { label: "近30天", value: 30 }]}
                    />
                    <Button size="small" icon={<SyncOutlined />} loading={historyLoading} onClick={() => fetchHistory(historyDays)}>刷新</Button>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      按东八区自然日统计。展开某天可看各广告系列刷点击明细；「联盟平台点击」为联盟后台回传的真实点击，用于核对刷的点击是否生效。
                    </Text>
                  </Space>
                  <Table<HistoryDailyRow>
                    rowKey="date"
                    size="small"
                    loading={historyLoading}
                    dataSource={history?.daily ?? []}
                    pagination={false}
                    locale={{ emptyText: "暂无历史数据" }}
                    columns={[
                      { title: "日期", dataIndex: "date", width: 130 },
                      {
                        title: "刷点击成功", dataIndex: "brushSuccess", width: 110, align: "right",
                        render: (v: number) => <Text strong style={{ color: v > 0 ? "#52c41a" : undefined }}>{v}</Text>,
                      },
                      {
                        title: "刷点击失败", dataIndex: "brushFailed", width: 110, align: "right",
                        render: (v: number) => v > 0 ? <Text type="danger">{v}</Text> : <Text type="secondary">0</Text>,
                      },
                      { title: "库存产出", dataIndex: "replenished", width: 100, align: "right",
                        render: (v: number) => <Tooltip title="当天新增的换链库存条数（补货 + 刷点击均计入）"><span>{v}</span></Tooltip> },
                      {
                        title: "联盟平台点击", dataIndex: "affiliateClicks", width: 130, align: "right",
                        render: (v: number) => <Tooltip title="联盟后台 API 回传的真实点击数（含自然流量，通常 ≥ 刷的次数即表示已生效）"><Text style={{ color: v > 0 ? "#1677ff" : undefined }}>{v}</Text></Tooltip>,
                      },
                    ]}
                    expandable={{
                      rowExpandable: (row) => (history?.byCampaign ?? []).some((c) => c.date === row.date),
                      expandedRowRender: (row) => {
                        const items = (history?.byCampaign ?? []).filter((c) => c.date === row.date);
                        return (
                          <Table<HistoryCampaignRow>
                            rowKey={(r) => `${r.date}-${r.campaignId}`}
                            size="small"
                            dataSource={items}
                            pagination={false}
                            columns={[
                              { title: "广告系列", dataIndex: "campaignName", render: (n: string | null, r) => n || `#${r.campaignId}` },
                              { title: "刷成功", dataIndex: "success", width: 90, align: "right", render: (v: number) => <Text style={{ color: v > 0 ? "#52c41a" : undefined }}>{v}</Text> },
                              { title: "刷失败", dataIndex: "failed", width: 90, align: "right", render: (v: number) => v > 0 ? <Text type="danger">{v}</Text> : <Text type="secondary">0</Text> },
                            ]}
                          />
                        );
                      },
                    }}
                  />
                </>
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
