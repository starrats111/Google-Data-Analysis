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
import { App, Button, Card, Input, Modal, Space, Table, Tabs, Tag, Tooltip, Typography, Popconfirm, Empty } from "antd";
import { ShareAltOutlined, StarFilled, StarOutlined, DeleteOutlined, SearchOutlined, ReloadOutlined, ThunderboltOutlined, EyeOutlined, ShopOutlined, FireOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import type { ColumnsType } from "antd/es/table";

const { Text } = Typography;

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
  const [tab, setTab] = useState<"mine" | "recommended" | "discoverable">("mine");

  // ─── 我的关注 ───────────────────────────────────────────
  const [mineRows, setMineRows] = useState<WatchlistItem[]>([]);
  const [mineTotal, setMineTotal] = useState(0);
  const [minePage, setMinePage] = useState(1);
  const [minePageSize, setMinePageSize] = useState(50);
  const [mineQ, setMineQ] = useState("");
  const [mineQInput, setMineQInput] = useState("");
  const [mineLoading, setMineLoading] = useState(false);

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

  const jumpToMerchants = useCallback((domain: string) => {
    router.push(`/user/merchants?q=${encodeURIComponent(domain)}`);
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

  const follow = useCallback(async (item: { advertiser_id: string; advertiser_name?: string | null; region: string }, afterDone?: () => void) => {
    const r = await fetch("/api/user/atc/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        advertiser_id: item.advertiser_id,
        advertiser_name: item.advertiser_name ?? null,
        region: item.region,
        min_days: 30,
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
          min_days: 30,
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
  const mineCols = useMemo<ColumnsType<WatchlistItem>>(() => [
    { title: "广告主", dataIndex: "advertiser_name", render: (_: string, row) => <AtcAdvertiserLink id={row.advertiser_id} name={row.advertiser_name} /> },
    { title: "Advertiser ID", dataIndex: "advertiser_id", width: 240, render: (v: string) => <Text copyable={{ text: v }} style={{ fontFamily: "monospace", fontSize: 12 }}>{v}</Text> },
    { title: "区域", dataIndex: "region", width: 60 },
    { title: "分类", width: 180, render: (_: unknown, row) => <QualifyingTag q={row.qualifying_domain_count} /> },
    { title: "提醒阈值", dataIndex: "min_days", width: 90, render: (v: number) => `≥ ${v} 天` },
    {
      title: "分享状态", dataIndex: "is_shared", width: 140,
      render: (v: boolean, row) => (
        <Button
          size="small" type={v ? "primary" : "default"}
          icon={v ? <StarFilled /> : <ShareAltOutlined />}
          onClick={() => toggleShare(row.id, !v)}
        >
          {v ? "已分享" : "分享给同事"}
        </Button>
      ),
    },
    {
      title: "操作", width: 220,
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          <Tooltip title={`查看持续投放 ≥ ${row.min_days} 天且近 2 天还在投的域名 / CRM 商家`}>
            <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openViewModal(row.id)}>查看</Button>
          </Tooltip>
          <Button size="small" type="link" onClick={() => router.push(`/user/intelligence?advertiser_id=${row.advertiser_id}&name=${encodeURIComponent(row.advertiser_name ?? "")}&region=${row.region}`)}>查情报</Button>
          <Popconfirm title="确认取消关注？" onConfirm={() => unfollow(row.id)}>
            <Button size="small" danger type="link" icon={<DeleteOutlined />}>取消</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ], [router, toggleShare, unfollow, openViewModal]);

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
      <Card
        title={<><StarFilled style={{ color: "#faad14", marginRight: 8 }} />我的广告主</>}
        bodyStyle={{ padding: 16 }}
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            关注同行广告主, 接收持续投放 ≥30 天的提醒; 分享给团队让协作更轻松
          </Text>
        }
      >
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as "mine" | "recommended" | "discoverable")}
          items={[
            {
              key: "mine",
              label: `我的关注${mineTotal > 0 ? ` (${mineTotal})` : ""}`,
              children: (
                <>
                  <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
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
          ]}
        />
      </Card>

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
                        <Tag color="green">{row.merchant.platform}</Tag>
                        <Text>{row.merchant.name}</Text>
                        <Tag>{row.merchant.status}</Tag>
                      </Space>
                    ) : (
                      <Text type="secondary">未在 CRM 商家库</Text>
                    ),
                },
                {
                  title: "操作",
                  width: 120,
                  render: (_: unknown, row) => (
                    <Button size="small" type="link" icon={<ShopOutlined />}
                      onClick={() => jumpToMerchants(row.domain)}
                    >
                      去商家页面
                    </Button>
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
