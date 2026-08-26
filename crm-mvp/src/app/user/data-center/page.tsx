"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { globalMutate } from "@/lib/swr";
import {
  Card, Table, Row, Col, Statistic, Select, Space, Typography, Tag, Button,
  DatePicker, Tooltip, App, Input, Modal, Tabs, Form, InputNumber, Alert,
} from "antd";
import {
  RiseOutlined, FallOutlined, SyncOutlined,
  CloudDownloadOutlined, EditOutlined, SearchOutlined,
  PlayCircleOutlined, PauseCircleOutlined, RedoOutlined, PlusOutlined,
  TableOutlined, WarningOutlined, EyeOutlined, RobotOutlined,
} from "@ant-design/icons";
import AppPageHeader from "@/components/AppPageHeader";
import type { ColumnsType } from "antd/es/table";
import { PLATFORMS } from "@/lib/constants";
import { TXN_TZ_NOTE } from "@/lib/report-metrics";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import EditCampaignModal from "@/components/data-center/EditCampaignModal";
import CampaignAnalysisModal, {
  STRATEGY_OPTIONS, formatActionItem, actionColor, type AnalysisItem,
} from "@/components/data-center/CampaignAnalysisModal";
import {
  buildMetricColumns, useTableColumnPrefs, ColumnSettingsButton, renderColumnSummary,
  METRIC_COLUMN_LABELS, type ColumnMetaItem, type TableSummaryTotals,
} from "@/components/data-center/tableColumnPrefs";
import { useStaleApi, useApiWithParams, refreshApi } from "@/lib/swr";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

// D-239：scroll.x 不再是常量，按当前可见列宽度动态求和（见组件内 tableScrollX），
// 否则隐藏列后固定列（广告系列）会与表体错位。

const { Text } = Typography;

// ========== D-239 自定义列展示：列注册表 ==========
/** 后端 user_table_preferences 的 table_key */
const COLUMN_PREFS_TABLE_KEY = "data-center-campaigns";
/** 固定列：不可隐藏，始终排最前（07 于 2026-08-17 确认） */
const LOCKED_COLUMN_KEYS = ["campaign_name", "status"];
/** 员工未配置时的默认精简列（07 于 2026-08-17 确认） */
const DEFAULT_COLUMN_KEYS = ["campaign_name", "status", "cost", "commission", "net_profit", "roi"];
/** 全部可用列（列设置面板顺序 = 未勾选列的排列顺序） */
const COLUMNS_META: ColumnMetaItem[] = [
  { key: "campaign_name", label: "广告系列" },
  { key: "status", label: "状态" },
  { key: "customer_id", label: "CID" },
  { key: "daily_budget", label: "预算" },
  { key: "max_cpc", label: "最高出价" },
  { key: "is_budget", label: METRIC_COLUMN_LABELS.is_budget },
  { key: "is_rank", label: METRIC_COLUMN_LABELS.is_rank },
  { key: "impressions", label: METRIC_COLUMN_LABELS.impressions },
  { key: "clicks", label: METRIC_COLUMN_LABELS.clicks },
  { key: "orders", label: METRIC_COLUMN_LABELS.orders },
  { key: "cpc", label: METRIC_COLUMN_LABELS.cpc },
  { key: "epc", label: METRIC_COLUMN_LABELS.epc },
  { key: "cost_per_100_clicks", label: METRIC_COLUMN_LABELS.cost_per_100_clicks },
  { key: "cost", label: METRIC_COLUMN_LABELS.cost },
  { key: "cpa", label: METRIC_COLUMN_LABELS.cpa },
  { key: "commission", label: METRIC_COLUMN_LABELS.commission },
  { key: "aov", label: METRIC_COLUMN_LABELS.aov },
  { key: "rejected_commission", label: METRIC_COLUMN_LABELS.rejected_commission },
  { key: "net_profit", label: METRIC_COLUMN_LABELS.net_profit },
  { key: "profit_rate", label: METRIC_COLUMN_LABELS.profit_rate },
  { key: "roi", label: METRIC_COLUMN_LABELS.roi },
  { key: "cvr", label: METRIC_COLUMN_LABELS.cvr },
  { key: "ai_suggestion", label: "操作建议" },
  { key: "ai_detail", label: "分析" },
];
const ALL_COLUMN_KEYS = COLUMNS_META.map((m) => m.key);
const { RangePicker } = DatePicker;

interface MccAccount { id: string; mcc_id: string; mcc_name: string; currency: string; }

interface CampaignRow {
  id: string; google_campaign_id: string; customer_id: string; campaign_name: string;
  status: string;
  /** D-266 批一：已折美元；账户币种原值在 *_account（非美元 MCC 标注用） */
  daily_budget: number; max_cpc: number | null;
  daily_budget_account?: number; max_cpc_account?: number | null;
  cost: number; clicks: number; impressions: number; cpc: number;
  commission: number; rejected_commission: number; approved_commission: number; orders: number; roi: number;
  target_country: string; last_synced: string | null;
  mcc_currency?: string;
  /** D-248：所属 CID 被 Google 中止——ENABLED 显示「被中止」，全部锁操作 */
  is_removed?: boolean; cid_suspended?: boolean;
  /** D-238：IS 因预算/评级错失的展示份额（区间内最新一日，0-1 分数；未采集为 null） */
  is_budget?: number | null; is_rank?: number | null;
}

interface CostByMcc {
  mcc_db_id: string; mcc_id: string; mcc_name: string; currency: string;
  cost_usd: number; cost_original?: number; adjustment?: number;
}

interface Summary {
  totalCost: number;
  totalCommission: number;
  totalRejectedCommission: number;
  totalApprovedCommission: number;
  totalPaidCommission: number;
  totalPendingCommission: number;
  totalClicks: number;
  totalImpressions: number;
  totalOrders: number;
  avgCpc: number;
  roi: number;
  campaignCount: number;
  enabledCount: number;
  pausedCount: number;
  /** 今日投放数（今日新建且历史无同名系列，null=脚本缓存缺失） */
  todayAdsCount?: number | null;
  /** 是否已配置统一脚本（MCC sheet_url），false 时显示「脚本未同步」备注 */
  scriptConfigured?: boolean;
  /**
   * 佣金口径。D-176 引入 mcc，D-196 引入 filtered。
   * "filtered"=有筛选条件，仅当前可见行的归属佣金；
   * "mcc"=仅当前 MCC 广告系列归属佣金；
   * "all"=全账号全量佣金
   */
  commissionScope?: "filtered" | "mcc" | "all";
}

// formatInt / calcNetProfit / calcEpc 已抽到 tableColumnPrefs（D-239 与组员弹窗共用）

// CID 格式化: 1234567890 → 123-456-7890
function formatCid(cid: string | number): string {
  const s = String(cid).replace(/\D/g, "");
  if (s.length === 10) return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
  return s;
}

// 默认日期 — 本月（东八区）
const defaultStartDate = dayjs().tz(TZ).startOf("month");
const defaultEndDate = dayjs().tz(TZ);

