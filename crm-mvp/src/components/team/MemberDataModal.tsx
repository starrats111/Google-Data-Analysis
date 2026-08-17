"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Modal, Table, Row, Col, Statistic, Typography, Spin, Tag, DatePicker, Space, Select, Tooltip, Alert, Button,
} from "antd";
import {
  RiseOutlined, FallOutlined, UserOutlined, EyeOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  buildMetricColumns, useTableColumnPrefs, ColumnSettingsButton, renderColumnSummary,
  METRIC_COLUMN_LABELS, calcNetProfit,
  type ColumnMetaItem, type TableSummaryTotals,
} from "@/components/data-center/tableColumnPrefs";
import CampaignAnalysisModal, {
  STRATEGY_OPTIONS, formatActionItem, actionColor, type AnalysisItem,
} from "@/components/data-center/CampaignAnalysisModal";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface MemberDataModalProps {
  open: boolean;
  userId: string | null;
  username?: string;
  displayName?: string;
  onClose: () => void;
}

/** 与 /api/user/data-center/campaigns 的 summary 完全同构（D-194 共用查询层） */
interface Summary {
  totalCost: number;
  totalCommission: number;
  totalRejectedCommission: number;
  totalClicks: number;
  totalImpressions: number;
  totalOrders: number;
  avgCpc: number;
  /** 小数口径（0.52 = 52%） */
  roi: number;
  campaignCount: number;
  commissionScope: "filtered" | "mcc" | "all";
}

/** 与数据中心表格行完全同构 */
interface CampaignRow {
  id: string;
  campaign_name: string | null;
  status: string | null;
  customer_id: string | null;
  daily_budget: number;
  max_cpc: number | null;
  cost: number;
  clicks: number;
  impressions: number;
  cpc: number;
  commission: number;
  rejected_commission: number;
  orders: number;
  roi: number;
  mcc_currency: string;
  is_removed: boolean;
  cid_removed: boolean;
  is_budget: number | null;
  is_rank: number | null;
}

interface MccAccount {
  id: string;
  mcc_id: string;
  mcc_name: string;
  currency: string;
}

const EMPTY_SUMMARY: Summary = {
  totalCost: 0, totalCommission: 0, totalRejectedCommission: 0,
  totalClicks: 0, totalImpressions: 0, totalOrders: 0,
  avgCpc: 0, roi: 0, campaignCount: 0, commissionScope: "all",
};

const statusLabels: Record<string, string> = { ENABLED: "启用", PAUSED: "暂停", REMOVED: "移除", active: "启用", paused: "暂停" };
const statusColors: Record<string, string> = { ENABLED: "green", PAUSED: "orange", REMOVED: "red", active: "green", paused: "orange" };

// CID 格式化: 1234567890 → 123-456-7890（与数据中心一致）
function formatCid(cid: string | number): string {
  const s = String(cid).replace(/\D/g, "");
  if (s.length === 10) return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
  return s;
}

// ========== D-239 自定义列展示（列偏好跟随组长本人账号，与数据中心主表共用指标列定义） ==========
const COLUMN_PREFS_TABLE_KEY = "team-member-modal";
const LOCKED_COLUMN_KEYS = ["campaign_name", "status"];
/** 默认列 = 改造前弹窗原有列，组长未配置时零变化 */
const DEFAULT_COLUMN_KEYS = [
  "campaign_name", "status", "impressions", "clicks", "cpc", "epc",
  "cost", "commission", "rejected_commission", "net_profit", "roi",
];
/** D-241：与数据中心 COLUMNS_META 同一份选项与顺序（预算/出价/建议在本弹窗为只读呈现） */
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

