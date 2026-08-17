"use client";

/**
 * D-245 组长「复盘分析」：已暂停系列的暂停前 7 天数据复盘
 *
 * 口径（07 拍板）：
 * - 范围 = 本组组员、当前 PAUSED / REMOVED 且有暂停记录的系列；重新启用的自动移出
 * - 7 天窗口 = 暂停日前 7 个完整投放日（不含暂停当天），实时查 ads_daily_stats
 * - 固定列：CID / 广告系列 / 暂停日期 / 投放人员 / 复盘（眼睛）；
 *   指标列复用共享列设置（tableColumnPrefs，7 天合计），另有暂停原因 / 日预算 / 投放天数扩展列
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card, Table, Tag, Typography, Space, DatePicker, Select, Button, Tooltip, Alert, App,
  Row, Col, Statistic,
} from "antd";
import { HistoryOutlined, ReloadOutlined, EyeOutlined, RiseOutlined, FallOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import AppPageHeader from "@/components/AppPageHeader";
import ReviewAnalysisModal from "@/components/team/ReviewAnalysisModal";
import {
  buildMetricColumns, useTableColumnPrefs, ColumnSettingsButton, renderColumnSummary,
  METRIC_COLUMN_LABELS, calcNetProfit,
  type ColumnMetaItem, type TableSummaryTotals,
} from "@/components/data-center/tableColumnPrefs";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface ReviewRow {
  id: string;
  campaign_name: string | null;
  customer_id: string | null;
  google_status: string;
  paused_at: string;
  pause_date: string;
  pause_source: string | null;
  pause_source_label: string;
  window_start: string;
  window_end: string;
  user_id: string;
  username: string;
  display_name: string | null;
  daily_budget: number;
  active_days: number;
  cost: number;
  clicks: number;
  impressions: number;
  cpc: number;
  orders: number;
  commission: number;
  rejected_commission: number;
  roi: number;
  is_budget: number | null;
  is_rank: number | null;
}

interface Member {
  id: string;
  username: string;
  display_name: string | null;
}

interface Summary {
  totalImpressions: number;
  totalClicks: number;
  totalOrders: number;
  avgCpc: number;
  totalCost: number;
  totalCommission: number;
  totalRejectedCommission: number;
  roi: number;
  campaignCount: number;
}

const EMPTY_SUMMARY: Summary = {
  totalImpressions: 0, totalClicks: 0, totalOrders: 0, avgCpc: 0,
  totalCost: 0, totalCommission: 0, totalRejectedCommission: 0, roi: 0, campaignCount: 0,
};

const statusLabels: Record<string, string> = { PAUSED: "暂停", REMOVED: "移除" };
const statusColors: Record<string, string> = { PAUSED: "orange", REMOVED: "red" };
const sourceColors: Record<string, string> = {
  manual: "blue", spend_guard: "volcano", ai_apply: "purple", sync: "default",
  change_history: "green", backfill: "default",
};
// 暂停时间为近似值的来源（标 ≈）：sync=同步发现时刻（最多晚一天）、backfill=按最后消费日推算；
// 每日同步会用 Google 变更历史把近几天的近似值修正为精确时间（→ change_history）
const APPROX_SOURCES = new Set(["sync", "backfill"]);

// CID 格式化: 1234567890 → 123-456-7890（与数据中心一致）
function formatCid(cid: string | number): string {
  const s = String(cid).replace(/\D/g, "");
  if (s.length === 10) return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
  return s;
}

// ========== 列设置（固定列固化，指标列与数据中心共用定义） ==========
const COLUMN_PREFS_TABLE_KEY = "team-review-analysis";
const LOCKED_COLUMN_KEYS = ["customer_id", "campaign_name", "pause_date", "member"];
const DEFAULT_COLUMN_KEYS = [
  ...LOCKED_COLUMN_KEYS,
  "pause_source", "impressions", "clicks", "cpc", "epc",
  "cost", "commission", "rejected_commission", "net_profit", "roi",
];
const COLUMNS_META: ColumnMetaItem[] = [
  { key: "customer_id", label: "CID" },
  { key: "campaign_name", label: "广告系列" },
  { key: "pause_date", label: "暂停日期" },
  { key: "member", label: "投放人员" },
  { key: "google_status", label: "当前状态" },
  { key: "pause_source", label: "暂停原因" },
  { key: "daily_budget", label: "日预算" },
  { key: "active_days", label: "投放天数" },
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
];
const ALL_COLUMN_KEYS = COLUMNS_META.map((m) => m.key);

export default function ReviewAnalysisPage() {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [truncated, setTruncated] = useState(false);
  const [memberFilter, setMemberFilter] = useState<string>("");
  // 默认看最近 30 天暂停的系列
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().tz(TZ).subtract(29, "day"),
    dayjs().tz(TZ),
  ]);
  const [modal, setModal] = useState<{ open: boolean; campaignId: string | null; campaignName: string }>({
    open: false, campaignId: null, campaignName: "",
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        paused_start: dateRange[0].format("YYYY-MM-DD"),
        paused_end: dateRange[1].format("YYYY-MM-DD"),
      });
      if (memberFilter) params.set("member_id", memberFilter);
      const res = await fetch(`/api/user/team/review?${params}`).then((r) => r.json());
      if (res.code === 0) {
        setRows(res.data.rows || []);
        setMembers(res.data.members || []);
        setSummary(res.data.summary || EMPTY_SUMMARY);
        setTruncated(Boolean(res.data.truncated));
      } else {
        message.error(res.message || "复盘数据加载失败");
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setLoading(false);
    }
  }, [dateRange, memberFilter, message]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const { visibleKeys, save: saveColumnPrefs, reset: resetColumnPrefs } = useTableColumnPrefs({
    tableKey: COLUMN_PREFS_TABLE_KEY,
    allKeys: ALL_COLUMN_KEYS,
    lockedKeys: LOCKED_COLUMN_KEYS,
    defaultKeys: DEFAULT_COLUMN_KEYS,
  });

  const columnRegistry: Record<string, ColumnsType<ReviewRow>[number]> = useMemo(() => ({
    ...buildMetricColumns<ReviewRow>(),
    customer_id: {
      key: "customer_id",
      title: "CID", dataIndex: "customer_id", width: 110, fixed: "left",
      render: (v: string | null) => v
        ? <Text copyable={{ text: v }} style={{ fontSize: 12, margin: 0 }}>{formatCid(v)}</Text>
        : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    campaign_name: {
      key: "campaign_name",
      title: "广告系列", dataIndex: "campaign_name", width: 230, fixed: "left",
      render: (v: string | null, r: ReviewRow) => (
        <Space size={4} wrap>
          <Text style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>{v || r.id}</Text>
          {r.google_status === "REMOVED" && (
            <Tag color={statusColors.REMOVED} style={{ fontSize: 10, margin: 0 }}>已移除</Tag>
          )}
        </Space>
      ),
    },
    pause_date: {
      key: "pause_date",
      title: <Tooltip title="系列被置为暂停的日期（东八区）。窗口 = 该日前 7 个完整投放日"><span>暂停日期</span></Tooltip>,
      dataIndex: "pause_date", width: 105, align: "center",
      sorter: (a, b) => a.paused_at.localeCompare(b.paused_at),
      defaultSortOrder: "descend" as const,
      render: (v: string, r: ReviewRow) => (
        <Tooltip title={`${dayjs(r.paused_at).tz(TZ).format("YYYY-MM-DD HH:mm")}${APPROX_SOURCES.has(r.pause_source || "") ? "（近似值，每日同步会以 Google 变更记录自动修正）" : ""}`}>
          <Text style={{ fontSize: 12 }}>
            {v}{APPROX_SOURCES.has(r.pause_source || "") && <Text type="secondary" style={{ fontSize: 11 }}>≈</Text>}
          </Text>
        </Tooltip>
      ),
    },
    member: {
      key: "member",
      title: "投放人员", width: 100,
      render: (_: unknown, r: ReviewRow) => (
        <Text style={{ fontSize: 12 }}>{r.display_name || r.username}</Text>
      ),
    },
    google_status: {
      key: "google_status",
      title: "当前状态", dataIndex: "google_status", width: 85, align: "center",
      render: (v: string) => (
        <Tag color={statusColors[v] || "default"} style={{ fontSize: 11, margin: 0 }}>{statusLabels[v] || v}</Tag>
      ),
    },
    pause_source: {
      key: "pause_source",
      title: <Tooltip title="暂停由谁触发：手动 / 花费哨兵止损 / AI 建议执行 / 同步发现(≈近似) / 谷歌记录(精确) / 历史回填(≈近似)"><span>暂停原因</span></Tooltip>,
      width: 110, align: "center",
      render: (_: unknown, r: ReviewRow) => (
        <Tag color={sourceColors[r.pause_source || ""] || "default"} style={{ fontSize: 11, margin: 0 }}>
          {r.pause_source_label}
        </Tag>
      ),
    },
    daily_budget: {
      key: "daily_budget",
      title: "日预算", dataIndex: "daily_budget", width: 75, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12 }}>${(v ?? 0).toFixed(2)}</Text>,
    },
    active_days: {
      key: "active_days",
      title: <Tooltip title="暂停前累计有消费的天数（全历史）"><span>投放天数</span></Tooltip>,
      dataIndex: "active_days", width: 90, align: "right",
      sorter: (a, b) => a.active_days - b.active_days,
      render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text>,
    },
  }), []);

  const reviewColumn: ColumnsType<ReviewRow>[number] = useMemo(() => ({
    key: "review",
    title: "复盘", width: 55, align: "center", fixed: "right",
    render: (_: unknown, r: ReviewRow) => (
      <Tooltip title="查看暂停前 7 天逐日数据、趋势图与 AI 复盘点评">
        <Button
          type="text" size="small" icon={<EyeOutlined style={{ color: "#1677ff" }} />}
          style={{ padding: 0, height: 22, width: 22 }}
          onClick={() => setModal({ open: true, campaignId: r.id, campaignName: r.campaign_name || "" })}
        />
      </Tooltip>
    ),
  }), []);

  const columns = useMemo(() => {
    const cols = visibleKeys
      .map((k) => columnRegistry[k])
      .filter((col): col is ColumnsType<ReviewRow>[number] => Boolean(col));
    return [...cols, reviewColumn];
  }, [visibleKeys, columnRegistry, reviewColumn]);
  const tableScrollX = columns.reduce((sum, col) => sum + (typeof col.width === "number" ? col.width : 100), 0);

  const netProfit = calcNetProfit(summary.totalCommission, summary.totalRejectedCommission, summary.totalCost);

  return (
    <div>
      <AppPageHeader
        icon={<HistoryOutlined />}
        title="复盘分析"
        subtitle="已暂停广告系列的「暂停前 7 个完整投放日」数据（不含暂停当天，实时口径）；重新启用的系列自动移出"
        extra={<Button icon={<ReloadOutlined />} size="small" loading={loading} onClick={fetchData}>刷新</Button>}
      />

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Text style={{ fontSize: 13 }}>暂停日期：</Text>
          <RangePicker
            value={dateRange}
            onChange={(v) => { if (v?.[0] && v?.[1]) setDateRange([v[0], v[1]]); }}
            size="small"
            allowClear={false}
            presets={[
              { label: "最近7天", value: [dayjs().tz(TZ).subtract(6, "day"), dayjs().tz(TZ)] },
              { label: "最近30天", value: [dayjs().tz(TZ).subtract(29, "day"), dayjs().tz(TZ)] },
              { label: "最近90天", value: [dayjs().tz(TZ).subtract(89, "day"), dayjs().tz(TZ)] },
            ]}
          />
          <Select
            placeholder="全部组员" allowClear style={{ width: 150 }} size="small"
            value={memberFilter || undefined}
            onChange={(v) => setMemberFilter(v || "")}
            options={members.map((m) => ({ value: m.id, label: m.display_name || m.username }))}
            showSearch
            optionFilterProp="label"
          />
          <ColumnSettingsButton
            columnsMeta={COLUMNS_META}
            lockedKeys={LOCKED_COLUMN_KEYS}
            visibleKeys={visibleKeys}
            onSave={saveColumnPrefs}
            onReset={resetColumnPrefs}
          />
        </Space>
      </Card>

      {truncated && (
        <Alert
          type="warning" showIcon banner style={{ marginBottom: 12, fontSize: 12 }}
          message="结果超过 500 条，仅显示暂停时间最近的 500 条，请缩小暂停日期范围或选择组员后再看。"
        />
      )}

      <Card size="small">
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          <Col span={4}>
            <Statistic title="复盘系列数" value={summary.campaignCount}
              styles={{ content: { fontSize: 16 } }} />
          </Col>
          <Col span={4}>
            <Statistic title="7天总花费" value={summary.totalCost} prefix="$" precision={2}
              styles={{ content: { fontSize: 16, color: "#cf1322" } }} />
          </Col>
          <Col span={4}>
            <Statistic title="7天总佣金" value={summary.totalCommission} prefix="$" precision={2}
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
          <Col span={4}>
            <Statistic title="ROI" value={summary.roi} precision={2}
              prefix={summary.roi >= 0 ? <RiseOutlined /> : <FallOutlined />}
              styles={{ content: { fontSize: 16, color: summary.roi >= 0 ? "#389e0d" : "#cf1322" } }} />
          </Col>
        </Row>

        <Table<ReviewRow>
          rowKey="id"
          dataSource={rows}
          columns={columns}
          size="small"
          loading={loading}
          scroll={{ x: tableScrollX }}
          pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true, pageSizeOptions: ["20", "50", "100"] }}
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
      </Card>

      <ReviewAnalysisModal
        open={modal.open}
        campaignId={modal.campaignId}
        campaignName={modal.campaignName}
        onClose={() => setModal({ open: false, campaignId: null, campaignName: "" })}
      />
    </div>
  );
}