export default function DataCenterPage() {
  const { message, modal } = App.useApp();
  const [selectedMcc, setSelectedMcc] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [platformFilter, setPlatformFilter] = useState<string>("");
  const [midFilter, setMidFilter] = useState<string>("");
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([defaultStartDate, defaultEndDate]);
  const [syncingTransactions, setSyncingTransactions] = useState(false);
  const [syncingMcc, setSyncingMcc] = useState(false);
  const [syncingFull, setSyncingFull] = useState(false);
  const [syncDialog, setSyncDialog] = useState<{ open: boolean; type: "transactions" | "mcc" | null }>({ open: false, type: null });
  const [syncForm] = Form.useForm<{ range: [Dayjs, Dayjs] }>();
  const [editModal, setEditModal] = useState<{ open: boolean; campaign: CampaignRow | null; field: "budget" | "max_cpc" }>({ open: false, campaign: null, field: "budget" });
  const [detailModal, setDetailModal] = useState(false);
  const [commissionModal, setCommissionModal] = useState(false);
  const [commissionByAccount, setCommissionByAccount] = useState<{
    account_name: string; platform: string; total_commission: number;
    approved_commission: number; paid_commission: number;
    rejected_commission: number; pending_commission: number; order_count: number; order_amount: number;
    /** 连接绑定（创建）日期；bound_after_range_start=true 表示该账号在查询区间中途才绑定，行内仅含绑定后的数据 */
    connection_created_at?: string | null; bound_after_range_start?: boolean;
  }[]>([]);
  const [commissionByMerchant, setCommissionByMerchant] = useState<{
    user_merchant_id: string; merchant_name: string; platform: string; total_commission: number;
    approved_commission: number; paid_commission: number;
    rejected_commission: number; pending_commission: number; order_count: number; order_amount: number;
  }[]>([]);
  const [commissionTab, setCommissionTab] = useState<"merchant" | "account">("merchant");
  const [loadingCommission, setLoadingCommission] = useState(false);
  const [adjModal, setAdjModal] = useState<{ open: boolean; mcc: CostByMcc | null }>({ open: false, mcc: null });
  const [adjAmount, setAdjAmount] = useState<number>(0);
  const [adjRemark, setAdjRemark] = useState("");
  const [adjSaving, setAdjSaving] = useState(false);

  // MCC 列表
  const { data: mccAccounts = [] } = useStaleApi<MccAccount[]>("/api/user/settings/mcc");

  // 构建查询参数 — 默认不传 mcc_account_id 则查所有
  const queryParams = useMemo(() => {
    const p: Record<string, string> = {
      date_start: dateRange[0].format("YYYY-MM-DD"),
      date_end: dateRange[1].format("YYYY-MM-DD"),
    };
    if (selectedMcc) p.mcc_account_id = selectedMcc;
    if (statusFilter !== "all") p.status = statusFilter;
    if (platformFilter) p.platform = platformFilter;
    if (midFilter) p.mid = midFilter;
    if (searchFilter) p.search = searchFilter;
    return p;
  }, [selectedMcc, dateRange, statusFilter, platformFilter, midFilter, searchFilter]);

  const { data: campaignData, isLoading } = useApiWithParams<{
    rows: CampaignRow[]; summary: Summary; costByMcc?: CostByMcc[];
    rowMeta?: { displayedCount: number; totalCount: number; isLimited: boolean };
  }>("/api/user/data-center/campaigns", queryParams);

  // 本地状态覆盖（toggle 后立即更新，不等 API 刷新）
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>({});

  const rows = useMemo(() => {
    // 提取广告系列名前缀里的数字序号，用于排序。
    // 非数字命名（如 "Campaign #1"、手动创建的测试 Campaign）返回 -1，排到该状态末尾，
    // 但仍然展示出来 —— 不能直接 filter 掉，否则用户视角会丢失这些花费 / 佣金不为零的 Campaign，
    // 而组长视角又能看到，造成"组长能看 wj08 看不到"的诡异现象。
    const extractSeq = (name: string | null | undefined): number => {
      if (!name) return -1;
      const head = name.split("-")[0] || "";
      const digits = head.replace(/^[a-zA-Z]+/, "");
      return /^\d+$/.test(digits) ? parseInt(digits, 10) : -1;
    };
    // D-040 v2 BUG-2 兜底：前端按 campaign id 去重防御（后端 dedupe + previous_gcids 已合并 cost，
    //                      此处只防御任何意外重复 row 被前端表格展示两次）
    const seenIds = new Set<string>();
    const deduped: IndexedRow[] = [];
    for (const r of (campaignData?.rows || [])) {
      const key = String(r.id);
      if (seenIds.has(key)) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[DataCenter] D-040 v2 detected duplicate row id=${key} name=${r.campaign_name}`);
        }
        continue;
      }
      seenIds.add(key);
      deduped.push(r);
    }
    return deduped
      .map((r: IndexedRow) => statusOverrides[r.id] ? { ...r, status: statusOverrides[r.id] } : r)
      .sort((a, b) => {
        if (a.status === "ENABLED" && b.status !== "ENABLED") return -1;
        if (a.status !== "ENABLED" && b.status === "ENABLED") return 1;
        const seqA = extractSeq(a.campaign_name);
        const seqB = extractSeq(b.campaign_name);
        // 非数字命名 (seq=-1) 排到末尾；数字命名按 DESC
        if (seqA === -1 && seqB !== -1) return 1;
        if (seqA !== -1 && seqB === -1) return -1;
        return seqB - seqA;
      });
  }, [campaignData?.rows, statusOverrides]);
  const costByMcc = campaignData?.costByMcc || [];
  const rowMeta = campaignData?.rowMeta;

  // 页面加载时自动从 Google Sheet（CampaignInfo）同步最新状态，零 Google Ads API 消耗
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current) return;
    syncedRef.current = true;
    fetch("/api/user/data-center/campaigns/refresh-status", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0 && res.data?.totalUpdated > 0) {
          refreshApi(/\/api\/user\/data-center/);
        }
      })
      .catch(() => {});
  }, []);

  // 交易数据轮询：每 60 秒检查版本戳，有变动时静默刷新交易相关数据
  const txnVersionRef = useRef<string>("");
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/user/data-center/txn-version").then((r) => r.json());
        if (res.code !== 0) return;
        const version: string = res.data?.version ?? "";
        if (!txnVersionRef.current) {
          // 首次初始化版本基线，不触发刷新
          txnVersionRef.current = version;
          return;
        }
        if (version !== txnVersionRef.current) {
          txnVersionRef.current = version;
          // 静默刷新数据中心所有 SWR 缓存（含 campaigns、settlement）
          globalMutate((key) => typeof key === "string" && key.startsWith("/api/user/data-center"), undefined, { revalidate: true });
        }
      } catch {
        // 网络异常静默忽略，不影响页面正常使用
      }
    };
    // 页面加载后 5s 首次执行（避免与 refresh-status 撞车）
    const init = setTimeout(poll, 5000);
    const timer = setInterval(poll, 60000);
    return () => { clearTimeout(init); clearInterval(timer); };
  }, []);

  // ========== D-285 弹窗二：预算异常确认 + 一键调整 ==========
  // 历史 bug 把「$2」发成账户币种 2（人民币 MCC 实际 ¥2≈$0.28 在跑）。后端只对
  // 已换新脚本的 MCC（库内预算=Google 真值）给出清单；确认才动 Google，当天可暂缓。
  interface BudgetFixRow {
    campaign_id: string; campaign_name: string; currency: string;
    current_account: number; current_usd: number; target_account: number; target_usd: number;
  }
  const [budgetFixRows, setBudgetFixRows] = useState<BudgetFixRow[]>([]);
  const [budgetFixOpen, setBudgetFixOpen] = useState(false);
  const [budgetFixApplying, setBudgetFixApplying] = useState(false);
  const budgetFixCheckedRef = useRef(false);
  useEffect(() => {
    if (budgetFixCheckedRef.current) return;
    budgetFixCheckedRef.current = true;
    const SNOOZE_KEY = "dc_budget_fix_snooze";
    const today = dayjs().tz(TZ).format("YYYY-MM-DD");
    try { if (localStorage.getItem(SNOOZE_KEY) === today) return; } catch { /* 隐私模式等取不到就照常弹 */ }
    fetch("/api/user/data-center/budget-fix")
      .then((r) => r.json())
      .then((res) => {
        const rows: BudgetFixRow[] = res?.data?.rows || [];
        if (res.code === 0 && rows.length > 0) {
          setBudgetFixRows(rows);
          setBudgetFixOpen(true);
        }
      })
      .catch(() => {});
  }, []);
  const snoozeBudgetFix = useCallback(() => {
    try { localStorage.setItem("dc_budget_fix_snooze", dayjs().tz(TZ).format("YYYY-MM-DD")); } catch { /* 存不上就下次再弹 */ }
    setBudgetFixOpen(false);
  }, []);
  const applyBudgetFix = useCallback(async () => {
    setBudgetFixApplying(true);
    try {
      const res = await fetch("/api/user/data-center/budget-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_ids: budgetFixRows.map((r) => r.campaign_id) }),
      }).then((r) => r.json());
      if (res.code === 0) {
        const { succeeded, failed, results } = res.data || {};
        if (failed > 0) {
          const firstErr = (results || []).find((x: { success: boolean }) => !x.success);
          message.warning(`已调整 ${succeeded} 条，失败 ${failed} 条${firstErr ? `（${firstErr.campaign_name}: ${firstErr.message}）` : ""}`);
        } else {
          message.success(`已调整 ${succeeded} 条系列的 Google 实际预算`);
        }
        setBudgetFixOpen(false);
        refreshApi(/\/api\/user\/data-center/);
      } else {
        message.error(res.message || "调整失败");
      }
    } catch (e) {
      message.error(`调整失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBudgetFixApplying(false);
    }
  }, [budgetFixRows, message]);
  const summary = campaignData?.summary || {
    totalCost: 0,
    totalCommission: 0,
    totalRejectedCommission: 0,
    totalApprovedCommission: 0,
    totalPaidCommission: 0,
    totalPendingCommission: 0,
    totalClicks: 0,
    totalImpressions: 0,
    totalOrders: 0,
    avgCpc: 0,
    roi: 0,
    campaignCount: 0,
    enabledCount: 0,
    pausedCount: 0,
  };

  // 表格数据（不再添加序号列）

  const syncDateRange = useCallback(async (type: "transactions" | "mcc") => {
    try {
      const values = await syncForm.validateFields();
      const range = values.range;
      if (!range?.[0] || !range?.[1]) return;
      const syncStart = range[0].format("YYYY-MM-DD");
      const syncEnd = range[1].format("YYYY-MM-DD");

      if (type === "transactions") {
        setSyncingTransactions(true);
        try {
          const res = await fetch("/api/user/data-center/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "platform", sync_start_date: syncStart, sync_end_date: syncEnd }),
          }).then((r) => r.json());
          if (res.code === 0) {
            message.success(res.data?.transactions?.message || `交易同步完成（${syncStart} → ${syncEnd}）`);
            setSyncDialog({ open: false, type: null });
            refreshApi(/\/api\/user\/data-center/);
          } else {
            message.error(res.message || "交易同步失败");
          }
        } finally {
          setSyncingTransactions(false);
        }
        return;
      }

      if (mccAccounts.length === 0) {
        message.warning("请先添加 MCC 账户");
        return;
      }

      setSyncingMcc(true);
      try {
        const idsToSync = selectedMcc ? [selectedMcc] : mccAccounts.map((m) => m.id);
        let successCount = 0;
        const errors: string[] = [];

        for (const mccId of idsToSync) {
          const res = await fetch("/api/user/data-center/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "ads",
              mcc_account_id: mccId,
              sync_start_date: syncStart,
              sync_end_date: syncEnd,
            }),
          }).then((r) => r.json());
          if (res.code === 0) successCount++;
          else errors.push(res.message);
        }

        if (successCount > 0) {
          message.success(`${successCount} 个 MCC 同步完成（${syncStart} → ${syncEnd}）${errors.length > 0 ? `，${errors.length} 个失败` : ""}`);
          setSyncDialog({ open: false, type: null });
          refreshApi(/\/api\/user\/data-center/);
        } else {
          message.error(errors[0] || "MCC 同步失败");
        }
      } finally {
        setSyncingMcc(false);
      }
    } catch {
      // 表单校验失败时不提示额外消息
    }
  }, [message, mccAccounts, selectedMcc, syncForm]);

  const handleFullSync = useCallback(async () => {
    if (mccAccounts.length === 0) { message.warning("请先添加 MCC 账户"); return; }
    setSyncingFull(true);
    try {
      const idsToSync = selectedMcc ? [selectedMcc] : mccAccounts.map((m) => m.id);
      let successCount = 0;
      let transactionSynced = false;
      const errors: string[] = [];

      const todayStr = dayjs().tz(TZ).format("YYYY-MM-DD");
      const sevenDaysAgoStr = dayjs().tz(TZ).subtract(6, "day").format("YYYY-MM-DD");

      const txnRes = await fetch("/api/user/data-center/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "platform", sync_start_date: sevenDaysAgoStr, sync_end_date: todayStr }),
      }).then((r) => r.json());
      if (txnRes.code === 0) {
        transactionSynced = true;
      } else {
        errors.push(`商家交易刷新失败：${txnRes.message || "未知错误"}`);
      }

      for (const mccId of idsToSync) {
        const res = await fetch("/api/user/data-center/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "ads", mcc_account_id: mccId, sync_start_date: todayStr, sync_end_date: todayStr }),
        }).then((r) => r.json());
        if (res.code === 0) successCount++;
        else errors.push(res.message);
      }

      if (transactionSynced || successCount > 0) {
        message.success(`刷新完成：商家交易${transactionSynced ? "已完成" : "失败"}，MCC 成功 ${successCount} 个${errors.length > 0 ? `，${errors.length} 项异常` : ""}`);
        refreshApi(/\/api\/user\/data-center/);
      } else {
        message.error(errors[0] || "刷新失败");
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setSyncingFull(false);
    }
  }, [message, mccAccounts, selectedMcc]);

  const openSyncDialog = useCallback((type: "transactions" | "mcc") => {
    syncForm.setFieldsValue({ range: dateRange });
    setSyncDialog({ open: true, type });
  }, [dateRange, syncForm]);

  // 同步 CID 子账户
  const [syncingCid, setSyncingCid] = useState(false);
  const handleSyncCids = useCallback(async () => {
    if (mccAccounts.length === 0) { message.warning("请先添加 MCC 账户"); return; }
    const mccId = selectedMcc || mccAccounts[0]?.id;
    if (!mccId) return;
    setSyncingCid(true);
    try {
      const res = await fetch("/api/user/data-center/cids", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcc_account_id: mccId }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.data?.message || "CID 同步完成");
        refreshApi(/\/api\/user\/data-center/);
      } else message.error(res.message);
    } catch { message.error("网络异常，请重试"); }
    finally { setSyncingCid(false); }
  }, [selectedMcc, mccAccounts, message]);

  const handleOpenAdj = useCallback((mcc: CostByMcc) => {
    setAdjAmount(mcc.adjustment || 0);
    setAdjRemark("");
    setAdjModal({ open: true, mcc });
  }, []);

  const handleSaveAdj = useCallback(async () => {
    if (!adjModal.mcc) return;
    setAdjSaving(true);
    try {
      const month = dateRange[0].format("YYYY-MM");
      const res = await fetch("/api/user/data-center/cost-adjustment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcc_account_id: adjModal.mcc.mcc_db_id, month, amount: adjAmount, remark: adjRemark || undefined }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success("误差费用已保存");
        setAdjModal({ open: false, mcc: null });
        refreshApi(/\/api\/user\/data-center\/campaigns/);
      } else message.error(res.message);
    } catch { message.error("网络异常，请重试"); }
    finally { setAdjSaving(false); }
  }, [adjModal.mcc, adjAmount, adjRemark, dateRange, message]);

  const handleOpenCommissionModal = useCallback(async () => {
    setCommissionModal(true);
    setCommissionTab("merchant");
    setLoadingCommission(true);
    try {
      const params = new URLSearchParams({
        date_start: dateRange[0].format("YYYY-MM-DD"),
        date_end: dateRange[1].format("YYYY-MM-DD"),
      });
      const res = await fetch(`/api/user/data-center/commission-by-account?${params}`).then((r) => r.json());
      if (res.code === 0) {
        setCommissionByAccount(res.data?.byAccount || []);
        setCommissionByMerchant(res.data?.byMerchant || []);
      } else {
        message.error(res.message || "佣金数据加载失败");
      }
    } catch { message.error("网络异常，请重试"); }
    finally { setLoadingCommission(false); }
  }, [dateRange, message]);

  const handleEditSuccess = useCallback(() => {
    setEditModal({ open: false, campaign: null, field: "budget" });
    refreshApi(/\/api\/user\/data-center/);
  }, []);

  // 切换广告状态
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const handleToggleStatus = useCallback(async (row: CampaignRow) => {
    if (!row.google_campaign_id) { message.warning("该广告系列尚未提交到 Google Ads"); return; }
    const action = row.status === "ENABLED" ? "pause" : "enable";
    const newStatus = action === "enable" ? "ENABLED" : "PAUSED";
    setTogglingId(row.id);
    try {
      const res = await fetch("/api/user/data-center/campaigns/toggle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: row.id, action }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || `广告已${action === "enable" ? "启用" : "暂停"}`);
        // 立即在本地覆盖状态
        setStatusOverrides((prev) => ({ ...prev, [row.id]: newStatus }));
        // 后台静默刷新数据
        refreshApi(/\/api\/user\/data-center/);
      } else message.error(res.message);
    } finally { setTogglingId(null); }
  }, [message]);

  // ========== D-238 广告 AI 分析 ==========
  const [strategy, setStrategy] = useState("balanced");
  const [analysisMap, setAnalysisMap] = useState<Record<string, AnalysisItem>>({});
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);
  const [bulkApplying, setBulkApplying] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [analysisModal, setAnalysisModal] = useState<{ open: boolean; campaignId: string | null; campaignName: string }>({ open: false, campaignId: null, campaignName: "" });

  // 行 id 列表（稳定字符串，避免 effect 频繁触发）
  const rowIdsKey = useMemo(() => rows.map((r) => r.id).join(","), [rows]);
  const [analysisVersion, setAnalysisVersion] = useState(0);

  // 页面加载 / 行集变化 / 策略切换时，批量读取缓存的分析建议（只读缓存，不触发 AI）
  useEffect(() => {
    if (!rowIdsKey) { setAnalysisMap({}); return; }
    const ids = rowIdsKey.split(",");
    let cancelled = false;
    (async () => {
      const map: Record<string, AnalysisItem> = {};
      // 分批防 URL 过长
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        try {
          const res = await fetch(`/api/user/data-center/ai-analysis?ids=${chunk.join(",")}&strategy=${strategy}`).then((r) => r.json());
          if (res.code === 0) {
            for (const item of (res.data?.items || []) as AnalysisItem[]) map[item.campaignId] = item;
          }
        } catch { /* 静默，建议列显示为空 */ }
      }
      if (!cancelled) setAnalysisMap(map);
    })();
    return () => { cancelled = true; };
  }, [rowIdsKey, strategy, analysisVersion]);

  const refreshAnalysis = useCallback(() => {
    setAnalysisVersion((v) => v + 1);
    refreshApi(/\/api\/user\/data-center/);
  }, []);

  // 一键分析：对当前筛选后的 ENABLED 行跑快速批量分析（命中当日缓存的不重跑）
  const handleBulkAnalyze = useCallback(async () => {
    const targets = rows.filter((r) => r.status === "ENABLED" && !r.cid_suspended).map((r) => r.id).slice(0, 200);
    if (targets.length === 0) { message.warning("当前列表没有已启用的广告系列"); return; }
    setBulkAnalyzing(true);
    try {
      const res = await fetch("/api/user/data-center/ai-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignIds: targets, strategy, forceRefresh: false, detailed: false }),
      }).then((r) => r.json());
      if (res.code === 0) {
        const items = (res.data?.items || []) as AnalysisItem[];
        setAnalysisMap((prev) => {
          const next = { ...prev };
          for (const item of items) next[item.campaignId] = item;
          return next;
        });
        const ok = items.filter((i) => i.status === "generated" || i.status === "cached").length;
        const failed = items.length - ok;
        message.success(`分析完成：${ok} 个成功${failed > 0 ? `，${failed} 个失败` : ""}`);
      } else {
        message.error(res.message || "分析失败");
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setBulkAnalyzing(false);
    }
  }, [rows, strategy, message]);

  // 单行执行第 1 条建议（与 kyads 一致：一键调整只执行第 1 条）
  const applyFirstAction = useCallback(async (campaignId: string): Promise<{ success: boolean; message: string }> => {
    const item = analysisMap[campaignId];
    const first = item?.actionItems?.[0];
    if (!first) return { success: false, message: "无建议" };
    if (first.type === "keep") return { success: true, message: "维持现状" };
    const res = await fetch("/api/user/data-center/apply-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId, actions: [first] }),
    }).then((r) => r.json());
    if (res.code !== 0) return { success: false, message: res.message || "执行失败" };
    const results: Array<{ success: boolean; message: string }> = res.data?.results || [];
    const failed = results.find((r) => !r.success);
    return failed ? { success: false, message: failed.message } : { success: true, message: results[0]?.message || "已执行" };
  }, [analysisMap]);

  const handleRowApply = useCallback(async (row: CampaignRow) => {
    setApplyingId(row.id);
    try {
      const r = await applyFirstAction(row.id);
      if (r.success) { message.success(r.message); refreshApi(/\/api\/user\/data-center/); }
      else message.error(r.message);
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setApplyingId(null);
    }
  }, [applyFirstAction, message]);

  // 一键调整：批量执行所有有非 keep 建议的行（每行只执行第 1 条），逐行串行防 API 限流
  const handleBulkApply = useCallback(() => {
    const targets = rows.filter((r) => {
      const first = analysisMap[r.id]?.actionItems?.[0];
      return first && first.type !== "keep" && r.status === "ENABLED" && !r.cid_suspended;
    });
    if (targets.length === 0) { message.warning("没有可执行的操作建议（keep 不执行）"); return; }
    modal.confirm({
      title: `确认批量执行 ${targets.length} 条操作建议？`,
      content: (
        <div style={{ fontSize: 12, maxHeight: 240, overflow: "auto" }}>
          {targets.slice(0, 20).map((r) => (
            <div key={r.id} style={{ lineHeight: 1.9 }}>
              <Text style={{ fontSize: 12 }}>{r.campaign_name}</Text>
              <Tag color={actionColor(analysisMap[r.id]!.actionItems![0].type)} style={{ marginLeft: 6, fontSize: 11 }}>
                {formatActionItem(analysisMap[r.id]!.actionItems![0])}
              </Tag>
            </div>
          ))}
          {targets.length > 20 && <Text type="secondary">… 等共 {targets.length} 条</Text>}
        </div>
      ),
      okText: "执行",
      cancelText: "取消",
      onOk: async () => {
        setBulkApplying(true);
        let ok = 0; const errors: string[] = [];
        try {
          for (const r of targets) {
            try {
              const result = await applyFirstAction(r.id);
              if (result.success) ok++;
              else errors.push(`${r.campaign_name}: ${result.message}`);
            } catch {
              errors.push(`${r.campaign_name}: 网络异常`);
            }
          }
          if (errors.length === 0) message.success(`批量执行完成：${ok} 条成功`);
          else message.warning(`执行完成：${ok} 条成功，${errors.length} 条失败（${errors[0]}）`);
          refreshApi(/\/api\/user\/data-center/);
        } finally {
          setBulkApplying(false);
        }
      },
    });
  }, [rows, analysisMap, modal, message, applyFirstAction]);

  const statusColors: Record<string, string> = { ENABLED: "green", PAUSED: "orange", REMOVED: "red" };
  const statusLabels: Record<string, string> = { ENABLED: "已启用", PAUSED: "已暂停", REMOVED: "已移除" };

  type IndexedRow = CampaignRow;

  // ========== D-239 自定义列展示 ==========
  const { visibleKeys, save: saveColumnPrefs, reset: resetColumnPrefs } = useTableColumnPrefs({
    tableKey: COLUMN_PREFS_TABLE_KEY,
    allKeys: ALL_COLUMN_KEYS,
    lockedKeys: LOCKED_COLUMN_KEYS,
    defaultKeys: DEFAULT_COLUMN_KEYS,
  });
  const metricColumns = useMemo(() => buildMetricColumns<IndexedRow>(), []);

  // 页面专属列（依赖本页闭包：编辑弹窗/状态切换/AI 分析）+ 共享指标列 = 完整注册表
  const columnRegistry: Record<string, ColumnsType<IndexedRow>[number]> = {
    ...metricColumns,
    customer_id: {
      key: "customer_id",
      title: "CID", dataIndex: "customer_id", width: 110,
      render: (v: string, r: IndexedRow) => {
        const removed = r.is_removed || r.cid_suspended;
        return (
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <Text
              copyable={{ text: v }}
              style={{ fontSize: 12, margin: 0, color: removed ? "#cf1322" : undefined }}
            >
              {formatCid(v)}
            </Text>
            {r.cid_suspended && (
              <Tooltip title="该 CID 已被 Google 中止/停用">
                <span style={{ color: "#cf1322", marginLeft: 4, fontSize: 11 }}>●</span>
              </Tooltip>
            )}
          </span>
        );
      },
    },
    campaign_name: {
      key: "campaign_name",
      // 固定列（不可隐藏）始终排第一，同时固定在左侧，横向滚动时可对照行
      title: "广告系列", dataIndex: "campaign_name", width: 280, fixed: "left",
      sorter: (a, b) => {
        const seqA = parseInt(a.campaign_name?.split("-")[0] || "0", 10) || 0;
        const seqB = parseInt(b.campaign_name?.split("-")[0] || "0", 10) || 0;
        return seqA - seqB;
      },
      render: (v: string) => (
        <Text style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal", lineHeight: "1.4" }}>
          {v}
        </Text>
      ),
    },
    status: {
      key: "status",
      title: "状态", dataIndex: "status", width: 100, align: "center",
      render: (v: string, r: IndexedRow) => {
        // D-248：被中止 CID 旗下——ENABLED 显示「被中止」，PAUSED 保持「已暂停」，操作图标一律灰化
        const suspended = !!r.cid_suspended && v !== "REMOVED";
        const label = suspended && v === "ENABLED" ? "被中止" : statusLabels[v] || v;
        const color = suspended && v === "ENABLED" ? "red" : statusColors[v] || "default";
        return (
          <Space size={4}>
            <Tag color={color} style={{ fontSize: 11, margin: 0 }}>{label}</Tag>
            {v !== "REMOVED" && r.google_campaign_id && (
              suspended ? (
                <Tooltip title="所属 CID 已被 Google 中止，无法操作">
                  <Button
                    type="text" size="small" disabled
                    icon={v === "ENABLED" ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                    style={{ padding: 0, height: 20, width: 20 }}
                  />
                </Tooltip>
              ) : (
                <Tooltip title={v === "ENABLED" ? "暂停广告" : "启用广告"}>
                  <Button
                    type="text" size="small"
                    loading={togglingId === r.id}
                    icon={v === "ENABLED" ? <PauseCircleOutlined style={{ color: "#faad14" }} /> : <PlayCircleOutlined style={{ color: "#52c41a" }} />}
                    onClick={() => handleToggleStatus(r)}
                    style={{ padding: 0, height: 20, width: 20 }}
                  />
                </Tooltip>
              )
            )}
          </Space>
        );
      },
    },
    daily_budget: {
      key: "daily_budget",
      title: "预算", dataIndex: "daily_budget", width: 70, align: "right",
      render: (v: number, r: IndexedRow) => (
        // D-248：被中止 CID 旗下禁改预算，编辑图标灰化
        // D-266 批一：值已折美元；非美元 MCC 悬浮显示账户币种原值
        <Tooltip title={r.cid_suspended
          ? "所属 CID 已被 Google 中止，无法操作"
          : (r.mcc_currency && r.mcc_currency !== "USD" ? `账户币种 ${r.daily_budget_account?.toFixed(2)} ${r.mcc_currency}，已按当日汇率折美元` : undefined)}>
          <Button type="link" size="small" disabled={!!r.cid_suspended} style={{ padding: 0, fontSize: 12 }}
            onClick={() => setEditModal({ open: true, campaign: r, field: "budget" })}>
            ${v?.toFixed(2)} <EditOutlined style={{ fontSize: 10 }} />
          </Button>
        </Tooltip>
      ),
    },
    max_cpc: {
      key: "max_cpc",
      title: "最高出价", dataIndex: "max_cpc", width: 90, align: "right",
      render: (v: number | null, r: IndexedRow) => (
        // D-248：被中止 CID 旗下禁改出价，编辑图标灰化
        // D-266 批一：值已折美元；非美元 MCC 悬浮显示账户币种原值
        <Tooltip title={r.cid_suspended
          ? "所属 CID 已被 Google 中止，无法操作"
          : (r.mcc_currency && r.mcc_currency !== "USD" && r.max_cpc_account != null ? `账户币种 ${r.max_cpc_account.toFixed(4)} ${r.mcc_currency}，已按当日汇率折美元` : undefined)}>
          <Button type="link" size="small" disabled={!!r.cid_suspended} style={{ padding: 0, fontSize: 12 }}
            onClick={() => setEditModal({ open: true, campaign: r, field: "max_cpc" })}>
            ${(v ?? 0).toFixed(4)} <EditOutlined style={{ fontSize: 10 }} />
          </Button>
        </Tooltip>
      ),
    },
    // 展示/点击/订单/平均CPC/EPC/每百次点击费用/花费/CPA/佣金/AOV/拒付佣金/净利润/利润率/ROI/CVR/IS_Bgt/IS_Rnk
    // 由 metricColumns 提供（tableColumnPrefs 共享定义，与组员弹窗同一份，防漂移）
    ai_suggestion: {
      title: (
        <Tooltip title="AI 分析建议（每日 06:40 自动分析 + 手动一键分析），点击「执行」按第 1 条建议实际调整">
          <span>操作建议</span>
        </Tooltip>
      ),
      key: "ai_suggestion", width: 170,
      render: (_: unknown, r: IndexedRow) => {
        const item = analysisMap[r.id];
        const actions = item?.actionItems || [];
        if (actions.length === 0) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        const first = actions[0];
        return (
          <Space size={4} wrap>
            {actions.slice(0, 2).map((a, i) => (
              <Tooltip key={i} title={item?.summary || undefined}>
                <Tag color={actionColor(a.type)} style={{ fontSize: 11, margin: 0 }}>{formatActionItem(a)}</Tag>
              </Tooltip>
            ))}
            {first.type !== "keep" && r.status === "ENABLED" && !r.cid_suspended && (
              <Button
                type="link" size="small" loading={applyingId === r.id}
                style={{ padding: 0, fontSize: 11, height: 18 }}
                onClick={() => {
                  modal.confirm({
                    title: `确认执行「${formatActionItem(first)}」？`,
                    content: `广告系列：${r.campaign_name}`,
                    okText: "执行", cancelText: "取消",
                    onOk: () => handleRowApply(r),
                  });
                }}
              >执行</Button>
            )}
          </Space>
        );
      },
    },
    ai_detail: {
      title: "分析", key: "ai_detail", width: 55, align: "center",
      render: (_: unknown, r: IndexedRow) => (
        <Tooltip title="查看逐日明细与 AI 分析报告">
          <Button
            type="text" size="small" icon={<EyeOutlined style={{ color: "#1677ff" }} />}
            style={{ padding: 0, height: 22, width: 22 }}
            onClick={() => setAnalysisModal({ open: true, campaignId: r.id, campaignName: r.campaign_name })}
          />
        </Tooltip>
      ),
    },
  };

  // 按员工偏好过滤 + 排序出最终列
  const columns: ColumnsType<IndexedRow> = visibleKeys
    .map((k) => columnRegistry[k])
    .filter((c): c is ColumnsType<IndexedRow>[number] => Boolean(c));
  /** scroll.x 须 ≥ 可见列宽之和，否则固定列（广告系列）会与表体错位 */
  const tableScrollX = columns.reduce((sum, c) => sum + (typeof c.width === "number" ? c.width : 100), 0);

  return (
    <div>
      <AppPageHeader icon={<TableOutlined />} title="数据中心" subtitle="按 MCC / 平台维度查看广告系列实时数据" />
      {/* ========== 顶部筛选栏 ========== */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[8, 8]} align="middle">
          <Col>
            <Select
              placeholder="所有 MCC" allowClear style={{ width: 180 }} size="small"
              value={selectedMcc || undefined}
              onChange={(v) => setSelectedMcc(v || "")}
              options={mccAccounts.map((m) => ({ value: m.id, label: `${m.mcc_name || m.mcc_id} (${m.currency})` }))}
            />
          </Col>
          <Col>
            <Select
              placeholder="广告状态" allowClear style={{ width: 100 }} size="small"
              value={statusFilter !== "all" ? statusFilter : undefined}
              onChange={(v) => setStatusFilter(v || "all")}
              options={[
                { value: "ENABLED", label: "已启用" },
                { value: "PAUSED", label: "已暂停" },
                { value: "REMOVED", label: "已移除" },
              ]}
            />
          </Col>
          <Col>
            <Select
              placeholder="平台" allowClear style={{ width: 100 }} size="small"
              value={platformFilter || undefined}
              onChange={(v) => setPlatformFilter(v || "")}
              options={PLATFORMS.map((p) => ({ value: p.code, label: p.code }))}
            />
          </Col>
          <Col>
            <Input
              placeholder="MID" allowClear style={{ width: 120 }} size="small"
              value={midFilter} onChange={(e) => setMidFilter(e.target.value)}
            />
          </Col>
          <Col>
            <RangePicker
              size="small" value={dateRange}
              onChange={(v) => { if (v?.[0] && v?.[1]) setDateRange([v[0], v[1]]); }}
            />
          </Col>
          <Col>
            <Input
              placeholder="搜索广告系列" prefix={<SearchOutlined />} allowClear style={{ width: 160 }} size="small"
              value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)}
            />
          </Col>
          <Col>
            <Space>
              <Tooltip title="按所选时间范围同步联盟交易数据">
                <Button type="primary" size="small" icon={<SyncOutlined spin={syncingTransactions} />} loading={syncingTransactions} onClick={() => openSyncDialog("transactions")}>
                  同步交易
                </Button>
              </Tooltip>
              <Tooltip title="按所选时间范围同步 MCC 广告数据">
                <Button size="small" icon={<CloudDownloadOutlined />} loading={syncingMcc} onClick={() => openSyncDialog("mcc")}>
                  同步MCC
                </Button>
              </Tooltip>
              <Tooltip title="同步今日谷歌广告数据 + 近7天商家交易数据">
                <Button size="small" icon={<RedoOutlined />} loading={syncingFull} onClick={handleFullSync}>刷新</Button>
              </Tooltip>
              <Button size="small" icon={<CloudDownloadOutlined />} loading={syncingCid} onClick={handleSyncCids}>同步 CID</Button>
            </Space>
          </Col>
          <Col>
            <Space>
              <Select
                size="small" value={strategy} onChange={setStrategy}
                options={STRATEGY_OPTIONS} style={{ width: 90 }}
              />
              <Tooltip title="对当前列表所有已启用系列跑 AI 分析（当天已分析过的直接用缓存）">
                <Button size="small" icon={<RobotOutlined />} loading={bulkAnalyzing} onClick={handleBulkAnalyze}>
                  一键分析
                </Button>
              </Tooltip>
              <Tooltip title="批量执行所有非「维持现状」的第 1 条建议（改预算 / 改出价 / 暂停）">
                <Button size="small" danger loading={bulkApplying} onClick={handleBulkApply}>
                  一键调整
                </Button>
              </Tooltip>
            </Space>
          </Col>
          <Col>
            <ColumnSettingsButton
              columnsMeta={COLUMNS_META}
              lockedKeys={LOCKED_COLUMN_KEYS}
              visibleKeys={visibleKeys}
              onSave={saveColumnPrefs}
              onReset={resetColumnPrefs}
            />
          </Col>
        </Row>
      </Card>

      {/* ========== 统计卡片（总花费 + 总佣金 + 拒付佣金 + 今日投放数 + 在跑广告数） ========== */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} sm={8} md={6}>
          <Card size="small" styles={{ body: { padding: "8px 12px", cursor: "pointer" } }} hoverable onClick={() => setDetailModal(true)}>
            <Statistic title="总花费" value={summary.totalCost} prefix="$" precision={2}
              suffix={<Text style={{ fontSize: 11, color: "#999" }}>点击查看详情</Text>}
              styles={{ content: { fontSize: 18, color: "#cf1322" } }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card size="small" styles={{ body: { padding: "8px 12px", cursor: "pointer" } }} hoverable onClick={handleOpenCommissionModal}>
            <Statistic title="总佣金" value={summary.totalCommission} prefix="$" precision={2}
              suffix={<Text style={{ fontSize: 11, color: "#999" }}>点击查看详情</Text>}
              styles={{ content: { fontSize: 18, color: "#389e0d" } }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
            <Statistic title="拒付佣金" value={summary.totalRejectedCommission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: summary.totalRejectedCommission > 0 ? "#cf1322" : undefined } }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
            {summary.scriptConfigured === false ? (
              <Tooltip title="未检测到已配置 Google Sheet 的 MCC 统一脚本，无法统计今日投放数">
                <Statistic
                  title="今日投放数"
                  valueRender={() => (
                    <Text style={{ fontSize: 12, color: "#fa8c16" }}>
                      <WarningOutlined style={{ marginRight: 4 }} />脚本未同步，需同步配置脚本
                    </Text>
                  )}
                />
              </Tooltip>
            ) : (
              <Tooltip title="今日（东八区）新建且历史没出现过同名系列的广告数量，每 30 分钟从 Google Sheet 同步">
                <Statistic
                  title="今日投放数"
                  value={summary.todayAdsCount ?? 0}
                  suffix="条"
                  styles={{ content: { fontSize: 18, color: (summary.todayAdsCount ?? 0) > 0 ? "#1677ff" : "#8c8c8c" } }}
                />
              </Tooltip>
            )}
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
            <Tooltip title="当前名下活跃 MCC 中「已启用」的广告系列条数（与小组总览「在跑广告」同一口径；同一商家投多个国家算多条）">
              <Statistic
                title="在跑广告数"
                value={summary.enabledCount}
                suffix="条"
                styles={{ content: { fontSize: 18, color: summary.enabledCount > 0 ? "#52c41a" : "#8c8c8c" } }}
              />
            </Tooltip>
          </Card>
        </Col>
      </Row>

      {/* ========== 口径说明 + 行数限制提示 ========== */}
      <div style={{ marginBottom: 8, padding: "4px 8px", background: "#fafafa", borderRadius: 4, fontSize: 12, color: "#888", lineHeight: 1.8 }}>
        <span>
          {summary.commissionScope === "filtered"
            ? "统计口径：已启用筛选条件——总花费 / 总佣金 / ROI 只统计筛选后剩下的广告系列（佣金按商家+联盟账号归属到系列），归不到这些系列的佣金不计入。清空筛选可看全量。"
            : summary.commissionScope === "mcc"
            ? "统计口径：已选择单个 MCC——总花费 / 总佣金 / ROI 仅统计该 MCC 下广告系列（佣金按商家+联盟账号归属到系列），归不到该 MCC 系列的佣金不计入。"
            : "统计口径：总花费 / 总佣金 / ROI 基于全部去重 Campaign 聚合，不受表格展示行数限制。"}
        </span>
        <span style={{ marginLeft: 8 }}>点击与花费同源于 Google Ads；IS_Bgt / IS_Rnk 为区间内最新一日值，每日 06:10 自动采集。</span>
        {rowMeta?.isLimited && (
          <span style={{ color: "#fa8c16", marginLeft: 8 }}>
            表格仅展示 {rowMeta.displayedCount} / {rowMeta.totalCount} 条 Campaign 行，合计行与上方总览一致。
          </span>
        )}
      </div>

      {/* ========== 广告系列表格 ========== */}
      <Card size="small" styles={{ body: { padding: "8px 8px 8px" } }}>
        <Table<IndexedRow>
          rowKey="id" loading={isLoading} dataSource={rows} columns={columns}
          size="small" scroll={{ x: tableScrollX }}
          className="data-center-campaigns-table"
          pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true, pageSizeOptions: ["20", "50", "100"] }}
          summary={() => {
            if (rows.length === 0) return null;
            // D-239：合计行按可见列 key 对齐（此前是硬编码列序号，隐藏列会错位）
            const totals: TableSummaryTotals = {
              totalImpressions: summary.totalImpressions,
              totalClicks: summary.totalClicks,
              totalOrders: summary.totalOrders,
              avgCpc: summary.avgCpc,
              totalCost: summary.totalCost,
              totalCommission: summary.totalCommission,
              totalRejectedCommission: summary.totalRejectedCommission,
              roi: summary.roi,
            };
            return (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  {columns.map((col, i) => {
                    const key = String(col.key);
                    if (i === 0) {
                      return <Table.Summary.Cell key={key} index={0}><Text strong>合计</Text></Table.Summary.Cell>;
                    }
                    return (
                      <Table.Summary.Cell key={key} index={i} align="right">
                        {renderColumnSummary(key, totals)}
                      </Table.Summary.Cell>
                    );
                  })}
                </Table.Summary.Row>
              </Table.Summary>
            );
          }}
        />
      </Card>

      {/* ========== 花费明细弹窗（MCC 汇总 + 误差） ========== */}
      <Modal title="花费明细" open={detailModal} onCancel={() => setDetailModal(false)} footer={null} width={620}>
        {costByMcc.length > 0 ? (
          <>
            <Table
              rowKey="mcc_db_id" dataSource={costByMcc} size="small" pagination={false}
              columns={[
                { title: "MCC 账户", dataIndex: "mcc_name", width: 140, render: (v: string, r: CostByMcc) => (
                  <span><Text style={{ fontSize: 12 }}>{v}</Text> <Tag color={r.currency === "CNY" ? "orange" : "blue"} style={{ fontSize: 10, marginLeft: 4 }}>{r.currency}</Tag></span>
                ) },
                { title: "花费 (USD)", dataIndex: "cost_usd", width: 110, align: "right", render: (v: number) => <Text strong style={{ color: "#cf1322", fontSize: 13 }}>${v.toFixed(2)}</Text> },
                { title: "原始金额", key: "cost_original", width: 110, align: "right", render: (_: unknown, r: CostByMcc) => (
                  r.currency === "CNY" && r.cost_original != null
                    ? <Text strong style={{ color: "#d46b08", fontSize: 13 }}>¥{r.cost_original.toFixed(2)}</Text>
                    : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
                ) },
                { title: "误差", key: "adjustment", width: 120, align: "right", render: (_: unknown, r: CostByMcc) => (
                  <Space size={4}>
                    {r.adjustment ? <Text style={{ fontSize: 12, color: "#fa8c16" }}>+${r.adjustment.toFixed(2)}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>}
                    <Button type="link" size="small" icon={r.adjustment ? <EditOutlined /> : <PlusOutlined />} style={{ padding: 0, fontSize: 12 }} onClick={(e) => { e.stopPropagation(); handleOpenAdj(r); }} />
                  </Space>
                ) },
              ]}
              summary={() => costByMcc.length > 1 ? (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right"><Text strong style={{ color: "#cf1322" }}>${summary.totalCost.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={2} />
                  <Table.Summary.Cell index={3} />
                </Table.Summary.Row>
              ) : null}
            />
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message="数据来源说明"
              description={
                <div style={{ fontSize: 12, lineHeight: "1.8" }}>
                  系统数据来自 Google Sheet 导出（每日自动同步近 31 天）+ Google Ads API（补近 2 天）。
                  若与 Google Ads 后台存在差异，可能是 Sheet 脚本未覆盖某些日期，请点击上方
                  <Text strong>「同步MCC」</Text>按钮并选择完整月份范围重新同步。
                  若仍存在差额，可通过「误差」列手动补录差值。
                </div>
              }
            />
          </>
        ) : (
          <Text type="secondary">暂无数据</Text>
        )}
      </Modal>

      {/* ========== 误差费用编辑弹窗 ========== */}
      <Modal title={`${adjModal.mcc?.mcc_name || ""} — 误差费用（${dateRange[0].format("YYYY-MM")}）`} open={adjModal.open} onCancel={() => setAdjModal({ open: false, mcc: null })} onOk={handleSaveAdj} confirmLoading={adjSaving} okText="保存" width={400}>
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>输入 Google Ads 后台与系统之间的费用差额（USD），将计入总花费。</Text>
        </div>
        <div style={{ marginBottom: 12 }}>
          <Text style={{ fontSize: 13, marginBottom: 4, display: "block" }}>误差金额 ($)</Text>
          <InputNumber value={adjAmount} onChange={(v) => setAdjAmount(v || 0)} min={0} step={0.01} precision={2} style={{ width: "100%" }} prefix="$" />
        </div>
        <div>
          <Text style={{ fontSize: 13, marginBottom: 4, display: "block" }}>备注（可选）</Text>
          <Input value={adjRemark} onChange={(e) => setAdjRemark(e.target.value)} placeholder="如：已取消 CID 的历史费用" maxLength={200} />
        </div>
      </Modal>

      {/* ========== 佣金详情弹窗（含汇总指标 + 按平台账号明细） ========== */}
      <Modal title="佣金详情" open={commissionModal} onCancel={() => setCommissionModal(false)} footer={null} width={900}>
        {/* D-176：佣金详情弹窗始终按全账号统计（交易无 MCC 归属），选了单 MCC 时提示与卡片口径差异 */}
        {selectedMcc && (
          <div style={{ marginBottom: 12, padding: "6px 10px", background: "#fffbe6", border: "1px solid #ffe58f", borderRadius: 4, fontSize: 12, color: "#874d00" }}>
            当前已选择单个 MCC：上方「总佣金」卡片仅统计能归属到该 MCC 广告系列的佣金；本弹窗明细为全账号所有平台佣金，两者可能不一致。
          </div>
        )}
        {/* 汇总指标 — 与下方明细表同源（commission-by-account API 实时拉取），避免与 campaigns SWR 缓存口径不一 */}
        {(() => {
          const src = commissionByAccount.length > 0 ? commissionByAccount : commissionByMerchant;
          const modalTotal     = src.reduce((s, r) => s + r.total_commission, 0);
          const modalApproved  = src.reduce((s, r) => s + r.approved_commission + r.paid_commission, 0);
          const modalPending   = src.reduce((s, r) => s + r.pending_commission, 0);
          const modalRejected  = src.reduce((s, r) => s + r.rejected_commission, 0);
          return (
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              <Col span={8}>
                <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                  <Statistic title="总佣金" value={modalTotal} prefix="$" precision={2} styles={{ content: { fontSize: 16, color: modalTotal > 0 ? "#389e0d" : undefined } }} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                  <Statistic title="已确认佣金" value={modalApproved} prefix="$" precision={2} styles={{ content: { fontSize: 16, color: modalApproved > 0 ? "#1890ff" : undefined } }} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                  <Statistic title="待审核佣金" value={modalPending} prefix="$" precision={2} styles={{ content: { fontSize: 16, color: modalPending > 0 ? "#faad14" : undefined } }} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                  <Statistic title="拒付佣金" value={modalRejected} prefix="$" precision={2} styles={{ content: { fontSize: 16, color: modalRejected > 0 ? "#cf1322" : undefined } }} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                  <Statistic title="平均 CPC" value={summary.avgCpc} prefix="$" precision={4} styles={{ content: { fontSize: 16 } }} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                  <Statistic title="ROI" value={summary.roi} precision={2}
                    prefix={summary.roi >= 0 ? <RiseOutlined /> : <FallOutlined />}
                    styles={{ content: { fontSize: 16, color: summary.roi >= 0 ? "#389e0d" : "#cf1322" } }} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                  <Statistic title="广告系列" value={`${summary.enabledCount} 启用 / ${summary.pausedCount} 暂停`} styles={{ content: { fontSize: 13 } }} />
                </Card>
              </Col>
            </Row>
          );
        })()}

        {/* 佣金明细 Tabs：按商家 / 按平台账号 */}
        <Tabs activeKey={commissionTab} onChange={(k) => setCommissionTab(k as "merchant" | "account")} size="small" items={[
          {
            key: "merchant",
            label: "按商家",
            children: (
              <Table
                rowKey="user_merchant_id"
                dataSource={commissionByMerchant}
                size="small"
                loading={loadingCommission}
                pagination={false}
                scroll={{ x: 820 }}
                columns={[
                  { title: "商家", dataIndex: "merchant_name", width: 160, ellipsis: true, render: (v: string) => <Tag color="geekblue">{v}</Tag> },
                  { title: "总佣金", dataIndex: "total_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByMerchant[0], b: typeof commissionByMerchant[0]) => a.total_commission - b.total_commission, defaultSortOrder: "descend" as const, render: (v: number) => <Text style={{ color: v > 0 ? "#389e0d" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "已确认", dataIndex: "approved_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByMerchant[0], b: typeof commissionByMerchant[0]) => a.approved_commission - b.approved_commission, render: (v: number) => <Text style={{ color: v > 0 ? "#1890ff" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "已支付", dataIndex: "paid_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByMerchant[0], b: typeof commissionByMerchant[0]) => a.paid_commission - b.paid_commission, render: (v: number) => <Text style={{ color: v > 0 ? "#13c2c2" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "待审核", dataIndex: "pending_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByMerchant[0], b: typeof commissionByMerchant[0]) => a.pending_commission - b.pending_commission, render: (v: number) => <Text style={{ color: v > 0 ? "#faad14" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "拒付", dataIndex: "rejected_commission", width: 90, align: "right" as const, sorter: (a: typeof commissionByMerchant[0], b: typeof commissionByMerchant[0]) => a.rejected_commission - b.rejected_commission, render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"}>${v.toFixed(2)}</Text> },
                  { title: "订单数", dataIndex: "order_count", width: 70, align: "right" as const, sorter: (a: typeof commissionByMerchant[0], b: typeof commissionByMerchant[0]) => a.order_count - b.order_count },
                ]}
                summary={() => {
                  if (commissionByMerchant.length === 0) return null;
                  const totals = commissionByMerchant.reduce(
                    (acc, r) => ({ total: acc.total + r.total_commission, approved: acc.approved + r.approved_commission, paid: acc.paid + r.paid_commission, pending: acc.pending + r.pending_commission, rejected: acc.rejected + r.rejected_commission, orders: acc.orders + r.order_count }),
                    { total: 0, approved: 0, paid: 0, pending: 0, rejected: 0, orders: 0 }
                  );
                  return (
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={1} align="right"><Text strong style={{ color: "#389e0d" }}>${totals.total.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right"><Text strong style={{ color: "#1890ff" }}>${totals.approved.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right"><Text strong style={{ color: "#13c2c2" }}>${totals.paid.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={4} align="right"><Text strong style={{ color: "#faad14" }}>${totals.pending.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={5} align="right"><Text strong type="danger">${totals.rejected.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={6} align="right"><Text strong>{totals.orders}</Text></Table.Summary.Cell>
                    </Table.Summary.Row>
                  );
                }}
              />
            ),
          },
          {
            key: "account",
            label: "按平台账号",
            children: (
              <Table
                rowKey={(r) => `${r.platform}-${r.account_name}`}
                dataSource={commissionByAccount}
                size="small"
                loading={loadingCommission}
                pagination={false}
                scroll={{ x: 820 }}
                columns={[
                  { title: "账号", dataIndex: "account_name", width: 200, ellipsis: true, render: (v: string, r: (typeof commissionByAccount)[0]) => (
                    <Space size={4}>
                      <Tag color="blue">{v} ({r.platform})</Tag>
                      {r.bound_after_range_start && r.connection_created_at && (
                        <Tooltip title={`该账号 ${r.connection_created_at} 起绑定到当前员工，本行仅含绑定后的数据；绑定前同账号的佣金归属原员工（与平台后台全量视角存在差额属正常）`}>
                          <Tag color="orange" style={{ fontSize: 11, cursor: "help" }}>{r.connection_created_at.slice(5).replace("-", "/")}起绑定</Tag>
                        </Tooltip>
                      )}
                    </Space>
                  ) },
                  { title: "总佣金", dataIndex: "total_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByAccount[0], b: typeof commissionByAccount[0]) => a.total_commission - b.total_commission, defaultSortOrder: "descend" as const, render: (v: number) => <Text style={{ color: v > 0 ? "#389e0d" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "已确认", dataIndex: "approved_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByAccount[0], b: typeof commissionByAccount[0]) => a.approved_commission - b.approved_commission, render: (v: number) => <Text style={{ color: v > 0 ? "#1890ff" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "已支付", dataIndex: "paid_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByAccount[0], b: typeof commissionByAccount[0]) => a.paid_commission - b.paid_commission, render: (v: number) => <Text style={{ color: v > 0 ? "#13c2c2" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "待审核", dataIndex: "pending_commission", width: 100, align: "right" as const, sorter: (a: typeof commissionByAccount[0], b: typeof commissionByAccount[0]) => a.pending_commission - b.pending_commission, render: (v: number) => <Text style={{ color: v > 0 ? "#faad14" : undefined }}>${v.toFixed(2)}</Text> },
                  { title: "拒付", dataIndex: "rejected_commission", width: 90, align: "right" as const, sorter: (a: typeof commissionByAccount[0], b: typeof commissionByAccount[0]) => a.rejected_commission - b.rejected_commission, render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"}>${v.toFixed(2)}</Text> },
                  { title: "订单数", dataIndex: "order_count", width: 70, align: "right" as const, sorter: (a: typeof commissionByAccount[0], b: typeof commissionByAccount[0]) => a.order_count - b.order_count },
                ]}
                summary={() => {
                  if (commissionByAccount.length === 0) return null;
                  const totals = commissionByAccount.reduce(
                    (acc, r) => ({ total: acc.total + r.total_commission, approved: acc.approved + r.approved_commission, paid: acc.paid + r.paid_commission, pending: acc.pending + r.pending_commission, rejected: acc.rejected + r.rejected_commission, orders: acc.orders + r.order_count }),
                    { total: 0, approved: 0, paid: 0, pending: 0, rejected: 0, orders: 0 }
                  );
                  return (
                    <Table.Summary.Row>
                      <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={1} align="right"><Text strong style={{ color: "#389e0d" }}>${totals.total.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={2} align="right"><Text strong style={{ color: "#1890ff" }}>${totals.approved.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={3} align="right"><Text strong style={{ color: "#13c2c2" }}>${totals.paid.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={4} align="right"><Text strong style={{ color: "#faad14" }}>${totals.pending.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={5} align="right"><Text strong type="danger">${totals.rejected.toFixed(2)}</Text></Table.Summary.Cell>
                      <Table.Summary.Cell index={6} align="right"><Text strong>{totals.orders}</Text></Table.Summary.Cell>
                    </Table.Summary.Row>
                  );
                }}
              />
            ),
          },
        ]} />
        <Text type="secondary" style={{ fontSize: 12 }}>* {TXN_TZ_NOTE}</Text>
      </Modal>

      <Modal
        title={syncDialog.type === "transactions" ? "同步交易" : "同步MCC"}
        open={syncDialog.open}
        onCancel={() => setSyncDialog({ open: false, type: null })}
        onOk={() => { if (syncDialog.type) void syncDateRange(syncDialog.type); }}
        confirmLoading={syncDialog.type === "transactions" ? syncingTransactions : syncingMcc}
        okText="开始同步"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={syncForm} layout="vertical">
          <Form.Item
            name="range"
            label="选择同步时间"
            rules={[{ required: true, message: "请选择同步时间范围" }]}
          >
            <RangePicker style={{ width: "100%" }} />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {syncDialog.type === "transactions"
              ? "将仅同步所选时间范围内的联盟交易数据，并重算对应佣金。"
              : "将仅同步所选时间范围内的 MCC 广告数据。若结束日期包含今天，会额外抓取今日 Google Ads 数据。"}
          </Text>
        </Form>
      </Modal>

      <EditCampaignModal
        open={editModal.open} campaign={editModal.campaign} field={editModal.field}
        mccAccountId={selectedMcc || mccAccounts[0]?.id || ""} onSuccess={handleEditSuccess}
        onCancel={() => setEditModal({ open: false, campaign: null, field: "budget" })}
      />

      {/* ========== D-285 弹窗二：预算异常确认 + 一键调整 ========== */}
      <Modal
        title={<Space><WarningOutlined style={{ color: "#faad14" }} />预算异常：以下系列 Google 实际预算过低</Space>}
        open={budgetFixOpen}
        onCancel={snoozeBudgetFix}
        width={640}
        footer={[
          <Button key="snooze" onClick={snoozeBudgetFix}>今天暂不处理</Button>,
          <Button key="apply" type="primary" loading={budgetFixApplying} onClick={applyBudgetFix}>
            确认调整（{budgetFixRows.length} 条）
          </Button>,
        ]}
      >
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="这些在投系列受历史 bug 影响，Google 上的实际日预算远低于设定意图（如 $2 被发成 ¥2≈$0.28）。"
          description="点「确认调整」后系统会把下列系列的 Google 实际预算改成目标值（按当日汇率折账户币种），并同步更新 CRM。不点则不做任何改动。"
        />
        <Table<BudgetFixRow>
          size="small" rowKey="campaign_id" pagination={false} scroll={{ y: 320 }}
          dataSource={budgetFixRows}
          columns={[
            { title: "广告系列", dataIndex: "campaign_name", ellipsis: true },
            {
              title: "当前实际", dataIndex: "current_usd", width: 130, align: "right",
              render: (v: number, r) => <Text type="danger">${v.toFixed(2)}（{r.current_account} {r.currency}）</Text>,
            },
            {
              title: "调整为", dataIndex: "target_usd", width: 130, align: "right",
              render: (v: number, r) => <Text type="success">${v.toFixed(2)}（{r.target_account} {r.currency}）</Text>,
            },
          ]}
        />
      </Modal>

      {/* ========== D-238 眼睛弹窗：逐日明细 + AI 分析报告 ========== */}
      <CampaignAnalysisModal
        open={analysisModal.open}
        campaignId={analysisModal.campaignId}
        campaignName={analysisModal.campaignName}
        strategy={strategy}
        onClose={() => setAnalysisModal({ open: false, campaignId: null, campaignName: "" })}
        onApplied={refreshAnalysis}
        onReanalyzed={refreshAnalysis}
      />

    </div>
  );
}