export default function MemberDataModal({ open, userId, username, displayName, onClose }: MemberDataModalProps) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [mccAccounts, setMccAccounts] = useState<MccAccount[]>([]);
  const [selectedMcc, setSelectedMcc] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().tz(TZ).startOf("month"),
    dayjs().tz(TZ),
  ]);

  // 切换组员时重置筛选，避免把上一个组员的 MCC 选择带过去
  useEffect(() => {
    setSelectedMcc("");
    setStatusFilter("all");
  }, [userId]);

  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    const fetchData = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          userId,
          date_start: dateRange[0].format("YYYY-MM-DD"),
          date_end: dateRange[1].format("YYYY-MM-DD"),
        });
        if (selectedMcc) params.set("mcc_account_id", selectedMcc);
        if (statusFilter !== "all") params.set("status", statusFilter);
        const res = await fetch(`/api/user/team/member-data?${params}`).then((r) => r.json());
        if (cancelled) return;
        if (res.code === 0) {
          setSummary(res.data.summary || EMPTY_SUMMARY);
          setRows(res.data.rows || []);
          setMccAccounts(res.data.mccAccounts || []);
        }
      } catch (e) {
        console.error("加载组员数据失败:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    return () => { cancelled = true; };
  }, [open, userId, dateRange, selectedMcc, statusFilter]);

  // D-239：列偏好跟随组长本人账号；指标列与数据中心主表共用同一份定义（防两处漂移）
  const { visibleKeys, save: saveColumnPrefs, reset: resetColumnPrefs } = useTableColumnPrefs({
    tableKey: COLUMN_PREFS_TABLE_KEY,
    allKeys: ALL_COLUMN_KEYS,
    lockedKeys: LOCKED_COLUMN_KEYS,
    defaultKeys: DEFAULT_COLUMN_KEYS,
  });

  // ========== D-241 组员 AI 建议（只读缓存，不触发分析、不提供执行） ==========
  const [strategy, setStrategy] = useState("balanced");
  const [analysisMap, setAnalysisMap] = useState<Record<string, AnalysisItem>>({});
  const [analysisModal, setAnalysisModal] = useState<{ open: boolean; campaignId: string | null; campaignName: string }>({ open: false, campaignId: null, campaignName: "" });
  const rowIdsKey = useMemo(() => rows.map((r) => r.id).join(","), [rows]);
  const wantsAiColumns = visibleKeys.includes("ai_suggestion") || visibleKeys.includes("ai_detail");

  useEffect(() => {
    // 只在勾选了建议/分析列时才拉缓存，未勾选零开销
    if (!rowIdsKey || !wantsAiColumns) { setAnalysisMap({}); return; }
    const ids = rowIdsKey.split(",");
    let cancelled = false;
    (async () => {
      const map: Record<string, AnalysisItem> = {};
      // 分批防 URL 过长（与数据中心一致）
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
  }, [rowIdsKey, strategy, wantsAiColumns]);

  const columnRegistry: Record<string, ColumnsType<CampaignRow>[number]> = useMemo(() => ({
    ...buildMetricColumns<CampaignRow>(),
    campaign_name: {
      key: "campaign_name",
      title: "广告系列", dataIndex: "campaign_name", width: 240, fixed: "left",
      render: (v: string) => <Text style={{ fontSize: 12, wordBreak: "break-all" as const, whiteSpace: "normal" as const }}>{v}</Text>,
    },
    status: {
      key: "status",
      title: "状态", dataIndex: "status", width: 100, align: "center",
      render: (v: string, r: CampaignRow) => (
        <Space size={4}>
          <Tag color={statusColors[v] || "default"} style={{ fontSize: 11, margin: 0 }}>{statusLabels[v] || v}</Tag>
          {r.cid_removed && v !== "REMOVED" && (
            <Tooltip title="所属 CID 已移除/停用">
              <Tag color="red" style={{ fontSize: 10, margin: 0 }}>CID已移除</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    // ===== D-241 与数据中心对齐的补充列（本弹窗为只读，不提供改预算/改出价/执行建议） =====
    customer_id: {
      key: "customer_id",
      title: "CID", dataIndex: "customer_id", width: 110,
      render: (v: string, r: CampaignRow) => {
        const removed = r.is_removed || r.cid_removed;
        return (
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            <Text copyable={{ text: v }} style={{ fontSize: 12, margin: 0, color: removed ? "#cf1322" : undefined }}>
              {formatCid(v)}
            </Text>
            {r.cid_removed && (
              <Tooltip title="该 CID 已移除/停用">
                <span style={{ color: "#cf1322", marginLeft: 4, fontSize: 11 }}>●</span>
              </Tooltip>
            )}
          </span>
        );
      },
    },
    daily_budget: {
      key: "daily_budget",
      title: "预算", dataIndex: "daily_budget", width: 70, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12 }}>${(v ?? 0).toFixed(2)}</Text>,
    },
    max_cpc: {
      key: "max_cpc",
      title: "最高出价", dataIndex: "max_cpc", width: 90, align: "right",
      render: (v: number | null) => <Text style={{ fontSize: 12 }}>${(v ?? 0).toFixed(4)}</Text>,
    },
    ai_suggestion: {
      key: "ai_suggestion",
      title: (
        <Tooltip title="组员账号的 AI 分析建议缓存（只读），执行由组员在自己数据中心操作">
          <span>操作建议</span>
        </Tooltip>
      ),
      width: 150,
      render: (_: unknown, r: CampaignRow) => {
        const actions = analysisMap[r.id]?.actionItems || [];
        if (actions.length === 0) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        return (
          <Space size={4} wrap>
            {actions.slice(0, 2).map((a, i) => (
              <Tooltip key={i} title={analysisMap[r.id]?.summary || undefined}>
                <Tag color={actionColor(a.type)} style={{ fontSize: 11, margin: 0 }}>{formatActionItem(a)}</Tag>
              </Tooltip>
            ))}
          </Space>
        );
      },
    },
    ai_detail: {
      key: "ai_detail",
      title: "分析", width: 55, align: "center",
      render: (_: unknown, r: CampaignRow) => (
        <Tooltip title="查看逐日明细与 AI 分析报告（只读）">
          <Button
            type="text" size="small" icon={<EyeOutlined style={{ color: "#1677ff" }} />}
            style={{ padding: 0, height: 22, width: 22 }}
            onClick={() => setAnalysisModal({ open: true, campaignId: r.id, campaignName: r.campaign_name || "" })}
          />
        </Tooltip>
      ),
    },
  }), [analysisMap]);

  const columns = useMemo(
    () => visibleKeys.map((k) => columnRegistry[k]).filter((c): c is ColumnsType<CampaignRow>[number] => Boolean(c)),
    [visibleKeys, columnRegistry],
  );
  const tableScrollX = columns.reduce((sum, c) => sum + (typeof c.width === "number" ? c.width : 100), 0);

  const title = displayName ? `${displayName} (${username})` : username || "组员";
  const netProfit = calcNetProfit(summary.totalCommission, summary.totalRejectedCommission, summary.totalCost);

  return (
    <Modal
      title={<><UserOutlined style={{ marginRight: 8 }} />{title} — 数据看板</>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={1100}
      destroyOnHidden
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Text>日期范围：</Text>
        <RangePicker
          value={dateRange}
          onChange={(v) => { if (v?.[0] && v?.[1]) setDateRange([v[0], v[1]]); }}
          size="small"
        />
        <Select
          placeholder="所有 MCC" allowClear style={{ width: 180 }} size="small"
          value={selectedMcc || undefined}
          onChange={(v) => setSelectedMcc(v || "")}
          options={mccAccounts.map((m) => ({ value: m.id, label: `${m.mcc_name || m.mcc_id} (${m.currency})` }))}
        />
        <Select
          placeholder="广告状态" allowClear style={{ width: 100 }} size="small"
          value={statusFilter !== "all" ? statusFilter : undefined}
          onChange={(v) => setStatusFilter(v || "all")}
          options={[
            { value: "ENABLED", label: "启用" },
            { value: "PAUSED", label: "暂停" },
            { value: "REMOVED", label: "移除" },
          ]}
        />
        {wantsAiColumns && (
          <Tooltip title="AI 建议策略口径（读组员对应策略的分析缓存）">
            <Select size="small" value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} style={{ width: 90 }} />
          </Tooltip>
        )}
        <ColumnSettingsButton
          columnsMeta={COLUMNS_META}
          lockedKeys={LOCKED_COLUMN_KEYS}
          visibleKeys={visibleKeys}
          onSave={saveColumnPrefs}
          onReset={resetColumnPrefs}
        />
      </Space>

      {summary.commissionScope === "all" && mccAccounts.length > 1 && (
        <Alert
          type="info" showIcon banner style={{ marginBottom: 12, fontSize: 12 }}
          message={`该组员有 ${mccAccounts.length} 个 MCC，当前为「全部 MCC」口径。组员若在数据中心选了单个 MCC，佣金会切换成该 MCC 归属口径，两边核对时请选同一个 MCC。`}
        />
      )}

      <Spin spinning={loading}>
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          <Col span={4}>
            <Statistic title="总花费" value={summary.totalCost} prefix="$" precision={2}
              styles={{ content: { fontSize: 16, color: "#cf1322" } }} />
          </Col>
          <Col span={4}>
            <Statistic title="总佣金" value={summary.totalCommission} prefix="$" precision={2}
              styles={{ content: { fontSize: 16, color: "#389e0d" } }} />
          </Col>
          <Col span={4}>
            <Statistic title="拒付佣金" value={summary.totalRejectedCommission} prefix="$" precision={2}
              styles={{ content: { fontSize: 16, color: "#ff4d4f" } }} />
          </Col>
          <Col span={4}>
            <Statistic title="净利润" value={netProfit} prefix="$" precision={2}
              styles={{ content: { fontSize: 16, color: netProfit >= 0 ? "#389e0d" : "#cf1322" } }} />
          </Col>
          <Col span={3}>
            <Statistic title="点击数" value={summary.totalClicks}
              styles={{ content: { fontSize: 16 } }} />
          </Col>
          <Col span={5}>
            <Statistic title="ROI" value={summary.roi}
              prefix={summary.roi >= 0 ? <RiseOutlined /> : <FallOutlined />}
              precision={2}
              styles={{ content: { fontSize: 16, color: summary.roi >= 0 ? "#389e0d" : "#cf1322" } }} />
          </Col>
        </Row>

        <Table
          rowKey="id"
          dataSource={rows}
          columns={columns}
          size="small"
          scroll={{ y: 400, x: tableScrollX }}
          pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true, pageSizeOptions: ["20", "50", "100"] }}
          // 合计行取后端 summary（与数据中心同源），不做逐行累加——
          // 逐行加总会漏掉「商家在 CRM 无广告系列」那部分无法归行的佣金。
          // D-239：合计行按可见列 key 对齐，列怎么排合计就怎么对齐
          summary={() => {
            if (rows.length === 0) return null;
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
      </Spin>

      {/* D-241 只读版分析弹窗：逐日明细 + 组员的 AI 分析报告，无重新分析/一键执行 */}
      <CampaignAnalysisModal
        open={analysisModal.open}
        campaignId={analysisModal.campaignId}
        campaignName={analysisModal.campaignName}
        strategy={strategy}
        readOnly
        onClose={() => setAnalysisModal({ open: false, campaignId: null, campaignName: "" })}
      />
    </Modal>
  );
}
