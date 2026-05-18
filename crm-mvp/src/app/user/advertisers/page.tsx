/**
 * C-094.6 我的广告主页面
 *
 * 3 个 Tab:
 *   - 我的关注：当前用户关注的广告主, 可取消关注 / 切换分享 / 搜索
 *   - 推荐广告主：其他同事分享的 (按 advertiser+region 去重, 显示分享人列表)
 *   - 可关注广告主：所有员工查过的同行 (atc_advertiser_domain_snapshot 持久化), 支持批量关注
 */
"use client";
import { useState, useMemo, useCallback, useEffect } from "react";
import { App, Button, Card, Col, Input, InputNumber, Modal, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, Popconfirm, Empty } from "antd";
import { StarFilled, StarOutlined, DeleteOutlined, SearchOutlined, ReloadOutlined, ThunderboltOutlined, EyeOutlined, ShopOutlined, FireOutlined, CheckOutlined, GiftOutlined, CalendarOutlined, GlobalOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import type { ColumnsType } from "antd/es/table";
import MerchantNameCell from "@/components/MerchantNameCell";
import MerchantClaimModal, { type ClaimMerchant } from "@/components/MerchantClaimModal";
import { getCountryFlag } from "@/lib/constants";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

// 平台代码 → 主题色（与 user/merchants/page.tsx 保持一致）
const PLATFORM_COLOR: Record<string, string> = {
  RW: "#7c3aed", LH: "#16a34a", CG: "#2563eb", PM: "#ea580c", LB: "#0891b2",
  BSH: "#be185d", CF: "#ca8a04", AD: "#0f766e", MUI: "#b91c1c", EV: "#4338ca",
};

interface WatchlistItem {
  id: string;
  advertiser_id: string;
  advertiser_name: string | null;
  region: string;
  min_days: number;
  is_shared: boolean;
  qualifying_domain_count: number | null;
  ad_count: number | null;
  created_at: string;
}

interface RecommendedItem {
  advertiser_id: string;
  advertiser_name: string | null;
  region: string;
  shared_count: number;
  shared_by: Array<{ user_id: string; display_name: string }>;
  last_shared_at: string;
  qualifying_domain_count: number | null;
  ad_count: number | null;
  unique_domain_count: number | null;
  watched_by_me: boolean;
}

interface ActiveDomainItem {
  domain: string;
  max_creative_days: number;
  last_shown_ts: number;
  first_shown_ts: number;
  creative_count: number;
  qualifying?: boolean;
  merchant: null | {
    id: string;
    merchant_id: string;
    name: string;
    platform: string;
    url: string | null;
    status: string;
  };
}

interface ActiveDomainsResp {
  advertiser_id: string;
  advertiser_name: string | null;
  region: string;
  min_days: number;
  items: ActiveDomainItem[];
  all_domains: ActiveDomainItem[];
  ocr_pending: boolean;
  sampled_count?: number;
  ocr_success_count?: number;
  hint?: string;
}

interface DiscoverableItem {
  advertiser_id: string;
  advertiser_name: string | null;
  region: string;
  qualifying_domain_count: number;
  unique_domain_count: number;
  ad_count: number;
  top_qualifying_domains: Array<{ domain: string; max_creative_days: number }>;
  fetched_at: string;
  watched_by_me: boolean;
}

// D-018：今日广告 Tab 数据类型（v1.16 重写：列表主体 = domain，未命中商家不返回）
interface ConnectionAccount {
  id: string;
  account_name: string;
  platform: string;
  link: string;
}
interface MatchedMerchant {
  id: string;
  merchant_id: string;
  merchant_name: string;
  merchant_url: string | null;
  platform: string;
  status: string;
  policy_status: string | null;
  policy_category_code: string | null;
  supported_regions: unknown;
  campaign_link: string | null;
  tracking_link: string | null;
  logo_url: string | null;
  connection_accounts: ConnectionAccount[];
}
interface TodayAdItem {
  row_key: string;                    // `${advertiser_id}|${region}|${domain}` 唯一
  advertiser_id: string;
  advertiser_name: string | null;
  region: string;
  domain: string;                     // 单个 domain（D-018 重写：不再 +N 多 domain chip）
  days: number;                       // snapshot.max_creative_days
  qualifying: boolean;                // snapshot.has_long_running_creative
  creative_count: number;
  in_today_notification: boolean;     // 该 advertiser 今日是否有 ATC 推送
  atc_url: string;
  matched_merchant: MatchedMerchant;  // D-018：必然非 null（未命中已在后端过滤）
}
interface TodayAdsResp {
  stats: {
    total: number;
    matched: number;
    available: number;
    claimed_or_paused: number;
    today_only_count: number;
  };
  items: TodayAdItem[];
}

const COMMON_PAGINATION = {
  showSizeChanger: true,
  pageSizeOptions: ["10", "20", "50", "100"],
  showTotal: (t: number) => `共 ${t} 条`,
};

const AtcAdvertiserLink = ({ id, name }: { id: string; name: string | null }) => (
  <a href={`https://adstransparency.google.com/advertiser/${id}`} target="_blank" rel="noreferrer">
    {name || id}
  </a>
);

const QualifyingTag = ({ q }: { q: number | null | undefined }) => {
  if (q === null || q === undefined) return <Tag>未识别</Tag>;
  if (q >= 3) return <Tag color="green">同行 · {q} 合格域名</Tag>;
  if (q >= 1) return <Tag color="orange">品牌自投 · {q} 域名</Tag>;
  return <Tag>无合格域名</Tag>;
};

export default function AdvertisersPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [tab, setTab] = useState<"mine" | "recommended" | "discoverable" | "today">("mine");

  // ─── D-018 今日广告 Tab（v1.16 重写） ─────────────────────
  const [todayData, setTodayData] = useState<TodayAdsResp | null>(null);
  const [todayLoading, setTodayLoading] = useState(false);
  const [claimingMerchant, setClaimingMerchant] = useState<ClaimMerchant | null>(null);
  // D-008 F-4：今日广告 Tab 顶部国家筛选（"all" = 不过滤）
  const [todayRegionFilter, setTodayRegionFilter] = useState<string>("all");
  // D-018: 仅看今日推送 Switch（默认 false = 看全部 watchlist + snapshot）
  const [todayOnly, setTodayOnly] = useState<boolean>(false);
  // D-008 F-1=C：异步加载 region 选项
  const [todayRegionOptions, setTodayRegionOptions] = useState<Array<{ value: string; label: string }>>(
    [{ value: "all", label: "全部国家" }, { value: "US", label: "🇺🇸 美国 (US)" }]
  );
  useEffect(() => {
    fetch("/api/user/atc/regions")
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0 && Array.isArray(res.data?.regions)) {
          setTodayRegionOptions([
            { value: "all", label: "全部国家" },
            ...res.data.regions,
          ]);
        }
      })
      .catch(() => { /* 静默：失败保留 fallback */ });
  }, []);

  // 派生：根据 todayRegionFilter 过滤 items 和 stats（todayOnly 已在 API 端过滤）
  const todayFilteredData = useMemo<TodayAdsResp | null>(() => {
    if (!todayData) return null;
    if (todayRegionFilter === "all") return todayData;
    const filteredItems = todayData.items.filter((it) => it.region === todayRegionFilter);
    let availableCount = 0, claimedOrPausedCount = 0, todayCount = 0;
    for (const it of filteredItems) {
      const s = it.matched_merchant.status;
      if (s === "available") availableCount++;
      else if (s === "claimed" || s === "paused") claimedOrPausedCount++;
      if (it.in_today_notification) todayCount++;
    }
    return {
      stats: {
        total: filteredItems.length,
        matched: filteredItems.length,
        available: availableCount,
        claimed_or_paused: claimedOrPausedCount,
        today_only_count: todayCount,
      },
      items: filteredItems,
    };
  }, [todayData, todayRegionFilter]);

  const loadToday = useCallback(async () => {
    setTodayLoading(true);
    try {
      const params = new URLSearchParams(todayOnly ? { today: "1" } : {});
      const qs = params.toString();
      const r = await fetch(`/api/user/atc/today-ads${qs ? `?${qs}` : ""}`).then((x) => x.json());
      if (r.code === 0) {
        setTodayData(r.data as TodayAdsResp);
      } else {
        message.error(r.message || "加载失败");
      }
    } finally {
      setTodayLoading(false);
    }
  }, [todayOnly, message]);


  // ─── 我的关注 ───────────────────────────────────────────
  const [mineRows, setMineRows] = useState<WatchlistItem[]>([]);
  const [mineTotal, setMineTotal] = useState(0);
  const [minePage, setMinePage] = useState(1);
  const [minePageSize, setMinePageSize] = useState(50);
  const [mineQ, setMineQ] = useState("");
  const [mineQInput, setMineQInput] = useState("");
  const [mineLoading, setMineLoading] = useState(false);

  // C-094.11：用户级全局阈值（顶部控件管理；不再每行单独编辑）
  const [defaultMinDays, setDefaultMinDays] = useState<number>(30);
  const [thresholdInput, setThresholdInput] = useState<number>(30);
  const [thresholdSaving, setThresholdSaving] = useState(false);

  const loadMine = useCallback(async () => {
    setMineLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(minePage),
        page_size: String(minePageSize),
        ...(mineQ ? { q: mineQ } : {}),
      });
      const r = await fetch(`/api/user/atc/watchlist?${params.toString()}`).then((x) => x.json());
      if (r.code === 0) {
        setMineRows(r.data.items);
        setMineTotal(r.data.total);
      } else {
        message.error(r.message || "加载失败");
      }
    } finally {
      setMineLoading(false);
    }
  }, [minePage, minePageSize, mineQ, message]);

  // ─── 推荐广告主 ─────────────────────────────────────────
  const [recRows, setRecRows] = useState<RecommendedItem[]>([]);
  const [recTotal, setRecTotal] = useState(0);
  const [recPage, setRecPage] = useState(1);
  const [recPageSize, setRecPageSize] = useState(50);
  const [recQ, setRecQ] = useState("");
  const [recQInput, setRecQInput] = useState("");
  const [recLoading, setRecLoading] = useState(false);

  const loadRecommended = useCallback(async () => {
    setRecLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(recPage),
        page_size: String(recPageSize),
        ...(recQ ? { q: recQ } : {}),
      });
      const r = await fetch(`/api/user/atc/recommended?${params.toString()}`).then((x) => x.json());
      if (r.code === 0) {
        setRecRows(r.data.items);
        setRecTotal(r.data.total);
      } else {
        message.error(r.message || "加载失败");
      }
    } finally {
      setRecLoading(false);
    }
  }, [recPage, recPageSize, recQ, message]);

  // ─── 可关注广告主 ───────────────────────────────────────
  const [discRows, setDiscRows] = useState<DiscoverableItem[]>([]);
  const [discTotal, setDiscTotal] = useState(0);
  const [discPage, setDiscPage] = useState(1);
  const [discPageSize, setDiscPageSize] = useState(50);
  const [discQ, setDiscQ] = useState("");
  const [discQInput, setDiscQInput] = useState("");
  const [discLoading, setDiscLoading] = useState(false);
  const [discSelected, setDiscSelected] = useState<string[]>([]);
  // 跨页保留所选行的完整对象 (key = `${advertiser_id}|${region}`)
  const [discSelectedMap, setDiscSelectedMap] = useState<Map<string, DiscoverableItem>>(new Map());
  const [batchRunning, setBatchRunning] = useState(false);

  // ─── 查看活跃域名 Modal ─────────────────────────────────
  const [viewOpen, setViewOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewData, setViewData] = useState<ActiveDomainsResp | null>(null);
  const [viewMode, setViewMode] = useState<"recent" | "all">("recent");

  const openViewModal = useCallback(async (watchlistId: string) => {
    setViewOpen(true);
    setViewMode("recent");
    setViewLoading(true);
    setViewData(null);
    try {
      const r = await fetch(`/api/user/atc/watchlist/${watchlistId}/active-domains`).then((x) => x.json());
      if (r.code === 0) {
        setViewData(r.data);
      } else {
        message.error(r.message || "加载失败");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "加载失败");
    } finally {
      setViewLoading(false);
    }
  }, [message]);

  // C-094.12：跳转「我的商家」时根据 active-domains 返回的 merchant.status 选对应 tab
  //  - claimed / paused → 我的商家 tab（claimed）
  //  - available 或未匹配到 CRM 商家 → 选取商家 tab（available，搜索范围最大）
  const jumpToMerchants = useCallback((domain: string, merchant: ActiveDomainItem["merchant"]) => {
    const tab = merchant && (merchant.status === "claimed" || merchant.status === "paused")
      ? "claimed"
      : "available";
    router.push(`/user/merchants?q=${encodeURIComponent(domain)}&tab=${tab}`);
  }, [router]);

  const loadDiscoverable = useCallback(async () => {
    setDiscLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(discPage),
        page_size: String(discPageSize),
        min_qualifying: "3",
        ...(discQ ? { q: discQ } : {}),
      });
      const r = await fetch(`/api/user/atc/discoverable?${params.toString()}`).then((x) => x.json());
      if (r.code === 0) {
        setDiscRows(r.data.items);
        setDiscTotal(r.data.total);
      } else {
        message.error(r.message || "加载失败");
      }
    } finally {
      setDiscLoading(false);
    }
  }, [discPage, discPageSize, discQ, message]);

  // 按 tab 触发加载
  useEffect(() => { if (tab === "mine") void loadMine(); }, [tab, loadMine]);
  useEffect(() => { if (tab === "recommended") void loadRecommended(); }, [tab, loadRecommended]);
  useEffect(() => { if (tab === "discoverable") void loadDiscoverable(); }, [tab, loadDiscoverable]);
  useEffect(() => { if (tab === "today") void loadToday(); }, [tab, loadToday]);

  // C-094.11：加载用户全局阈值
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/user/atc/settings").then((x) => x.json());
        if (!cancelled && r.code === 0) {
          setDefaultMinDays(r.data.default_min_days);
          setThresholdInput(r.data.default_min_days);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const applyThreshold = useCallback(async () => {
    const next = Math.max(1, Math.min(365, Math.floor(thresholdInput)));
    if (next === defaultMinDays) {
      message.info("阈值未变更");
      return;
    }
    setThresholdSaving(true);
    try {
      const r = await fetch("/api/user/atc/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_min_days: next }),
      }).then((x) => x.json());
      if (r.code === 0) {
        setDefaultMinDays(next);
        setThresholdInput(next);
        message.success(`阈值已统一更新为 ≥ ${next} 天，已应用到 ${r.data.applied_rows} 个广告主`);
        if (tab === "mine") void loadMine();
      } else {
        message.error(r.message || "更新失败");
      }
    } finally {
      setThresholdSaving(false);
    }
  }, [thresholdInput, defaultMinDays, tab, loadMine, message]);

  // ─── 操作 ───────────────────────────────────────────────
  const unfollow = useCallback(async (id: string) => {
    const r = await fetch(`/api/user/atc/watchlist/${id}`, { method: "DELETE" }).then((x) => x.json());
    if (r.code === 0) {
      message.success("已取消关注");
      void loadMine();
    } else {
      message.error(r.message || "操作失败");
    }
  }, [loadMine, message]);

  const toggleShare = useCallback(async (id: string, next: boolean) => {
    const r = await fetch(`/api/user/atc/watchlist/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_shared: next }),
    }).then((x) => x.json());
    if (r.code === 0) {
      message.success(next ? "已分享到推荐列表" : "已取消分享");
      void loadMine();
    } else {
      message.error(r.message || "操作失败");
    }
  }, [loadMine, message]);

  // C-094.11：行级 min_days 已下线 —— 全局阈值统一管理（顶部控件）

  const follow = useCallback(async (item: { advertiser_id: string; advertiser_name?: string | null; region: string }, afterDone?: () => void) => {
    const r = await fetch("/api/user/atc/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        advertiser_id: item.advertiser_id,
        advertiser_name: item.advertiser_name ?? null,
        region: item.region,
        // 不传 min_days：后端会用 users.atc_default_min_days
      }),
    }).then((x) => x.json());
    if (r.code === 0) {
      message.success("已加入我的关注");
      afterDone?.();
    } else {
      message.error(r.message || "操作失败");
    }
  }, [message]);

  const batchFollow = useCallback(async () => {
    // 优先用跨页 Map (完整选中条目), 当前页里没的也能批量关注
    const fromMap = Array.from(discSelectedMap.values());
    const list = fromMap.length > 0
      ? fromMap
      : discRows.filter((r) => discSelected.includes(`${r.advertiser_id}|${r.region}`));
    if (list.length === 0) {
      message.warning("请先勾选要关注的广告主");
      return;
    }
    setBatchRunning(true);
    try {
      const r = await fetch("/api/user/atc/watchlist/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: list.map((it) => ({
            advertiser_id: it.advertiser_id,
            advertiser_name: it.advertiser_name,
            region: it.region,
          })),
          // 不传 min_days：后端会用 users.atc_default_min_days（全局阈值）
        }),
      }).then((x) => x.json());
      if (r.code === 0) {
        const d = r.data;
        message.success(`批量关注完成: 新增 ${d.created} / 复活 ${d.reactivated} / 已存在跳过 ${d.skipped}${d.invalid ? ` / 失败 ${d.invalid}` : ""}`);
        setDiscSelected([]);
        setDiscSelectedMap(new Map());
        void loadDiscoverable();
      } else {
        message.error(r.message || "批量关注失败");
      }
    } finally {
      setBatchRunning(false);
    }
  }, [discSelectedMap, discRows, discSelected, message, loadDiscoverable]);

  // ─── 表格列 ─────────────────────────────────────────────
  // C-094.11：移除行级"阈值（天）"列（全局阈值在顶部统一管理）
  //          "分享给同事"按钮 → Switch 小开关（与系统其他页面风格一致）
  const mineCols = useMemo<ColumnsType<WatchlistItem>>(() => [
    { title: "广告主", dataIndex: "advertiser_name", render: (_: string, row) => <AtcAdvertiserLink id={row.advertiser_id} name={row.advertiser_name} /> },
    { title: "Advertiser ID", dataIndex: "advertiser_id", width: 240, render: (v: string) => <Text copyable={{ text: v }} style={{ fontFamily: "monospace", fontSize: 12 }}>{v}</Text> },
    { title: "区域", dataIndex: "region", width: 60 },
    { title: "分类", width: 180, render: (_: unknown, row) => <QualifyingTag q={row.qualifying_domain_count} /> },
    {
      title: <Tooltip title="开启后会出现在同事的「推荐广告主」中">分享</Tooltip>,
      dataIndex: "is_shared", width: 80, align: "center" as const,
      render: (v: boolean, row) => (
        <Switch
          size="small"
          checked={v}
          onChange={(c) => toggleShare(row.id, c)}
          checkedChildren="开"
          unCheckedChildren="关"
        />
      ),
    },
    {
      title: "操作", width: 200,
      render: (_: unknown, row) => (
        <Space size={4}>
          <Tooltip title={`查看持续投放 ≥ ${defaultMinDays} 天且近 2 天还在投的域名 / CRM 商家`}>
            <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openViewModal(row.id)}>查看</Button>
          </Tooltip>
          <Button size="small" type="link" onClick={() => router.push(`/user/intelligence?advertiser_id=${row.advertiser_id}&name=${encodeURIComponent(row.advertiser_name ?? "")}&region=${row.region}`)}>查情报</Button>
          <Popconfirm title="确认取消关注？" onConfirm={() => unfollow(row.id)}>
            <Button size="small" danger type="link" icon={<DeleteOutlined />}>取消</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], [router, toggleShare, unfollow, openViewModal, defaultMinDays]);

  const recCols = useMemo<ColumnsType<RecommendedItem>>(() => [
    { title: "广告主", dataIndex: "advertiser_name", render: (_: string, row) => <AtcAdvertiserLink id={row.advertiser_id} name={row.advertiser_name} /> },
    { title: "Advertiser ID", dataIndex: "advertiser_id", width: 240, render: (v: string) => <Text copyable={{ text: v }} style={{ fontFamily: "monospace", fontSize: 12 }}>{v}</Text> },
    { title: "区域", dataIndex: "region", width: 60 },
    { title: "分类", width: 180, render: (_: unknown, row) => <QualifyingTag q={row.qualifying_domain_count} /> },
    {
      title: "分享人", dataIndex: "shared_by", width: 220,
      render: (_: unknown, row) => (
        <Tooltip title={row.shared_by.map((u) => u.display_name).join("、")}>
          <Space size={4} wrap>
            {row.shared_by.slice(0, 3).map((u) => <Tag key={u.user_id}>{u.display_name}</Tag>)}
            {row.shared_by.length > 3 && <Tag>+{row.shared_by.length - 3}</Tag>}
          </Space>
        </Tooltip>
      ),
    },
    {
      title: "操作", width: 200,
      render: (_: unknown, row) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => router.push(`/user/intelligence?advertiser_id=${row.advertiser_id}&name=${encodeURIComponent(row.advertiser_name ?? "")}&region=${row.region}`)}>查情报</Button>
          {row.watched_by_me ? (
            <Button size="small" type="link" disabled icon={<StarFilled />}>已关注</Button>
          ) : (
            <Button size="small" type="primary" icon={<StarOutlined />} onClick={() => follow(row, () => loadRecommended())}>关注</Button>
          )}
        </Space>
      ),
    },
  ], [router, follow, loadRecommended]);

  // D-018 今日广告 Tab 列定义（v1.16 重写：单 domain / matched_merchant 必非 null / 仅显示命中商家行）
  const todayCols = useMemo<ColumnsType<TodayAdItem>>(() => [
    {
      title: "商家名",
      key: "merchant",
      width: 260,
      render: (_: unknown, row) => {
        const m = row.matched_merchant;
        return (
          <MerchantNameCell
            rec={{
              merchant_name: m.merchant_name,
              merchant_url: m.merchant_url,
              campaign_link: m.campaign_link,
              tracking_link: m.tracking_link,
              connection_accounts: m.connection_accounts,
            }}
          />
        );
      },
    },
    {
      title: "平台",
      key: "platform",
      width: 70,
      render: (_: unknown, row) => (
        <Tag color={PLATFORM_COLOR[row.matched_merchant.platform] || "default"} style={{ fontWeight: 600 }}>
          {row.matched_merchant.platform}
        </Tag>
      ),
    },
    {
      title: "MID",
      key: "mid",
      width: 110,
      ellipsis: true,
      render: (_: unknown, row) => row.matched_merchant.merchant_id,
    },
    {
      title: <Tooltip title="匹配到该商家的合格域名（来自该广告主的 ATC 快照）">域名</Tooltip>,
      dataIndex: "domain",
      key: "domain",
      width: 220,
      render: (v: string, row) => (
        <Space size={4}>
          <Tag color="blue" style={{ margin: 0 }}>{v}</Tag>
          {row.in_today_notification && (
            <Tooltip title="该广告主今日 (CST 0 点起) 有 ATC 新推送">
              <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>今</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "广告主",
      key: "advertiser",
      render: (_: unknown, row) => (
        <a
          href={row.atc_url}
          target="_blank"
          rel="noreferrer"
          title="在 ATC 上查看该广告主"
        >
          {row.advertiser_name || row.advertiser_id}
        </a>
      ),
    },
    {
      title: <Tooltip title="该域名下最长创意持续投放天数（snapshot.max_creative_days）；≥180 天为长期主推（红）/ ≥60 橙 / ≥30 绿；🔥 = 该域名是 qualifying（has_long_running_creative）">投放时间</Tooltip>,
      dataIndex: "days",
      width: 130,
      align: "center" as const,
      sorter: (a, b) => a.days - b.days,
      defaultSortOrder: "descend" as const,
      render: (v: number, row) => {
        const color = v >= 180 ? "#f5222d" : v >= 60 ? "#fa8c16" : v >= 30 ? "#52c41a" : "#8c8c8c";
        return (
          <Space size={4}>
            {row.qualifying && <FireOutlined style={{ color: "#fa8c16" }} />}
            <span style={{ color, fontWeight: 600 }}>{v} 天</span>
          </Space>
        );
      },
    },
    {
      title: "国家",
      dataIndex: "region",
      width: 80,
      align: "center" as const,
      render: (v: string) => {
        const flag = getCountryFlag(v);
        return <span style={{ fontWeight: 500 }}>{flag ? `${flag} ` : ""}{v}</span>;
      },
    },
    {
      title: "操作",
      key: "action",
      width: 140,
      fixed: "right" as const,
      render: (_: unknown, row) => {
        const m = row.matched_merchant;
        if (m.status === "claimed" || m.status === "paused") {
          return (
            <Tooltip title="已在你名下，去我的商家页面查看">
              <Button
                size="small"
                type="link"
                icon={<CheckOutlined />}
                onClick={() => router.push(`/user/merchants?q=${encodeURIComponent(m.merchant_name || m.merchant_id)}&tab=claimed`)}
              >已领取</Button>
            </Tooltip>
          );
        }
        if (m.policy_status === "prohibited") {
          return <Button size="small" disabled>禁止领取</Button>;
        }
        return (
          <Button
            type="primary"
            size="small"
            icon={<GiftOutlined />}
            onClick={() => setClaimingMerchant({
              id: m.id,
              merchant_name: m.merchant_name,
              merchant_id: m.merchant_id,
              platform: m.platform,
              policy_status: m.policy_status ?? undefined,
              policy_category_code: m.policy_category_code ?? undefined,
              supported_regions: Array.isArray(m.supported_regions) ? (m.supported_regions as unknown[]) : null,
            })}
          >
            {m.policy_status === "restricted" ? "领取(限制)" : "领取"}
          </Button>
        );
      },
    },
  ], [router]);

  const discCols = useMemo<ColumnsType<DiscoverableItem>>(() => [
    { title: "广告主", dataIndex: "advertiser_name", render: (_: string, row) => <AtcAdvertiserLink id={row.advertiser_id} name={row.advertiser_name} /> },
    { title: "Advertiser ID", dataIndex: "advertiser_id", width: 240, render: (v: string) => <Text copyable={{ text: v }} style={{ fontFamily: "monospace", fontSize: 12 }}>{v}</Text> },
    { title: "区域", dataIndex: "region", width: 60 },
    { title: "合格域名", dataIndex: "qualifying_domain_count", width: 110, sorter: (a, b) => a.qualifying_domain_count - b.qualifying_domain_count, render: (v: number) => <Tag color="green">{v}</Tag> },
    { title: "总域名/广告数", width: 130, render: (_: unknown, row) => <Text type="secondary" style={{ fontSize: 12 }}>{row.unique_domain_count} / {row.ad_count}</Text> },
    {
      title: "热门域名", width: 220,
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          {row.top_qualifying_domains.map((d) => (
            <Tooltip key={d.domain} title={`最长创意投放 ${d.max_creative_days} 天`}>
              <Tag>{d.domain}</Tag>
            </Tooltip>
          ))}
        </Space>
      ),
    },
    {
      title: "操作", width: 180, fixed: "right" as const,
      render: (_: unknown, row) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => router.push(`/user/intelligence?advertiser_id=${row.advertiser_id}&name=${encodeURIComponent(row.advertiser_name ?? "")}&region=${row.region}`)}>查情报</Button>
          {row.watched_by_me ? (
            <Button size="small" type="link" disabled icon={<StarFilled />}>已关注</Button>
          ) : (
            <Button size="small" type="primary" icon={<StarOutlined />} onClick={() => follow(row, () => loadDiscoverable())}>关注</Button>
          )}
        </Space>
      ),
    },
  ], [router, follow, loadDiscoverable]);

  return (
    <div style={{ padding: 16 }}>
      <AppPageHeader
        icon={<StarFilled />}
        title="我的广告主"
        subtitle={`关注同行广告主，接收持续投放 ≥ ${defaultMinDays} 天的提醒；分享给团队让协作更轻松`}
      />
      <Card styles={{ body: { padding: 16 } }}>
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as "mine" | "recommended" | "discoverable" | "today")}
          items={[
            {
              key: "mine",
              label: `我的关注${mineTotal > 0 ? ` (${mineTotal})` : ""}`,
              children: (
                <>
                  <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Input
                      placeholder="搜索 ID / 名称"
                      prefix={<SearchOutlined />}
                      value={mineQInput}
                      onChange={(e) => setMineQInput(e.target.value)}
                      onPressEnter={() => { setMineQ(mineQInput); setMinePage(1); }}
                      style={{ width: 260 }}
                      allowClear
                      onClear={() => { setMineQInput(""); setMineQ(""); setMinePage(1); }}
                    />
                    <Button icon={<SearchOutlined />} onClick={() => { setMineQ(mineQInput); setMinePage(1); }}>搜索</Button>
                    <Button icon={<ReloadOutlined />} onClick={() => loadMine()}>刷新</Button>
                    {/* C-094.11：右侧统一阈值设置（所有关注的广告主共用同一个阈值） */}
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, padding: "4px 12px", background: "#fafafa", border: "1px solid #f0f0f0", borderRadius: 6 }}>
                      <Tooltip title="所有关注的广告主共用同一阈值：单创意持续投放达到该天数即视为合格；也是「查看」弹窗筛选活跃域名的最低门槛">
                        <Text type="secondary" style={{ fontSize: 13 }}>统一阈值</Text>
                      </Tooltip>
                      <InputNumber
                        size="small"
                        min={1}
                        max={365}
                        value={thresholdInput}
                        addonBefore="≥"
                        addonAfter="天"
                        style={{ width: 130 }}
                        onChange={(v) => setThresholdInput(Number(v) || 1)}
                        onPressEnter={() => applyThreshold()}
                      />
                      <Button
                        size="small"
                        type="primary"
                        loading={thresholdSaving}
                        disabled={thresholdInput === defaultMinDays}
                        onClick={() => applyThreshold()}
                      >
                        应用
                      </Button>
                    </div>
                  </div>
                  <Table<WatchlistItem>
                    rowKey="id"
                    loading={mineLoading}
                    dataSource={mineRows}
                    columns={mineCols}
                    size="small"
                    scroll={{ x: 1100 }}
                    pagination={{
                      ...COMMON_PAGINATION,
                      current: minePage, pageSize: minePageSize, total: mineTotal,
                      onChange: (p, ps) => { if (ps !== minePageSize) { setMinePageSize(ps); setMinePage(1); } else setMinePage(p); },
                    }}
                  />
                </>
              ),
            },
            {
              key: "recommended",
              label: `推荐广告主${recTotal > 0 ? ` (${recTotal})` : ""}`,
              children: (
                <>
                  <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
                    <Input
                      placeholder="搜索 ID / 名称"
                      prefix={<SearchOutlined />}
                      value={recQInput}
                      onChange={(e) => setRecQInput(e.target.value)}
                      onPressEnter={() => { setRecQ(recQInput); setRecPage(1); }}
                      style={{ width: 260 }}
                      allowClear
                      onClear={() => { setRecQInput(""); setRecQ(""); setRecPage(1); }}
                    />
                    <Button icon={<SearchOutlined />} onClick={() => { setRecQ(recQInput); setRecPage(1); }}>搜索</Button>
                    <Button icon={<ReloadOutlined />} onClick={() => loadRecommended()}>刷新</Button>
                    <Text type="secondary" style={{ alignSelf: "center", fontSize: 12 }}>
                      其他同事关注且勾选「分享」的广告主, 自己已经关注的会标灰
                    </Text>
                  </div>
                  <Table<RecommendedItem>
                    rowKey={(r) => `${r.advertiser_id}|${r.region}`}
                    loading={recLoading}
                    dataSource={recRows}
                    columns={recCols}
                    size="small"
                    scroll={{ x: 1100 }}
                    pagination={{
                      ...COMMON_PAGINATION,
                      current: recPage, pageSize: recPageSize, total: recTotal,
                      onChange: (p, ps) => { if (ps !== recPageSize) { setRecPageSize(ps); setRecPage(1); } else setRecPage(p); },
                    }}
                  />
                </>
              ),
            },
            {
              key: "discoverable",
              label: `可关注广告主${discTotal > 0 ? ` (${discTotal})` : ""}`,
              children: (
                <>
                  <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Input
                      placeholder="搜索 ID / 名称"
                      prefix={<SearchOutlined />}
                      value={discQInput}
                      onChange={(e) => setDiscQInput(e.target.value)}
                      onPressEnter={() => { setDiscQ(discQInput); setDiscPage(1); }}
                      style={{ width: 260 }}
                      allowClear
                      onClear={() => { setDiscQInput(""); setDiscQ(""); setDiscPage(1); }}
                    />
                    <Button icon={<SearchOutlined />} onClick={() => { setDiscQ(discQInput); setDiscPage(1); }}>搜索</Button>
                    <Button icon={<ReloadOutlined />} onClick={() => loadDiscoverable()}>刷新</Button>
                    <Text type="secondary" style={{ alignSelf: "center", fontSize: 12 }}>
                      所有员工查过的同行广告主 (合格域名 ≥ 3)
                    </Text>
                    <div style={{ flex: 1 }} />
                    {(discSelected.length > 0 || discSelectedMap.size > 0) && (
                      <Button
                        type="primary"
                        icon={<ThunderboltOutlined />}
                        loading={batchRunning}
                        onClick={batchFollow}
                      >
                        批量关注 ({discSelectedMap.size || discSelected.length})
                      </Button>
                    )}
                  </div>
                  <Table<DiscoverableItem>
                    rowKey={(r) => `${r.advertiser_id}|${r.region}`}
                    loading={discLoading}
                    dataSource={discRows}
                    columns={discCols}
                    size="small"
                    scroll={{ x: 1200 }}
                    rowSelection={{
                      selectedRowKeys: discSelected,
                      preserveSelectedRowKeys: true,
                      getCheckboxProps: (r) => ({ disabled: r.watched_by_me }),
                      onChange: (keys, selected) => {
                        setDiscSelected(keys as string[]);
                        setDiscSelectedMap((prev) => {
                          const next = new Map(prev);
                          // 移除当前页未勾选的
                          const currentKeys = new Set(discRows.map((r) => `${r.advertiser_id}|${r.region}`));
                          for (const k of next.keys()) {
                            if (currentKeys.has(k) && !keys.includes(k)) next.delete(k);
                          }
                          // 添加新勾选的
                          for (const row of selected) next.set(`${row.advertiser_id}|${row.region}`, row);
                          return next;
                        });
                      },
                    }}
                    pagination={{
                      ...COMMON_PAGINATION,
                      current: discPage, pageSize: discPageSize, total: discTotal,
                      onChange: (p, ps) => { if (ps !== discPageSize) { setDiscPageSize(ps); setDiscPage(1); } else setDiscPage(p); },
                    }}
                  />
                </>
              ),
            },
            // D-018 第 4 个 Tab：今日广告（v1.16 重写：列表 = 关注广告主合格域名 × 我的商家库）
            {
              key: "today",
              label: `今日广告${todayData?.stats.total ? ` (${todayData.stats.total})` : ""}`,
              children: (
                <>
                  <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                    <Col xs={12} sm={6}>
                      <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
                        <Statistic
                          title={<span style={{ fontSize: 12 }}>命中商家域名{todayRegionFilter !== "all" && ` (${todayRegionFilter})`}</span>}
                          value={todayFilteredData?.stats.total ?? 0}
                          loading={todayLoading}
                          prefix={<ShopOutlined style={{ color: "#1677ff" }} />}
                          valueStyle={{ fontSize: 22, fontWeight: 700 }}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
                        <Statistic
                          title={<span style={{ fontSize: 12 }}>待领取</span>}
                          value={todayFilteredData?.stats.available ?? 0}
                          loading={todayLoading}
                          prefix={<GiftOutlined style={{ color: "#52c41a" }} />}
                          valueStyle={{ fontSize: 22, fontWeight: 700, color: "#52c41a" }}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
                        <Statistic
                          title={<span style={{ fontSize: 12 }}>已领取/暂停</span>}
                          value={todayFilteredData?.stats.claimed_or_paused ?? 0}
                          loading={todayLoading}
                          prefix={<CheckOutlined style={{ color: "#fa8c16" }} />}
                          valueStyle={{ fontSize: 22, fontWeight: 700, color: "#fa8c16" }}
                        />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small" bodyStyle={{ padding: "10px 14px" }}>
                        <Statistic
                          title={<span style={{ fontSize: 12 }}>今日 ATC 推送</span>}
                          value={todayFilteredData?.stats.today_only_count ?? 0}
                          loading={todayLoading}
                          prefix={<CalendarOutlined style={{ color: "#722ed1" }} />}
                          valueStyle={{ fontSize: 22, fontWeight: 700, color: "#722ed1" }}
                        />
                      </Card>
                    </Col>
                  </Row>
                  {/* D-018 toolbar：刷新 + 国家筛选 + 仅看今日推送 Switch */}
                  <div style={{ marginBottom: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Button icon={<ReloadOutlined />} onClick={() => void loadToday()}>刷新</Button>
                    <Select
                      value={todayRegionFilter}
                      onChange={setTodayRegionFilter}
                      options={todayRegionOptions}
                      style={{ width: 180 }}
                      popupMatchSelectWidth={false}
                      size="small"
                    />
                    <Tooltip title="开启后仅显示今日 (CST 0 点起) 有 ATC 新推送的广告主对应行；关闭则显示所有 watchlist 当前快照的合格域名匹配项">
                      <Space size={6}>
                        <Switch size="small" checked={todayOnly} onChange={setTodayOnly} />
                        <Text style={{ fontSize: 12 }}>仅看今日 ATC 推送</Text>
                      </Space>
                    </Tooltip>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      <GlobalOutlined style={{ marginRight: 4 }} />
                      列表 = 关注广告主合格域名 × 我的商家库（未命中商家不显示）；🔥 = qualifying / 颜色 ≥180 红/≥60 橙/≥30 绿
                    </Text>
                  </div>
                  <Table<TodayAdItem>
                    rowKey="row_key"
                    loading={todayLoading}
                    dataSource={todayFilteredData?.items ?? []}
                    columns={todayCols}
                    size="small"
                    scroll={{ x: 1180 }}
                    pagination={{
                      pageSize: 50,
                      showSizeChanger: true,
                      pageSizeOptions: ["20", "50", "100", "200"],
                      showTotal: (t: number) => `共 ${t} 条`,
                    }}
                    locale={{ emptyText: <Empty description={todayOnly ? "今日还没有新的 ATC 推送命中你的商家库" : "你关注的广告主当前快照中暂无合格域名命中你的商家库；可去「可关注广告主」tab 添加更多广告主"} /> }}
                  />
                </>
              ),
            },
          ]}
        />
      </Card>

      {/* D-004：今日广告 Tab 领取 Modal */}
      <MerchantClaimModal
        open={!!claimingMerchant}
        merchant={claimingMerchant}
        onCancel={() => setClaimingMerchant(null)}
        onClaimed={(campaignId) => {
          setClaimingMerchant(null);
          // 领取后刷新今日列表（状态会变 claimed）
          void loadToday();
          if (campaignId) {
            setTimeout(() => router.push(`/user/ad-preview/${campaignId}`), 800);
          }
        }}
      />

      <Modal
        open={viewOpen}
        onCancel={() => setViewOpen(false)}
        footer={null}
        width={900}
        title={
          viewData ? (
            <Space>
              <ShopOutlined />
              <span>{viewData.advertiser_name || viewData.advertiser_id}</span>
              <Tag color="blue">{viewData.region}</Tag>
              <Tag>≥ {viewData.min_days} 天 · 近 2 天还在投</Tag>
            </Space>
          ) : "查看活跃域名"
        }
      >
        {viewLoading ? (
          <div style={{ padding: 40, textAlign: "center" }}>加载中…</div>
        ) : !viewData ? (
          <Empty />
        ) : viewData.hint && viewData.items.length === 0 && viewData.all_domains.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#8c8c8c" }}>{viewData.hint}</div>
        ) : (
          <>
            <div style={{ marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Space>
                <Button
                  size="small"
                  type={viewMode === "recent" ? "primary" : "default"}
                  onClick={() => setViewMode("recent")}
                >
                  近 2 天活跃 ({viewData.items.length})
                </Button>
                <Button
                  size="small"
                  type={viewMode === "all" ? "primary" : "default"}
                  onClick={() => setViewMode("all")}
                >
                  全部已采样域名 ({viewData.all_domains.length})
                </Button>
              </Space>
              {viewData.ocr_pending && (
                <Tag color="blue">部分图片 OCR 仍在识别中</Tag>
              )}
            </div>
            <Table<ActiveDomainItem>
              rowKey="domain"
              size="small"
              pagination={false}
              dataSource={viewMode === "recent" ? viewData.items : viewData.all_domains}
              locale={{ emptyText: viewMode === "recent" ? "暂无满足「持续 ≥ 阈值 + 近 2 天还在投」的域名" : "无采样域名" }}
              columns={[
                {
                  title: "域名",
                  dataIndex: "domain",
                  render: (v: string, row) => (
                    <Space size={6}>
                      {row.qualifying !== false && <FireOutlined style={{ color: "#fa8c16" }} />}
                      <Text strong>{v}</Text>
                    </Space>
                  ),
                },
                {
                  title: "持续天数",
                  dataIndex: "max_creative_days",
                  width: 100,
                  sorter: (a, b) => a.max_creative_days - b.max_creative_days,
                  render: (v: number) => {
                    const color = v >= 60 ? "#f5222d" : v >= 30 ? "#fa8c16" : "#52c41a";
                    return <span style={{ color, fontWeight: 600 }}>{v} 天</span>;
                  },
                },
                {
                  title: "最近投放",
                  dataIndex: "last_shown_ts",
                  width: 110,
                  render: (v: number) => v > 0 ? new Date(v * 1000).toISOString().slice(0, 10) : "-",
                },
                {
                  title: "创意数",
                  dataIndex: "creative_count",
                  width: 80,
                  render: (v: number) => <Tag>{v}</Tag>,
                },
                {
                  title: "CRM 命中商家",
                  width: 280,
                  render: (_: unknown, row) =>
                    row.merchant ? (
                      <Space size={4} wrap>
                        <Tag color="blue">{row.merchant.platform}</Tag>
                        <Text>{row.merchant.name}</Text>
                        {row.merchant.status === "claimed" && <Tag color="green">已认领</Tag>}
                        {row.merchant.status === "paused" && <Tag color="orange">已暂停</Tag>}
                        {row.merchant.status === "available" && <Tag>可领取</Tag>}
                      </Space>
                    ) : (
                      <Text type="secondary">未在 CRM 商家库</Text>
                    ),
                },
                {
                  title: "操作",
                  width: 140,
                  render: (_: unknown, row) => (
                    <Tooltip
                      title={
                        row.merchant
                          ? row.merchant.status === "claimed" || row.merchant.status === "paused"
                            ? "跳到「我的商家」"
                            : "跳到「选取商家」"
                          : "在「选取商家」里搜索（命中商家库则可领取）"
                      }
                    >
                      <Button size="small" type="link" icon={<ShopOutlined />}
                        onClick={() => jumpToMerchants(row.domain, row.merchant)}
                      >
                        去商家页面
                      </Button>
                    </Tooltip>
                  ),
                },
              ]}
            />
            {viewData.sampled_count !== undefined && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#8c8c8c" }}>
                共采样 {viewData.sampled_count} 张广告创意，OCR 成功 {viewData.ocr_success_count} 张
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
