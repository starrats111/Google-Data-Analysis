"use client";
import { useState, useCallback, useMemo, useEffect } from "react";
import { Card, Row, Col, Table, Input, Select, Button, Space, Tag, Modal, Form, Typography, Popconfirm, Switch, InputNumber, Tabs, App, Tooltip } from "antd";
import { ShopOutlined, SearchOutlined, CheckOutlined, DollarOutlined, CalendarOutlined, SaveOutlined, SyncOutlined, WarningOutlined, StarOutlined, CopyOutlined, ReloadOutlined, RobotOutlined, DeleteOutlined } from "@ant-design/icons";
import { PLATFORMS, BIDDING_STRATEGIES } from "@/lib/constants";
import { useApiWithParams, useStaleApi, useApi, mutateApi, refreshApi } from "@/lib/swr";
import { useRouter } from "next/navigation";
import { normalizeAiRuleProfile, SYSTEM_ADRIAN_PERSONA, type AiRuleProfile, type AiPersona } from "@/lib/ai-rule-profile";
const { Text } = Typography;
const { TextArea } = Input;

interface AdSettingsApiData {
  bidding_strategy: string;
  ecpc_enabled: number;
  max_cpc: string;
  daily_budget: string;
  network_search: number;
  network_partners: number;
  network_display: number;
  naming_rule: string;
  naming_prefix: string;
  eu_political_ad?: number;
  ai_rule_profile?: Record<string, unknown>;
}
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
const CommissionCell = ({ v }: { v: string | null }) => {
  if (!v) return <span style={{ color: "#bfbfbf" }}>-</span>;
  return <span>{v}</span>;
};
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
  logo_url?: string | null;
}
function getFaviconUrl(merchantUrl: string | null | undefined): string | null {
  if (!merchantUrl) return null;
  try {
    const domain = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  } catch { return null; }
}
function MerchantIcon({ rec }: { rec: Merchant }) {
  const [failed, setFailed] = useState(false);
  const iconUrl = getFaviconUrl(rec.merchant_url);
  if (iconUrl && !failed) {
    return <img src={iconUrl} alt="" style={{ width: 22, height: 22, borderRadius: 4, objectFit: "contain", flexShrink: 0 }} onError={() => setFailed(true)} />;
  }
  return <ShopOutlined style={{ fontSize: 18, color: "#bfbfbf", flexShrink: 0 }} />;
}
function MerchantNameCell({ rec, onCopy }: { rec: Merchant; onCopy: (link: string) => void }) {
  const copyLink = rec.campaign_link || rec.tracking_link;
  return (
    <Space size={6}>
      <MerchantIcon rec={rec} />
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
  const { data: authData } = useApi<{ role: string; userId: string }>("/api/auth/me?role=user", {
    dedupingInterval: 60000,
    revalidateOnFocus: false,
  });
  const isLeader = authData?.role === "leader";
  const [tab, setTab] = useState("claimed");
  const [platform, setPlatform] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState("");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc" | "">("");
  const mp = useMemo(() => ({ tab, page, pageSize: 50, ...(platform ? { platform } : {}), ...(search ? { search } : {}), ...(labelFilter ? { label: labelFilter } : {}), ...(sortField ? { sortField, sortOrder } : {}) }), [tab, platform, search, labelFilter, page, sortField, sortOrder]);
  const { data: md, isLoading: ml } = useApiWithParams<MerchantResponse>((tab === "claimed" || tab === "available") ? "/api/user/merchants" : null, mp, { keepPreviousData: false });
  const merchants = md?.merchants || [];
  const total = md?.total || 0;
  const stats = md?.stats || { total: 0, claimed: 0, byPlatform: [] };
  const { data: adData } = useStaleApi<AdSettingsApiData>("/api/user/ad-settings");
  const [adForm] = Form.useForm();
  useEffect(() => {
    if (!adData) return;
    // 解析 v2 人设 profile
    setPersonaProfile(normalizeAiRuleProfile(adData.ai_rule_profile));
    const profile = adData.ai_rule_profile;
    const toTagList = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
      if (typeof v === "string") {
        return v.split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
      }
      return [];
    };
    const ai = profile && typeof profile === "object"
      ? {
        ...profile,
        preferred_terms: toTagList(profile.preferred_terms),
        forbidden_terms: toTagList(profile.forbidden_terms),
      }
      : undefined;
    adForm.setFieldsValue({
      ...adData,
      max_cpc: Number(adData.max_cpc),
      daily_budget: Number(adData.daily_budget),
      ...(ai ? { ai_rule_profile: ai } : {}),
    });
  }, [adData, adForm]);
  const [vioSearch, setVioSearch] = useState(""); const [vioPage, setVioPage] = useState(1);
  const [recSearch, setRecSearch] = useState(""); const [recPage, setRecPage] = useState(1);
  const { data: vioData, isLoading: vl, error: vioError, mutate: vioMutate } = useApiWithParams<{ items: any[]; total: number }>(tab === "violations" ? "/api/user/merchants/sheet-sync" : null, { type: "violation", page: vioPage, pageSize: 50, ...(vioSearch ? { search: vioSearch } : {}) });
  const { data: recData, isLoading: rl, error: recError, mutate: recMutate } = useApiWithParams<{ items: any[]; total: number }>(tab === "recommendations" ? "/api/user/merchants/sheet-sync" : null, { type: "recommendation", page: recPage, pageSize: 50, ...(recSearch ? { search: recSearch } : {}) });
  const [cc, setCc] = useState(""); const [qc, setQc] = useState("");
  const { data: holidays, isLoading: hl } = useApiWithParams<Holiday[]>(qc ? "/api/user/holidays" : null, { country: qc });
  const [claimModal, setClaimModal] = useState(false); const [claimM, setClaimM] = useState<Merchant | null>(null); const [claimForm] = Form.useForm();
  const [platformConns, setPlatformConns] = useState<{ id: string; platform: string; account_name: string }[]>([]);
  const [mccAccounts, setMccAccounts] = useState<{ id: string; mcc_id: string; mcc_name: string }[]>([]);
  const [rModal, setRModal] = useState(false); const [rTitle, setRTitle] = useState(""); const [rContent, setRContent] = useState("");
  const [aiModalOpen, setAiModalOpen] = useState(false);
  // 人设库管理
  const [personaProfile, setPersonaProfile] = useState<AiRuleProfile | null>(null);
  const [personaTab, setPersonaTab] = useState<"library" | "new">("library");
  const [newPersonaName, setNewPersonaName] = useState("");
  const [newPersonaTags, setNewPersonaTags] = useState<string[]>([]);
  const [newPersonaDesc, setNewPersonaDesc] = useState("");
  const [newPersonaPrompt, setNewPersonaPrompt] = useState("");
  const [savingPersona, setSavingPersona] = useState(false);
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

  const savePersonaProfile = useCallback(async (updatedProfile: AiRuleProfile) => {
    setSavingPersona(true);
    const formData = adForm.getFieldsValue();
    const r = await mutateApi("/api/user/ad-settings", { method: "PUT", body: { ...formData, ai_rule_profile: updatedProfile } }, ["/api/user/ad-settings"]);
    setSavingPersona(false);
    if (r.code === 0) { message.success("人设已保存"); setPersonaProfile(updatedProfile); return true; }
    else { message.error(r.message); return false; }
  }, [adForm, message]);

  const activatePersona = useCallback(async (personaId: string) => {
    if (!personaProfile) return;
    const updated: AiRuleProfile = { ...personaProfile, active_persona_id: personaId };
    await savePersonaProfile(updated);
  }, [personaProfile, savePersonaProfile]);

  const deletePersona = useCallback(async (personaId: string) => {
    if (!personaProfile) return;
    const updated: AiRuleProfile = {
      ...personaProfile,
      personas: personaProfile.personas.filter((p) => p.id !== personaId),
      active_persona_id: personaProfile.active_persona_id === personaId ? "system_adrian" : personaProfile.active_persona_id,
    };
    await savePersonaProfile(updated);
  }, [personaProfile, savePersonaProfile]);

  const createPersona = useCallback(async () => {
    if (!newPersonaName.trim()) { message.error("请输入人设名称"); return; }
    if (!personaProfile) return;
    const newPersona: AiPersona = {
      id: `custom_${Date.now()}`,
      name: newPersonaName.trim(),
      tags: newPersonaTags,
      description: newPersonaDesc.trim() || newPersonaName.trim(),
      is_system: false,
      prompt_text: newPersonaPrompt.trim() || SYSTEM_ADRIAN_PERSONA.prompt_text,
      persona: newPersonaDesc.trim() || newPersonaName.trim(),
      keyword_requirements: SYSTEM_ADRIAN_PERSONA.keyword_requirements,
      ad_copy_requirements: SYSTEM_ADRIAN_PERSONA.ad_copy_requirements,
      sitelink_requirements: SYSTEM_ADRIAN_PERSONA.sitelink_requirements,
      compliance_requirements: SYSTEM_ADRIAN_PERSONA.compliance_requirements,
      hard_rules: SYSTEM_ADRIAN_PERSONA.hard_rules,
      forbidden_terms: [],
      preferred_terms: [],
      enforce_policy_check: true,
    };
    const updated: AiRuleProfile = {
      ...personaProfile,
      personas: [...personaProfile.personas, newPersona],
      active_persona_id: newPersona.id,
    };
    const ok = await savePersonaProfile(updated);
    if (ok) { setNewPersonaName(""); setNewPersonaTags([]); setNewPersonaDesc(""); setNewPersonaPrompt(""); setPersonaTab("library"); }
  }, [personaProfile, newPersonaName, newPersonaTags, newPersonaDesc, newPersonaPrompt, savePersonaProfile, message]);
  const doClaim = useCallback(async (m: Merchant) => {
    setClaimM(m); claimForm.resetFields(); setClaimModal(true);
    try {
      const [platRes, mccRes] = await Promise.all([
        fetch("/api/user/settings/platforms").then((r) => r.json()),
        fetch("/api/user/settings/mcc").then((r) => r.json()),
      ]);
      if (platRes.code === 0) {
        const conns = (platRes.data || []).filter((c: any) => c.platform === m.platform);
        setPlatformConns(conns);
        if (conns.length === 1) claimForm.setFieldValue("platform_connection_id", conns[0].id);
      }
      if (mccRes.code === 0) {
        const mccs = (mccRes.data || []).filter((a: any) => a.is_active);
        setMccAccounts(mccs);
        if (mccs.length === 1) claimForm.setFieldValue("mcc_account_id", mccs[0].id);
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
    { title: "佣金率", dataIndex: "commission_rate", width: 110, sorter: true, sortOrder: colSortOrder("commission_rate"), render: (v: string | null) => <CommissionCell v={v} /> },
    { title: "支持地区", dataIndex: "supported_regions", width: 150, render: (v: unknown[] | null) => <RB r={v} /> },
    { title: "状态", dataIndex: "ad_status", width: 90, render: (v: string) => v === "ENABLED" ? <Tag color="green">已启用</Tag> : v === "PAUSED" ? <Tag color="orange">已暂停</Tag> : v === "NOT_SUBMITTED" ? <Tag color="blue">已领取</Tag> : <Tag>未知</Tag> },
    { title: "在投人数", dataIndex: "active_advertisers", width: 90, align: "center" as const, render: (v: number, rec: Merchant) => { const n = v || 0; return n > 0 ? <Button size="small" type="link" style={{ padding: 0, fontWeight: 600 }} onClick={() => showActiveAdv(rec)}>{n} 人</Button> : <span style={{ color: "#bfbfbf" }}>0</span>; } },
    { title: "标签", width: 120, render: (_: unknown, rec: any) => { const labels = rec.labels || []; if (labels.length === 0) return <span style={{ color: "#ccc" }}>-</span>; return <Space size={4} wrap>{labels.map((l: any, i: number) => <Tooltip key={i} title={l.detail}><Tag color={l.color} style={{ cursor: "pointer" }}>{l.text}</Tag></Tooltip>)}</Space>; } },
    { title: "操作", width: 100, render: (_: unknown, rec: Merchant) => <Popconfirm title="确认取消领取？" onConfirm={() => doRelease(rec.id)}><Button size="small" danger>取消领取</Button></Popconfirm> },
  ], [doRelease, showActiveAdv, copyLink, sortField, sortOrder]);
  const availCols = useMemo(() => [
    { title: "商家名称", dataIndex: "merchant_name", width: 240, sorter: true, sortOrder: colSortOrder("merchant_name"), render: (_: string, rec: Merchant) => <MerchantNameCell rec={rec} onCopy={copyLink} /> },
    { title: "平台", dataIndex: "platform", width: 80, render: (v: string) => <Tag color={PC[v] || "default"} style={{ fontWeight: 600 }}>{v}</Tag> },
    { title: "MID", dataIndex: "merchant_id", width: 100, ellipsis: true },
    { title: "主营业务", dataIndex: "category", width: 130, ellipsis: true, render: (v: string | null) => catCn(v) },
    { title: "佣金率", dataIndex: "commission_rate", width: 110, sorter: true, sortOrder: colSortOrder("commission_rate"), render: (v: string | null) => <CommissionCell v={v} /> },
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
    { title: "商家名称", dataIndex: "merchant_name", width: 180, ellipsis: true,
      render: (v: string, rec: any) => (
        <Space size={4}>
          {rec.website ? (
            <a href={rec.website.startsWith("http") ? rec.website : `https://${rec.website}`} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>{v}</a>
          ) : <span style={{ fontWeight: 600 }}>{v}</span>}
        </Space>
      ),
    },
    { title: "联盟平台", dataIndex: "affiliate", width: 100,
      render: (v: string, rec: any) => rec.source === "excel" ? (v ? <Tag color="blue">{v}</Tag> : "-") : (rec.roi_reference || "-"),
    },
    { title: "商家地区", dataIndex: "merchant_base", width: 80,
      render: (v: string, rec: any) => rec.source === "excel" ? (v ? <Tag>{v}</Tag> : "-") : (rec.settlement_info || "-"),
    },
    { title: "EPC", dataIndex: "epc", width: 80, align: "right" as const,
      render: (v: number | null, rec: any) => rec.source === "excel" ? (v != null ? `$${Number(v).toFixed(2)}` : "-") : (rec.commission_info || "-"),
    },
    { title: "平均佣金率", dataIndex: "avg_commission_rate", width: 100, align: "right" as const,
      render: (v: number | null, rec: any) => {
        if (rec.source !== "excel") return rec.share_time || "-";
        if (v == null) return "-";
        const n = Number(v);
        // 如果大于 1 说明是固定金额而非百分比
        return n > 1 ? `$${n.toFixed(2)}` : `${(n * 100).toFixed(2)}%`;
      },
    },
    { title: "带单佣金", dataIndex: "avg_order_commission", width: 90, align: "right" as const,
      render: (v: number | null, rec: any) => rec.source === "excel" ? (v != null ? `$${Number(v).toFixed(2)}` : "-") : "-",
    },
    { title: "佣金上限", dataIndex: "commission_cap", width: 110, ellipsis: true,
      render: (v: string | null, rec: any) => rec.source === "excel" ? (v || "无限制") : (rec.remark ? <Button type="link" size="small" onClick={() => { setRTitle("推荐详情"); setRContent(rec.remark); setRModal(true); }}>查看</Button> : "-"),
    },
  ], []);
  return (<div style={{ maxWidth: 1600, margin: "0 auto" }}>
    <Form form={adForm} component={false} layout="vertical" size="small">
      <Row gutter={[20, 20]} align="stretch" style={{ marginBottom: 20 }}>
        <Col xs={24} sm={12} md={6}><Card size="small" className="stat-card-hero" title={<><ShopOutlined style={{ color: "#999", marginRight: 6 }} />我的商家</>} style={{ height: "100%" }}>
          <div style={{ fontSize: 36, fontWeight: 800, marginBottom: 4, lineHeight: 1.2 }}>{stats.total.toLocaleString()}</div>
          <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>平台分布</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{stats.byPlatform.map((p) => <Tag key={p.platform} color={PC[p.platform] || "default"} style={{ fontWeight: 600 }}>{p.platform} {p._count.toLocaleString()}</Tag>)}</div>
          <div style={{ marginTop: 12, fontSize: 12, color: "#999", borderTop: "1px solid #f0f0f0", paddingTop: 8 }}>在投广告 <span style={{ fontWeight: 700, color: "#333" }}>{stats.claimed}</span> 个商家</div>
        </Card></Col>
        <Col xs={24} sm={12} md={6}><Card size="small" className="func-card-ad" title={<><DollarOutlined style={{ color: "#999" }} /> 广告投放设置</>} extra={<Button type="primary" size="small" icon={<SaveOutlined />} onClick={saveAd}>保存</Button>} style={{ height: "100%" }}>
          {adData && (<div style={{ fontSize: 12 }}>
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
          </div>)}
        </Card></Col>
        <Col xs={24} sm={12} md={6}><Card size="small" className="func-card-holiday" title={<><CalendarOutlined style={{ color: "#999" }} /> 节日营销</>} style={{ height: "100%" }}>
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
        <Col xs={24} sm={12} md={6}><Card size="small" className="func-card-ai" title={<><RobotOutlined style={{ color: "#722ed1" }} /> AI 人设库</>} style={{ height: "100%" }}>
          {(() => {
            const activePersona = personaProfile
              ? (personaProfile.personas.find((p) => p.id === personaProfile.active_persona_id) ?? SYSTEM_ADRIAN_PERSONA)
              : SYSTEM_ADRIAN_PERSONA;
            const totalPersonas = personaProfile?.personas.length ?? 1;
            return (
              <div style={{ fontSize: 12 }}>
                <div style={{ background: "linear-gradient(135deg,#f5f0ff 0%,#ede9fe 100%)", borderRadius: 6, padding: "8px 10px", marginBottom: 10, border: "1px solid #d3adf7" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <Tag color="purple" style={{ fontSize: 10, margin: 0 }}>激活中</Tag>
                    <span style={{ fontWeight: 700, color: "#4a1d96", fontSize: 13, flex: 1 }}>{activePersona.name}</span>
                  </div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {activePersona.tags.slice(0, 3).map((t) => (
                      <Tag key={t} style={{ fontSize: 10, margin: 0, padding: "0 4px", background: "rgba(114,46,209,0.1)", border: "1px solid #d3adf7", color: "#722ed1" }}>{t}</Tag>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1, textAlign: "center" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#722ed1" }}>{totalPersonas}</div>
                    <Text type="secondary" style={{ fontSize: 11 }}>人设库</Text>
                  </div>
                  <div style={{ flex: 1, textAlign: "center" }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#52c41a" }}>{totalPersonas - 1}</div>
                    <Text type="secondary" style={{ fontSize: 11 }}>自建人设</Text>
                  </div>
                </div>
                <Button block icon={<RobotOutlined />} onClick={() => { setAiModalOpen(true); setPersonaTab("library"); }}>管理 AI 人设库</Button>
              </div>
            );
          })()}
        </Card></Col>
      </Row>
    </Form>
    <Card className="merchant-table-card">
      <Tabs activeKey={tab} onChange={(v) => { setTab(v); setPage(1); setSortField(""); setSortOrder(""); }} style={{ marginBottom: 0 }}
        items={[{ key: "claimed", label: "我的商家" }, { key: "available", label: "选取商家" }, { key: "violations", label: <span><WarningOutlined style={{ color: "#ff4d4f", marginRight: 4 }} />违规商家</span> }, { key: "recommendations", label: <span><StarOutlined style={{ color: "#52c41a", marginRight: 4 }} />推荐商家</span> }]} />
      {(tab === "claimed" || tab === "available") && (
        <div className="filter-bar">
          <Select placeholder="平台" allowClear style={{ width: 120 }} size="small" value={platform || undefined} onChange={(v) => { setPlatform(v || ""); setPage(1); }} options={PLATFORMS.map((p) => ({ value: p.code, label: p.code }))} />
          {tab === "available" && <Select placeholder="标签筛选" allowClear style={{ width: 120 }} size="small" value={labelFilter || undefined} onChange={(v) => { setLabelFilter(v || ""); setPage(1); }} options={[{ value: "recommended", label: "推荐商家" }, { value: "violation", label: "违规商家" }, { value: "restricted", label: "限制投放" }, { value: "prohibited", label: "禁止投放" }]} />}
          <Input placeholder="搜索商家名/MID" prefix={<SearchOutlined />} style={{ width: 200 }} size="small" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onPressEnter={doSearch} />
          <Button type="primary" size="small" icon={<SearchOutlined />} onClick={doSearch}>查询</Button>
          <Button size="small" icon={<SyncOutlined />} onClick={() => { setSearchInput(""); setSearch(""); setPlatform(""); setLabelFilter(""); setPage(1); setSortField(""); setSortOrder(""); }}>重置</Button>
          <div style={{ flex: 1 }} />
          <Button size="small" type="dashed" icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={doSync}>同步商家库</Button>
        </div>
      )}
      {tab === "claimed" && <Table columns={claimedCols} dataSource={merchants} rowKey="id" loading={ml} onChange={handleTableChange} pagination={{ current: page, pageSize: 50, total, onChange: setPage, showTotal: (t: number) => `共 ${t} 条` }} scroll={{ x: 1000 }} size="small" />}
      {tab === "available" && <Table columns={availCols} dataSource={merchants} rowKey="id" loading={ml} onChange={handleTableChange} pagination={{ current: page, pageSize: 50, total, onChange: setPage, showTotal: (t: number) => `共 ${t} 条` }} scroll={{ x: 1100 }} size="small" />}
      {tab === "violations" && (<div>
        {vioError && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#fff2f0", border: "1px solid #ffccc7", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span><WarningOutlined style={{ color: "#ff4d4f", marginRight: 6 }} />加载违规商家失败：{vioError.message || "请求异常"}</span>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => vioMutate()}>重试</Button>
        </div>}
        <div className="filter-bar"><Input allowClear placeholder="搜索商家名" style={{ width: 240 }} prefix={<SearchOutlined />} size="small" value={vioSearch} onChange={(e) => setVioSearch(e.target.value)} onPressEnter={() => setVioPage(1)} /><Button type="primary" size="small" icon={<SearchOutlined />} onClick={() => setVioPage(1)}>查询</Button><Button size="small" icon={<ReloadOutlined />} onClick={() => vioMutate()}>刷新</Button></div>
        <Table rowKey="id" loading={vl} dataSource={vioData?.items || []} size="small" scroll={{ x: 1000 }} pagination={{ current: vioPage, pageSize: 50, total: vioData?.total || 0, showTotal: (t: number) => `共 ${t} 条`, onChange: setVioPage }} columns={vioCols} /></div>)}
      {tab === "recommendations" && (<div>
        {recError && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#fff2f0", border: "1px solid #ffccc7", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span><WarningOutlined style={{ color: "#ff4d4f", marginRight: 6 }} />加载推荐商家失败：{recError.message || "请求异常"}</span>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => recMutate()}>重试</Button>
        </div>}
        <div className="filter-bar"><Input allowClear placeholder="搜索商家名" style={{ width: 240 }} prefix={<SearchOutlined />} size="small" value={recSearch} onChange={(e) => setRecSearch(e.target.value)} onPressEnter={() => setRecPage(1)} /><Button type="primary" size="small" icon={<SearchOutlined />} onClick={() => setRecPage(1)}>查询</Button><Button size="small" icon={<ReloadOutlined />} onClick={() => recMutate()}>刷新</Button></div>
        <Table rowKey="id" loading={rl} dataSource={recData?.items || []} size="small" scroll={{ x: 1000 }} pagination={{ current: recPage, pageSize: 50, total: recData?.total || 0, showTotal: (t: number) => `共 ${t} 条`, onChange: setRecPage }} columns={recCols} /></div>)}
    </Card>
    <Modal title={`领取商家: ${claimM?.merchant_name}`} open={claimModal} onOk={submitClaim} onCancel={() => setClaimModal(false)}>
      {claimM?.policy_status === "restricted" && (<div style={{ marginBottom: 16, padding: "8px 12px", background: "#fff7e6", border: "1px solid #ffd591", borderRadius: 6 }}><WarningOutlined style={{ color: "#fa8c16", marginRight: 6 }} /><Text type="warning" style={{ fontSize: 13 }}>该商家属于受限类别{claimM.policy_category_code ? `（${PN[claimM.policy_category_code] || claimM.policy_category_code}）` : ""}，投放将受限。</Text></div>)}
      <Form form={claimForm} layout="vertical">
        {mccAccounts.length > 1 && (
          <Form.Item name="mcc_account_id" label="MCC 账户" rules={[{ required: true, message: "请选择 MCC 账户" }]}>
            <Select placeholder="选择 MCC 账户" options={mccAccounts.map((a) => ({ value: a.id, label: `${a.mcc_name || a.mcc_id} (${a.mcc_id})` }))} />
          </Form.Item>
        )}
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
    <Modal
      title={<><RobotOutlined style={{ color: "#722ed1", marginRight: 8 }} />AI 人设库管理</>}
      open={aiModalOpen}
      onCancel={() => setAiModalOpen(false)}
      width={600}
      footer={null}
    >
      <Tabs
        activeKey={personaTab}
        onChange={(k) => setPersonaTab(k as "library" | "new")}
        items={[
          { key: "library", label: "人设库" },
          { key: "new", label: "+ 新建人设" },
        ]}
      />

      {personaTab === "library" && personaProfile && (
        <div style={{ maxHeight: 480, overflowY: "auto", paddingRight: 4 }}>
          {personaProfile.personas.map((p) => {
            const isActive = p.id === personaProfile.active_persona_id;
            return (
              <Card
                key={p.id}
                size="small"
                style={{
                  marginBottom: 10,
                  border: isActive ? "2px solid #722ed1" : "1px solid #f0f0f0",
                  background: isActive ? "linear-gradient(135deg,#faf5ff 0%,#f5f0ff 100%)" : "#fafafa",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                      <Text strong style={{ color: isActive ? "#4a1d96" : undefined }}>{p.name}</Text>
                      {p.is_system && <Tag color="purple" style={{ fontSize: 10, margin: 0 }}>系统内置</Tag>}
                      {isActive && <Tag color="green" style={{ fontSize: 10, margin: 0 }}>✓ 激活中</Tag>}
                    </div>
                    {p.description && (
                      <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>{p.description}</Text>
                    )}
                    <Space wrap size={4}>
                      {p.tags.map((t) => (
                        <Tag key={t} style={{ fontSize: 11, margin: 0, padding: "0 4px", background: "rgba(114,46,209,0.08)", border: "1px solid #d3adf7", color: "#722ed1" }}>{t}</Tag>
                      ))}
                    </Space>
                    {p.prompt_text && p.id !== "system_adrian" && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#888", background: "#f9f9f9", borderRadius: 4, padding: "4px 8px", maxHeight: 60, overflow: "hidden", lineClamp: 3 }}>
                        {p.prompt_text.slice(0, 120)}{p.prompt_text.length > 120 ? "..." : ""}
                      </div>
                    )}
                  </div>
                  <Space direction="vertical" size={4} style={{ flexShrink: 0 }}>
                    {!isActive && (
                      <Button
                        size="small" type="primary" ghost
                        loading={savingPersona}
                        onClick={() => activatePersona(p.id)}
                      >
                        激活
                      </Button>
                    )}
                    {!p.is_system && (
                      <Popconfirm
                        title={`确认删除「${p.name}」？`}
                        onConfirm={() => deletePersona(p.id)}
                        okText="删除"
                        okButtonProps={{ danger: true }}
                        cancelText="取消"
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    )}
                  </Space>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {personaTab === "new" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Text strong style={{ display: "block", marginBottom: 4 }}>人设名称 <Text type="danger">*</Text></Text>
            <Input
              value={newPersonaName}
              onChange={(e) => setNewPersonaName(e.target.value)}
              placeholder="例：激进增长派、保守稳健型"
              maxLength={30}
              showCount
            />
          </div>
          <div>
            <Text strong style={{ display: "block", marginBottom: 4 }}>特征标签</Text>
            <Select
              mode="tags"
              value={newPersonaTags}
              onChange={setNewPersonaTags}
              placeholder="输入后回车添加，如：高预算激进、品牌优先"
              tokenSeparators={[","]}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <Text strong style={{ display: "block", marginBottom: 4 }}>人设描述</Text>
            <Input
              value={newPersonaDesc}
              onChange={(e) => setNewPersonaDesc(e.target.value)}
              placeholder="简要描述这个人设的定位和风格"
              maxLength={80}
              showCount
            />
          </div>
          <div>
            <Text strong style={{ display: "block", marginBottom: 4 }}>核心提示词 <Text type="secondary" style={{ fontSize: 12 }}>（不填则继承 Adrian 策略）</Text></Text>
            <TextArea
              value={newPersonaPrompt}
              onChange={(e) => setNewPersonaPrompt(e.target.value)}
              placeholder={`例：你是一位注重品牌形象的 Google Ads 专家，侧重高端定位和品牌词保护。关键词策略：精确匹配为主，不投 Broad Match...`}
              rows={5}
              maxLength={2000}
              showCount
            />
          </div>
          <Button
            type="primary"
            icon={<RobotOutlined />}
            loading={savingPersona}
            onClick={createPersona}
            block
            style={{ background: "#722ed1", borderColor: "#722ed1" }}
          >
            创建并激活此人设
          </Button>
        </div>
      )}
    </Modal>
    <Modal title={`在投详情 — ${advMerchant?.merchant_name || ""}`} open={advModal} onCancel={() => setAdvModal(false)} footer={null} width={isLeader ? 860 : 560}>
      {isLeader && advList.length > 0 && (<div style={{ marginBottom: 12, display: "flex", gap: 24 }}>
        <div><Text type="secondary">总花费（本月）</Text><div style={{ fontSize: 20, fontWeight: 700 }}>${advList.reduce((s, r) => s + parseFloat(r.total_cost || "0"), 0).toFixed(2)}</div></div>
        <div><Text type="secondary">总佣金（本月）</Text><div style={{ fontSize: 20, fontWeight: 700, color: "#52c41a" }}>${advList.reduce((s, r) => s + parseFloat(r.monthly_commission || "0"), 0).toFixed(2)}</div></div>
        <div><Text type="secondary">平均 ROI</Text><div style={{ fontSize: 20, fontWeight: 700 }}>{(() => { const c = advList.reduce((s, r) => s + parseFloat(r.total_cost || "0"), 0); const m = advList.reduce((s, r) => s + parseFloat(r.monthly_commission || "0"), 0); return c > 0 ? (m / c).toFixed(2) : "0.00"; })()}</div></div>
      </div>)}
      {!isLeader && advList.length > 0 && (<div style={{ marginBottom: 12, display: "flex", gap: 24 }}>
        <div><Text type="secondary">总花费（本月）</Text><div style={{ fontSize: 20, fontWeight: 700 }}>${advList.reduce((s, r) => s + parseFloat(r.total_cost || "0"), 0).toFixed(2)}</div></div>
        <div><Text type="secondary">广告系列数</Text><div style={{ fontSize: 20, fontWeight: 700 }}>{advList.reduce((s, r) => s + (r.campaign_count || 0), 0)}</div></div>
      </div>)}
      <Table dataSource={advList} rowKey="user_id" loading={advLoading} size="small" pagination={false} columns={isLeader ? [
        { title: "员工", dataIndex: "display_name", width: 100 },
        { title: "广告系列", dataIndex: "campaign_count", width: 80, align: "center" as const },
        { title: "启用", dataIndex: "enabled_count", width: 60, align: "center" as const, render: (v: number) => <Tag color="green">{v}</Tag> },
        { title: "投放日期", dataIndex: "campaign_created_at", width: 110, render: (v: string) => v ? new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-" },
        { title: "总花费", dataIndex: "total_cost", width: 90, align: "right" as const, render: (v: string) => `$${v}` },
        { title: "总点击", dataIndex: "total_clicks", width: 80, align: "right" as const, render: (v: number) => (v || 0).toLocaleString() },
        { title: "本月佣金", dataIndex: "monthly_commission", width: 100, align: "right" as const, render: (v: string) => <span style={{ color: "#52c41a", fontWeight: 600 }}>${v}</span> },
        { title: "ROI", dataIndex: "roi", width: 70, align: "right" as const },
      ] : [
        { title: "广告系列", dataIndex: "campaign_count", width: 80, align: "center" as const },
        { title: "启用", dataIndex: "enabled_count", width: 60, align: "center" as const, render: (v: number) => <Tag color="green">{v}</Tag> },
        { title: "总花费（本月）", dataIndex: "total_cost", width: 120, align: "right" as const, render: (v: string) => `$${v}` },
        { title: "总点击", dataIndex: "total_clicks", width: 80, align: "right" as const, render: (v: number) => (v || 0).toLocaleString() },
        { title: "总展示", dataIndex: "total_impressions", width: 90, align: "right" as const, render: (v: number) => (v || 0).toLocaleString() },
      ]} />
    </Modal>
  </div>);
}
