"use client";
import { useState, useCallback, useMemo, useEffect } from "react";
import { Card, Row, Col, Table, Input, Select, Button, Space, Tag, Modal, Form, Typography, Popconfirm, Switch, InputNumber, Tabs, App, Tooltip } from "antd";
import { ShopOutlined, SearchOutlined, CheckOutlined, DollarOutlined, CalendarOutlined, SaveOutlined, SyncOutlined, WarningOutlined, StarOutlined, CopyOutlined, LinkOutlined } from "@ant-design/icons";
import { PLATFORMS, BIDDING_STRATEGIES } from "@/lib/constants";
import { useApiWithParams, useStaleApi, mutateApi, refreshApi } from "@/lib/swr";
import { useRouter } from "next/navigation";
const { Text } = Typography;
// 主营业务英中翻译
const CATEGORY_CN: Record<string, string> = {
  "Others": "其他", "Health & Beauty": "健康美容", "Home & Garden": "家居园艺",
  "Online Services & Software": "在线服务与软件", "Telecommunications": "电信",
  "B2B": "企业服务", "Marketing": "营销", "Fashion": "时尚服饰",
  "Electronics": "电子产品", "Travel": "旅游出行", "Finance": "金融理财",
  "Education": "教育培训", "Food & Drink": "食品饮料", "Sports & Fitness": "运动健身",
  "Automotive": "汽车", "Entertainment": "娱乐", "Pets": "宠物",
  "Baby & Kids": "母婴", "Books & Media": "图书媒体", "Gifts & Flowers": "礼品鲜花",
  "Insurance": "保险", "Legal": "法律", "Real Estate": "房地产",
  "Art & Photography": "艺术摄影", "Music": "音乐", "Gaming": "游戏",
  "Jewelry & Watches": "珠宝手表", "Office Supplies": "办公用品",
  "Toys & Hobbies": "玩具爱好", "Outdoors": "户外运动", "Computers": "电脑",
  "Web Hosting": "网站托管", "VPN & Security": "VPN与安全", "Dating": "交友",
  "Clothing": "服装", "Shoes": "鞋类", "Accessories": "配饰",
  "Furniture": "家具", "Appliances": "家电", "Tools": "工具",
  "Software": "软件", "SaaS": "SaaS", "Crypto": "加密货币",
  "CBD & Cannabis": "CBD", "Supplements": "保健品", "Skincare": "护肤",
  "Cosmetics": "化妆品", "Fragrance": "香水", "Hair Care": "护发",
};
const catCn = (v: string | null) => { if (!v) return "-"; return CATEGORY_CN[v] || v; };
// __TYPES__
interface Merchant {
  id: string; merchant_name: string; platform: string; merchant_id: string;
  category: string | null; commission_rate: string | null;
  supported_regions: unknown[] | null;
  status: string; target_country: string | null; claimed_at: string | null;
  merchant_url: string | null; updated_at: string;
  violation_status?: string; recommendation_status?: string;
  policy_status?: string; policy_category_code?: string;
  ad_status?: string; ad_campaign_name?: string; ad_campaign_id?: string;
  tracking_link?: string | null; campaign_link?: string | null;
}
function getFaviconUrl(merchantUrl: string | null | undefined): string | null {
  if (!merchantUrl) return null;
  try {
    const url = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`);
    return `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`;
  } catch { return null; }
}
function MerchantNameCell({ rec, onCopy }: { rec: Merchant; onCopy: (link: string) => void }) {
  const favicon = getFaviconUrl(rec.merchant_url);
  const copyLink = rec.campaign_link || rec.tracking_link;
  return (
    <Space size={6}>
      {favicon && <img src={favicon} alt="" style={{ width: 20, height: 20, borderRadius: 4, objectFit: "contain" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}
      <span style={{ fontWeight: 600 }}>{rec.merchant_name || "-"}</span>
      {copyLink && (
        <Tooltip title="复制追踪链接">
          <CopyOutlined
            style={{ color: "#1677ff", cursor: "pointer", fontSize: 13 }}
            onClick={(e) => { e.stopPropagation(); onCopy(copyLink); }}
          />
        </Tooltip>
      )}
    </Space>
  );
}
interface MerchantResponse {
  merchants: Merchant[]; total: number; page: number; pageSize: number;
  stats: { total: number; claimed: number; byPlatform: { platform: string; _count: number }[] };
}
interface Holiday { id: string; holiday_name: string; holiday_date: string; holiday_type: string; country_code: string; }
const PC: Record<string, string> = { RW: "#7c3aed", LH: "#16a34a", CG: "#2563eb", PM: "#ea580c", LB: "#0891b2", BSH: "#be185d", CF: "#ca8a04" };
const PN: Record<string, string> = { alcohol: "酒精类", gambling: "赌博类", healthcare: "医疗保健", financial: "金融服务", adult: "成人内容", weapons: "武器/刀具", cannabis: "大麻类", tobacco: "烟草类" };
function RB({ r }: { r: unknown[] | null }) {
  if (!r || !Array.isArray(r) || r.length === 0) return <span>-</span>;
  const c = r.map((x) => (typeof x === "string" ? x : (x as any).code || String(x)));
  const s = c.slice(0, 3);
  return (<Tooltip title={c.join(", ")}><Space size={2} wrap>{s.map((v, i) => <Tag key={i} color="blue" style={{ fontSize: 11, margin: 0, padding: "0 4px" }}>{v}</Tag>)}{c.length > 3 && <span style={{ fontSize: 11, color: "#999" }}>+{c.length - 3}</span>}</Space></Tooltip>);
}
// __COMPONENT__
export default function MerchantsPage() {
  const { message } = App.useApp();
  const router = useRouter();
  const [tab, setTab] = useState("claimed");
  const [platform, setPlatform] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState("");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc" | "">("");
  const mp = useMemo(() => ({ tab, page, pageSize: 50, ...(platform ? { platform } : {}), ...(search ? { search } : {}), ...(labelFilter ? { label: labelFilter } : {}), ...(sortField ? { sortField, sortOrder } : {}) }), [tab, platform, search, labelFilter, page, sortField, sortOrder]);
  const { data: md, isLoading: ml } = useApiWithParams<MerchantResponse>((tab === "claimed" || tab === "available") ? "/api/user/merchants" : null, mp);
  const merchants = md?.merchants || [];
  const total = md?.total || 0;
  const stats = md?.stats || { total: 0, claimed: 0, byPlatform: [] };
  const { data: adData } = useStaleApi<{ bidding_strategy: string; ecpc_enabled: number; max_cpc: string; daily_budget: string; network_search: number; network_partners: number; network_display: number; naming_rule: string; naming_prefix: string }>("/api/user/ad-settings");
  const [adForm] = Form.useForm();
  useEffect(() => { if (adData) adForm.setFieldsValue({ ...adData, max_cpc: Number(adData.max_cpc), daily_budget: Number(adData.daily_budget) }); }, [adData, adForm]);
  const [vioSearch, setVioSearch] = useState(""); const [vioPage, setVioPage] = useState(1);
  const [recSearch, setRecSearch] = useState(""); const [recPage, setRecPage] = useState(1);
  const { data: vioData, isLoading: vl } = useApiWithParams<{ items: any[]; total: number }>(tab === "violations" ? "/api/user/merchants/sheet-sync" : null, { type: "violation", page: vioPage, pageSize: 50, ...(vioSearch ? { search: vioSearch } : {}) });
  const { data: recData, isLoading: rl } = useApiWithParams<{ items: any[]; total: number }>(tab === "recommendations" ? "/api/user/merchants/sheet-sync" : null, { type: "recommendation", page: recPage, pageSize: 50, ...(recSearch ? { search: recSearch } : {}) });
  const [cc, setCc] = useState(""); const [qc, setQc] = useState("");
  const { data: holidays, isLoading: hl } = useApiWithParams<Holiday[]>(qc ? "/api/user/holidays" : null, { country: qc });
  const [claimModal, setClaimModal] = useState(false); const [claimM, setClaimM] = useState<Merchant | null>(null); const [claimForm] = Form.useForm();
  const [platformConns, setPlatformConns] = useState<{ id: string; platform: string; account_name: string }[]>([]);
  const [rModal, setRModal] = useState(false); const [rTitle, setRTitle] = useState(""); const [rContent, setRContent] = useState("");
  // 在投人数弹窗
  const [advModal, setAdvModal] = useState(false);
  const [advMerchant, setAdvMerchant] = useState<Merchant | null>(null);
  const [advList, setAdvList] = useState<any[]>([]);
  const [advLoading, setAdvLoading] = useState(false);
  const showActiveAdv = useCallback(async (m: Merchant) => {
    setAdvMerchant(m); setAdvModal(true); setAdvLoading(true);
    try {
      const res = await fetch(`/api/user/merchants/active-advertisers?merchant_id=${m.merchant_id}&platform=${m.platform}`).then(r => r.json());
      setAdvList(res.data || []);
    } catch { setAdvList([]); }
    finally { setAdvLoading(false); }
  }, []);
  const [syncing, setSyncing] = useState(false);
  const doSync = useCallback(async () => { setSyncing(true); try { const r = await fetch("/api/user/merchants/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()); if (r.code === 0) { message.success(r.data?.message || "商家同步已开始，完成后将通知您"); setTimeout(() => refreshApi(/\/api\/user\/merchants/), 5000); setTimeout(() => refreshApi(/\/api\/user\/merchants/), 15000); setTimeout(() => refreshApi(/\/api\/user\/merchants/), 30000); setTimeout(() => refreshApi(/\/api\/user\/merchants/), 60000); } else message.error(r.message); } catch { message.error("同步失败"); } finally { setSyncing(false); } }, [message]);
  const saveAd = useCallback(async () => { const v = adForm.getFieldsValue(); const r = await mutateApi("/api/user/ad-settings", { method: "PUT", body: v }, ["/api/user/ad-settings"]); if (r.code === 0) message.success("已保存"); else message.error(r.message); }, [adForm, message]);
  const doClaim = useCallback(async (m: Merchant) => {
    setClaimM(m); claimForm.resetFields(); setClaimModal(true);
    try {
      const res = await fetch("/api/user/settings/platforms").then((r) => r.json());
      if (res.code === 0) {
        const conns = (res.data || []).filter((c: any) => c.platform === m.platform);
        setPlatformConns(conns);
        if (conns.length === 1) claimForm.setFieldValue("platform_connection_id", conns[0].id);
      }
    } catch { /* ignore */ }
  }, [claimForm]);
  const submitClaim = useCallback(async () => { const v = await claimForm.validateFields(); const r = await mutateApi("/api/user/merchants", { method: "POST", body: { merchant_id: claimM?.id, ...v } }, [/\/api\/user\/merchants/]); if (r.code === 0) { message.success("领取成功！正在跳转到广告预览..."); setClaimModal(false); const cid = (r.data as any)?.campaign_id; if (cid) { setTimeout(() => router.push(`/user/ad-preview/${cid}`), 800); } else { setTab("claimed"); } } else message.error(r.message); }, [claimForm, claimM, message, router]);
  const doRelease = useCallback(async (id: string) => { const r = await mutateApi("/api/user/merchants", { method: "PUT", body: { action: "release", ids: [id] } }, [/\/api\/user\/merchants/]); if (r.code === 0) message.success("已取消领取"); else message.error(r.message); }, [message]);
  const doSearch = useCallback(() => { setSearch(searchInput); setPage(1); }, [searchInput]);
  const handleTableChange = useCallback((_p: any, _f: any, sorter: any, extra: any) => {
    if (extra.action === "sort") {
      if (sorter.field && sorter.order) {
        setSortField(sorter.field as string);
        setSortOrder(sorter.order === "ascend" ? "asc" : "desc");
      } else {
        setSortField("");
        setSortOrder("");
      }
      setPage(1);
    }
  }, []);
  const colSortOrder = (field: string) => sortField === field ? (sortOrder === "asc" ? "ascend" as const : "descend" as const) : null;
// __COLUMNS__
  const copyLink = useCallback((link: string) => {
    navigator.clipboard.writeText(link).then(() => message.success("追踪链接已复制")).catch(() => message.error("复制失败"));
  }, [message]);
  const claimedCols = useMemo(() => [
    { title: "商家名称", dataIndex: "merchant_name", width: 240, sorter: true, sortOrder: colSortOrder("merchant_name"), render: (_: string, rec: Merchant) => <MerchantNameCell rec={rec} onCopy={copyLink} /> },
    { title: "平台", dataIndex: "platform", width: 80, render: (v: string) => <Tag color={PC[v] || "default"} style={{ fontWeight: 600 }}>{v}</Tag> },
    { title: "MID", dataIndex: "merchant_id", width: 100, ellipsis: true },
    { title: "主营业务", dataIndex: "category", width: 130, ellipsis: true, render: (v: string | null) => catCn(v) },
    { title: "佣金率", dataIndex: "commission_rate", width: 100, sorter: true, sortOrder: colSortOrder("commission_rate") },
    { title: "支持地区", dataIndex: "supported_regions", width: 150, render: (v: unknown[] | null) => <RB r={v} /> },
    { title: "状态", dataIndex: "ad_status", width: 90, render: (v: string) => v === "ENABLED" ? <Tag color="green">已投放</Tag> : v === "PAUSED" ? <Tag color="orange">暂停</Tag> : v === "NOT_SUBMITTED" ? <Tag color="blue">已领取</Tag> : <Tag>未知</Tag> },
    { title: "在投人数", dataIndex: "active_advertisers", width: 90, align: "center" as const, render: (v: number, rec: Merchant) => { const n = v || 0; return n > 0 ? <Button size="small" type="link" style={{ padding: 0, fontWeight: 600 }} onClick={() => showActiveAdv(rec)}>{n} 人</Button> : <span style={{ color: "#bfbfbf" }}>0</span>; } },
    { title: "标签", width: 120, render: (_: unknown, rec: any) => { const labels = rec.labels || []; if (labels.length === 0) return <span style={{ color: "#ccc" }}>-</span>; return <Space size={4} wrap>{labels.map((l: any, i: number) => <Tooltip key={i} title={l.detail}><Tag color={l.color} style={{ cursor: "pointer" }}>{l.text}</Tag></Tooltip>)}</Space>; } },
    { title: "操作", width: 100, render: (_: unknown, rec: Merchant) => <Popconfirm title="确认取消领取？" onConfirm={() => doRelease(rec.id)}><Button size="small" danger>取消领取</Button></Popconfirm> },
  ], [doRelease, showActiveAdv, copyLink, sortField, sortOrder]);
  const availCols = useMemo(() => [
    { title: "商家名称", dataIndex: "merchant_name", width: 240, sorter: true, sortOrder: colSortOrder("merchant_name"), render: (_: string, rec: Merchant) => <MerchantNameCell rec={rec} onCopy={copyLink} /> },
    { title: "平台", dataIndex: "platform", width: 80, render: (v: string) => <Tag color={PC[v] || "default"} style={{ fontWeight: 600 }}>{v}</Tag> },
    { title: "MID", dataIndex: "merchant_id", width: 100, ellipsis: true },
    { title: "主营业务", dataIndex: "category", width: 130, ellipsis: true, render: (v: string | null) => catCn(v) },
    { title: "佣金率", dataIndex: "commission_rate", width: 100, sorter: true, sortOrder: colSortOrder("commission_rate") },
    { title: "支持地区", dataIndex: "supported_regions", width: 150, render: (v: unknown[] | null) => <RB r={v} /> },
    { title: "在投人数", dataIndex: "active_advertisers", width: 90, align: "center" as const, render: (v: number, rec: Merchant) => { const n = v || 0; return n > 0 ? <Button size="small" type="link" style={{ padding: 0, fontWeight: 600 }} onClick={() => showActiveAdv(rec)}>{n} 人</Button> : <span style={{ color: "#bfbfbf" }}>0</span>; } },
    { title: "标签", width: 140, render: (_: unknown, rec: any) => { const labels = rec.labels || []; if (labels.length === 0) return <span style={{ color: "#ccc" }}>-</span>; return <Space size={4} wrap>{labels.map((l: any, i: number) => <Tooltip key={i} title={l.detail}><Tag color={l.color} style={{ cursor: "pointer" }}>{l.text}</Tag></Tooltip>)}</Space>; } },
    { title: "操作", width: 100, render: (_: unknown, rec: Merchant) => rec.policy_status === "prohibited" ? <Button size="small" disabled>禁止领取</Button> : <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => doClaim(rec)}>{rec.policy_status === "restricted" ? "领取(限制)" : "领取"}</Button> },
  ], [doClaim, showActiveAdv, copyLink, sortField, sortOrder]);
  const vioCols = useMemo(() => [
    { title: "商家名称", dataIndex: "merchant_name", width: 200, ellipsis: true },
    { title: "平台", dataIndex: "platform", width: 80, render: (v: string) => v ? <Tag>{v}</Tag> : <Tag>全平台</Tag> },
    { title: "商家域名", dataIndex: "merchant_domain", width: 180, ellipsis: true, render: (v: string) => v ? <a href={v.startsWith("http") ? v : `https://${v}`} target="_blank" rel="noreferrer">{v}</a> : "-" },
    { title: "违规原因", dataIndex: "violation_reason", width: 120, render: (v: string) => v ? <Button type="link" size="small" onClick={() => { setRTitle("违规原因"); setRContent(v); setRModal(true); }}>查看</Button> : "-" },
    { title: "违规时间", dataIndex: "violation_time", width: 140, render: (v: string) => v ? new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-" },
    { title: "名单来源", dataIndex: "source", width: 100, render: (v: string) => v || "-" },
  ], []);
  const recCols = useMemo(() => [
    { title: "商家名称", dataIndex: "merchant_name", width: 200, ellipsis: true },
    { title: "ROI参考", dataIndex: "roi_reference", width: 100, render: (v: string) => v || "-" },
    { title: "佣金率", dataIndex: "commission_info", width: 100, render: (v: string) => v || "-" },
    { title: "结算率", dataIndex: "settlement_info", width: 100, render: (v: string) => v || "-" },
    { title: "备注", dataIndex: "remark", width: 200, render: (v: string) => v ? <Button type="link" size="small" onClick={() => { setRTitle("推荐详情"); setRContent(v); setRModal(true); }}>查看</Button> : "-" },
    { title: "分享时间", dataIndex: "share_time", width: 100, render: (v: string) => v || "-" },
  ], []);
  return (<div>
    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
      <Col xs={24} md={8}><Card size="small" title={<><ShopOutlined /> 我的商家</>} style={{ height: "100%" }}>
        <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>{stats.total.toLocaleString()}</div>
        <Text type="secondary" style={{ fontSize: 12 }}>平台分布</Text>
        <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>{stats.byPlatform.map((p) => <Tag key={p.platform} color={PC[p.platform] || "default"} style={{ fontWeight: 600 }}>{p.platform} {p._count.toLocaleString()}</Tag>)}</div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>在投广告 {stats.claimed} 个商家</div>
      </Card></Col>
      <Col xs={24} md={8}><Card size="small" title={<><DollarOutlined /> 广告投放设置</>} extra={<Button type="primary" size="small" icon={<SaveOutlined />} onClick={saveAd}>保存</Button>} style={{ height: "100%" }}>
        {adData && (<Form form={adForm} size="small" layout="vertical" style={{ fontSize: 12 }}>
          <Row gutter={[8, 0]}>
            <Col span={12}><Form.Item name="bidding_strategy" label="出价策略" style={{ marginBottom: 6 }}><Select options={BIDDING_STRATEGIES.map((b) => ({ value: b.value, label: b.label }))} /></Form.Item></Col>
            <Col span={6}><Form.Item name="ecpc_enabled" label="eCPC" valuePropName="checked" style={{ marginBottom: 6 }} getValueFromEvent={(c: boolean) => c ? 1 : 0} getValueProps={(v: number) => ({ checked: v === 1 })}><Switch size="small" /></Form.Item></Col>
            <Col span={6}><Form.Item name="max_cpc" label="CPC($)" style={{ marginBottom: 6 }}><InputNumber prefix="$" style={{ width: "100%" }} min={0.01} step={0.1} /></Form.Item></Col>
          </Row>
          <Row gutter={[8, 0]}>
            <Col span={8}><Form.Item name="daily_budget" label="日预算($)" style={{ marginBottom: 6 }}><InputNumber prefix="$" style={{ width: "100%" }} min={0.5} step={0.5} /></Form.Item></Col>
            <Col span={16}><div style={{ marginBottom: 4, fontSize: 12, color: "#666" }}>投放网络</div><Space size={12}>
              <Form.Item name="network_search" valuePropName="checked" noStyle getValueFromEvent={(c: boolean) => c ? 1 : 0} getValueProps={(v: number) => ({ checked: v === 1 })}><Switch size="small" checkedChildren="搜索" unCheckedChildren="搜索" /></Form.Item>
              <Form.Item name="network_partners" valuePropName="checked" noStyle getValueFromEvent={(c: boolean) => c ? 1 : 0} getValueProps={(v: number) => ({ checked: v === 1 })}><Switch size="small" checkedChildren="合作伙伴" unCheckedChildren="合作伙伴" /></Form.Item>
              <Form.Item name="network_display" valuePropName="checked" noStyle getValueFromEvent={(c: boolean) => c ? 1 : 0} getValueProps={(v: number) => ({ checked: v === 1 })}><Switch size="small" checkedChildren="展示" unCheckedChildren="展示" /></Form.Item>
            </Space></Col>
          </Row>
          <Row gutter={[8, 0]}>
            <Col span={12}><Form.Item name="naming_rule" label="命名规则" style={{ marginBottom: 6 }}><Select options={[{ value: "global", label: "全局序号 (001,002,003...)" }, { value: "per_platform", label: "平台序号 (CG:001,RW:001...)" }]} /></Form.Item></Col>
            <Col span={12}><Form.Item name="eu_political_ad" label="EU政治广告" valuePropName="checked" style={{ marginBottom: 6 }} getValueFromEvent={(c: boolean) => c ? 1 : 0} getValueProps={(v: number) => ({ checked: v === 1 })}><Switch size="small" checkedChildren="含" unCheckedChildren="不含" /></Form.Item></Col>
          </Row>
        </Form>)}
      </Card></Col>
      <Col xs={24} md={8}><Card size="small" title={<><CalendarOutlined /> 节日营销</>} style={{ height: "100%" }}>
        <Space style={{ marginBottom: 8, width: "100%" }}>
          <Select placeholder="选择国家" showSearch style={{ width: 120 }} size="small" value={cc || undefined} onChange={(v) => setCc(v || "")} options={[{ value: "US", label: "美国" }, { value: "GB", label: "英国" }, { value: "AU", label: "澳洲" }, { value: "CA", label: "加拿大" }, { value: "DE", label: "德国" }, { value: "FR", label: "法国" }, { value: "JP", label: "日本" }]} />
          <Button type="primary" size="small" icon={<SearchOutlined />} loading={hl} onClick={() => setQc(cc)}>查询</Button>
        </Space>
        <div style={{ maxHeight: 120, overflowY: "auto" }}>{(holidays || []).length > 0 ? (holidays || []).map((h) => (
          <div key={h.id} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #f5f5f5", fontSize: 12 }}>
            <Text style={{ fontSize: 12 }}>{new Date(h.holiday_date).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" })} {h.holiday_name}</Text>
            <Tag style={{ fontSize: 11, lineHeight: "18px", margin: 0 }}>{h.holiday_type}</Tag>
          </div>)) : <Text type="secondary" style={{ fontSize: 12 }}>选择国家查询节日信息</Text>}</div>
      </Card></Col>
    </Row>
    <Card>
      <Tabs activeKey={tab} onChange={(v) => { setTab(v); setPage(1); setSortField(""); setSortOrder(""); }} style={{ marginBottom: 0 }}
        items={[{ key: "claimed", label: "我的商家" }, { key: "available", label: "选取商家" }, { key: "violations", label: <span><WarningOutlined style={{ color: "#ff4d4f", marginRight: 4 }} />违规商家</span> }, { key: "recommendations", label: <span><StarOutlined style={{ color: "#52c41a", marginRight: 4 }} />推荐商家</span> }]}
        tabBarExtraContent={(tab === "claimed" || tab === "available") ? (<Space>
          <Select placeholder="平台" allowClear style={{ width: 120 }} size="small" value={platform || undefined} onChange={(v) => { setPlatform(v || ""); setPage(1); }} options={PLATFORMS.map((p) => ({ value: p.code, label: p.code }))} />
          {tab === "available" && <Select placeholder="标签筛选" allowClear style={{ width: 120 }} size="small" value={labelFilter || undefined} onChange={(v) => { setLabelFilter(v || ""); setPage(1); }} options={[{ value: "recommended", label: "推荐商家" }, { value: "violation", label: "违规商家" }, { value: "restricted", label: "限制投放" }, { value: "prohibited", label: "禁止投放" }]} />}
          <Input placeholder="搜索商家名/MID" prefix={<SearchOutlined />} style={{ width: 180 }} size="small" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onPressEnter={doSearch} />
          <Button type="primary" size="small" onClick={doSearch}>查询</Button>
          <Button size="small" icon={<SyncOutlined />} onClick={() => { setSearchInput(""); setSearch(""); setPlatform(""); setLabelFilter(""); setPage(1); setSortField(""); setSortOrder(""); }}>重置</Button>
          <Button size="small" type="dashed" icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={doSync}>同步商家库</Button>
        </Space>) : null} />
      {tab === "claimed" && <Table columns={claimedCols} dataSource={merchants} rowKey="id" loading={ml} onChange={handleTableChange} pagination={{ current: page, pageSize: 50, total, onChange: setPage, showTotal: (t: number) => `共 ${t} 条` }} scroll={{ x: 1000 }} size="small" />}
      {tab === "available" && <Table columns={availCols} dataSource={merchants} rowKey="id" loading={ml} onChange={handleTableChange} pagination={{ current: page, pageSize: 50, total, onChange: setPage, showTotal: (t: number) => `共 ${t} 条` }} scroll={{ x: 1100 }} size="small" />}
      {tab === "violations" && (<div><div style={{ marginBottom: 12 }}><Space><Input allowClear placeholder="搜索商家名" style={{ width: 240 }} prefix={<SearchOutlined />} value={vioSearch} onChange={(e) => setVioSearch(e.target.value)} onPressEnter={() => setVioPage(1)} /><Button type="primary" size="small" onClick={() => setVioPage(1)}>查询</Button></Space></div>
        <Table rowKey="id" loading={vl} dataSource={vioData?.items || []} size="small" scroll={{ x: 1000 }} pagination={{ current: vioPage, pageSize: 50, total: vioData?.total || 0, showTotal: (t: number) => `共 ${t} 条`, onChange: setVioPage }} columns={vioCols} /></div>)}
      {tab === "recommendations" && (<div><div style={{ marginBottom: 12 }}><Space><Input allowClear placeholder="搜索商家名" style={{ width: 240 }} prefix={<SearchOutlined />} value={recSearch} onChange={(e) => setRecSearch(e.target.value)} onPressEnter={() => setRecPage(1)} /><Button type="primary" size="small" onClick={() => setRecPage(1)}>查询</Button></Space></div>
        <Table rowKey="id" loading={rl} dataSource={recData?.items || []} size="small" scroll={{ x: 1000 }} pagination={{ current: recPage, pageSize: 50, total: recData?.total || 0, showTotal: (t: number) => `共 ${t} 条`, onChange: setRecPage }} columns={recCols} /></div>)}
    </Card>
    <Modal title={`领取商家: ${claimM?.merchant_name}`} open={claimModal} onOk={submitClaim} onCancel={() => setClaimModal(false)}>
      {claimM?.policy_status === "restricted" && (<div style={{ marginBottom: 16, padding: "8px 12px", background: "#fff7e6", border: "1px solid #ffd591", borderRadius: 6 }}><WarningOutlined style={{ color: "#fa8c16", marginRight: 6 }} /><Text type="warning" style={{ fontSize: 13 }}>该商家属于受限类别{claimM.policy_category_code ? `（${PN[claimM.policy_category_code] || claimM.policy_category_code}）` : ""}，投放将受限。</Text></div>)}
      <Form form={claimForm} layout="vertical">
        <Form.Item name="target_country" label="目标国家" rules={[{ required: true, message: "请选择目标国家" }]}>
          <Select
            showSearch
            placeholder="选择或输入国家代码（如 US / GB / AU）"
            optionFilterProp="label"
            options={(() => {
              const regions = claimM?.supported_regions;
              const codes = regions && Array.isArray(regions) ? regions.map((r) => typeof r === "string" ? r : (r as any).code || String(r)) : [];
              const allCountries = [
                { value: "US", label: "US - 美国" }, { value: "GB", label: "GB - 英国" }, { value: "AU", label: "AU - 澳洲" },
                { value: "CA", label: "CA - 加拿大" }, { value: "DE", label: "DE - 德国" }, { value: "FR", label: "FR - 法国" },
                { value: "JP", label: "JP - 日本" }, { value: "IT", label: "IT - 意大利" }, { value: "ES", label: "ES - 西班牙" },
                { value: "NL", label: "NL - 荷兰" }, { value: "BR", label: "BR - 巴西" }, { value: "MX", label: "MX - 墨西哥" },
                { value: "IN", label: "IN - 印度" }, { value: "KR", label: "KR - 韩国" }, { value: "SG", label: "SG - 新加坡" },
                { value: "NZ", label: "NZ - 新西兰" }, { value: "SE", label: "SE - 瑞典" }, { value: "NO", label: "NO - 挪威" },
                { value: "DK", label: "DK - 丹麦" }, { value: "FI", label: "FI - 芬兰" }, { value: "PL", label: "PL - 波兰" },
                { value: "AT", label: "AT - 奥地利" }, { value: "CH", label: "CH - 瑞士" }, { value: "BE", label: "BE - 比利时" },
                { value: "IE", label: "IE - 爱尔兰" }, { value: "PT", label: "PT - 葡萄牙" },
              ];
              // 把支持地区放在最前面并标记
              const supported = codes.map((c) => {
                const found = allCountries.find((a) => a.value === c);
                return { value: c, label: found ? `⭐ ${found.label}` : `⭐ ${c} - 支持地区` };
              });
              const rest = allCountries.filter((a) => !codes.includes(a.value));
              return [...supported, ...rest];
            })()}
          />
        </Form.Item>
        {claimM?.supported_regions && (<div style={{ marginBottom: 16 }}><Text type="secondary">支持地区（点击快速选择）：</Text><Space wrap style={{ marginTop: 4 }}>{(claimM.supported_regions as any[]).map((r) => { const c = typeof r === "string" ? r : r.code; return <Tag key={c} color="blue" style={{ cursor: "pointer" }} onClick={() => claimForm.setFieldValue("target_country", c)}>{c}</Tag>; })}</Space></div>)}
        {platformConns.length > 1 && (
          <Form.Item name="platform_connection_id" label="使用账号" rules={[{ required: true, message: "请选择使用的平台账号" }]}>
            <Select placeholder="选择平台账号" options={platformConns.map((c) => ({ value: c.id, label: `${c.account_name || c.platform} (${c.platform})` }))} />
          </Form.Item>
        )}
        <Form.Item name="holiday_name" label="关联节日（可选）"><Input placeholder="输入节日名称" /></Form.Item>
      </Form>
    </Modal>
    <Modal title={rTitle} open={rModal} onCancel={() => setRModal(false)} footer={null} width={480}><div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, padding: "8px 0" }}>{rContent}</div></Modal>
    <Modal title={`在投详情 — ${advMerchant?.merchant_name || ""}`} open={advModal} onCancel={() => setAdvModal(false)} footer={null} width={720}>
      {advList.length > 0 && (<div style={{ marginBottom: 12, display: "flex", gap: 24 }}>
        <div><Text type="secondary">总花费（本月）</Text><div style={{ fontSize: 20, fontWeight: 700 }}>${advList.reduce((s, r) => s + parseFloat(r.total_cost || "0"), 0).toFixed(2)}</div></div>
        <div><Text type="secondary">总佣金（本月）</Text><div style={{ fontSize: 20, fontWeight: 700, color: "#52c41a" }}>${advList.reduce((s, r) => s + parseFloat(r.monthly_commission || "0"), 0).toFixed(2)}</div></div>
        <div><Text type="secondary">平均 ROI</Text><div style={{ fontSize: 20, fontWeight: 700 }}>{(() => { const c = advList.reduce((s, r) => s + parseFloat(r.total_cost || "0"), 0); const m = advList.reduce((s, r) => s + parseFloat(r.monthly_commission || "0"), 0); return c > 0 ? (m / c).toFixed(2) : "0.00"; })()}</div></div>
      </div>)}
      <Table dataSource={advList} rowKey="user_id" loading={advLoading} size="small" pagination={false} columns={[
        { title: "员工", dataIndex: "display_name", width: 100 },
        { title: "广告系列", dataIndex: "campaign_count", width: 80, align: "center" as const },
        { title: "启用", dataIndex: "enabled_count", width: 60, align: "center" as const, render: (v: number) => <Tag color="green">{v}</Tag> },
        { title: "总花费", dataIndex: "total_cost", width: 100, align: "right" as const, render: (v: string) => `$${v}` },
        { title: "总点击", dataIndex: "total_clicks", width: 80, align: "right" as const, render: (v: number) => (v || 0).toLocaleString() },
        { title: "总展示", dataIndex: "total_impressions", width: 80, align: "right" as const, render: (v: number) => (v || 0).toLocaleString() },
        { title: "本月佣金", dataIndex: "monthly_commission", width: 100, align: "right" as const, render: (v: string) => <span style={{ color: "#52c41a", fontWeight: 600 }}>${v}</span> },
        { title: "ROI", dataIndex: "roi", width: 70, align: "right" as const },
      ]} />
    </Modal>
  </div>);
}
