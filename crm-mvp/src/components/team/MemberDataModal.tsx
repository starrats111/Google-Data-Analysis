"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Modal, Table, Row, Col, Statistic, Typography, Spin, Tag, DatePicker, Space, Select, Tooltip, Alert,
} from "antd";
import {
  RiseOutlined, FallOutlined, UserOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

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
  cost: number;
  clicks: number;
  impressions: number;
  cpc: number;
  commission: number;
  rejected_commission: number;
  orders: number;
  roi: number;
  mcc_currency: string;
  cid_removed: boolean;
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

function formatInt(value: number | null | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

function calcNetProfit(commission: number, rejectedCommission: number, cost: number): number {
  return (commission || 0) - (rejectedCommission || 0) - (cost || 0);
}

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

  // 列定义与数据中心（组员视角）逐列对齐，仅去掉组长不应操作的预算/出价/操作列
  const columns = useMemo(() => [
    {
      title: "广告系列", dataIndex: "campaign_name", width: 240,
      render: (v: string) => <Text style={{ fontSize: 12, wordBreak: "break-all" as const, whiteSpace: "normal" as const }}>{v}</Text>,
    },
    {
      title: "状态", dataIndex: "status", width: 100, align: "center" as const,
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
    {
      title: "展示", dataIndex: "impressions", width: 85, align: "right" as const,
      sorter: (a: CampaignRow, b: CampaignRow) => (a.impressions ?? 0) - (b.impressions ?? 0),
      render: (v: number) => <Text style={{ fontSize: 12 }}>{formatInt(v)}</Text>,
    },
    {
      title: "点击", dataIndex: "clicks", width: 75, align: "right" as const,
      sorter: (a: CampaignRow, b: CampaignRow) => (a.clicks ?? 0) - (b.clicks ?? 0),
      render: (v: number) => <Text style={{ fontSize: 12 }}>{formatInt(v)}</Text>,
    },
    {
      title: "平均CPC", dataIndex: "cpc", width: 80, align: "right" as const,
      render: (v: number) => <Text style={{ fontSize: 12 }}>${(v ?? 0).toFixed(4)}</Text>,
    },
    {
      title: "花费", dataIndex: "cost", width: 85, align: "right" as const,
      sorter: (a: CampaignRow, b: CampaignRow) => a.cost - b.cost,
      render: (v: number, r: CampaignRow) => (
        <span>
          <Text style={{ fontSize: 12, color: v > 0 ? "#cf1322" : undefined }}>${(v ?? 0).toFixed(2)}</Text>
          {r.mcc_currency === "CNY" && <Tag color="orange" style={{ fontSize: 9, marginLeft: 2, padding: "0 3px", lineHeight: "14px" }}>CNY</Tag>}
        </span>
      ),
    },
    {
      title: "佣金", dataIndex: "commission", width: 75, align: "right" as const,
      sorter: (a: CampaignRow, b: CampaignRow) => a.commission - b.commission,
      render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#389e0d" : undefined }}>${(v ?? 0).toFixed(2)}</Text>,
    },
    {
      title: "拒付佣金", dataIndex: "rejected_commission", width: 80, align: "right" as const,
      render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"} style={{ fontSize: 12 }}>${(v || 0).toFixed(2)}</Text>,
    },
    {
      title: "净利润", key: "net_profit", width: 85, align: "right" as const,
      sorter: (a: CampaignRow, b: CampaignRow) =>
        calcNetProfit(a.commission, a.rejected_commission, a.cost) - calcNetProfit(b.commission, b.rejected_commission, b.cost),
      render: (_: unknown, r: CampaignRow) => {
        const value = calcNetProfit(r.commission, r.rejected_commission, r.cost);
        return <Text style={{ fontSize: 12, color: value >= 0 ? "#389e0d" : "#cf1322" }}>${value.toFixed(2)}</Text>;
      },
    },
    {
      title: "ROI", dataIndex: "roi", width: 80, align: "right" as const,
      sorter: (a: CampaignRow, b: CampaignRow) => a.roi - b.roi,
      // 无花费时 ROI 无意义（后端给 0），标成「—」避免误读成打平
      render: (v: number, r: CampaignRow) => {
        if (!r.cost) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        const pct = v * 100;
        return (
          <Tag color={pct >= 20 ? "success" : pct >= 0 ? "processing" : "error"} style={{ fontSize: 12 }}>
            {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
          </Tag>
        );
      },
    },
  ], []);

  const title = displayName ? `${displayName} (${username})` : username || "组员";
  const netProfit = calcNetProfit(summary.totalCommission, summary.totalRejectedCommission, summary.totalCost);
  const roiPct = summary.roi * 100;

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
            <Statistic title="ROI" value={roiPct} suffix="%"
              prefix={roiPct >= 0 ? <RiseOutlined /> : <FallOutlined />}
              precision={1}
              styles={{ content: { fontSize: 16, color: roiPct >= 0 ? "#389e0d" : "#cf1322" } }} />
          </Col>
        </Row>

        <Table
          rowKey="id"
          dataSource={rows}
          columns={columns}
          size="small"
          scroll={{ y: 400, x: 900 }}
          pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true, pageSizeOptions: ["20", "50", "100"] }}
          // 合计行取后端 summary（与数据中心同源），不做逐行累加——
          // 逐行加总会漏掉「商家在 CRM 无广告系列」那部分无法归行的佣金。
          summary={() => {
            if (rows.length === 0) return null;
            return (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={2}><Text strong>合计</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right"><Text strong>{formatInt(summary.totalImpressions)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right"><Text strong>{formatInt(summary.totalClicks)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right"><Text strong>${summary.avgCpc.toFixed(4)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right"><Text strong style={{ color: "#cf1322" }}>${summary.totalCost.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right"><Text strong style={{ color: "#389e0d" }}>${summary.totalCommission.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={7} align="right"><Text strong type="danger">${summary.totalRejectedCommission.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={8} align="right">
                    <Text strong style={{ color: netProfit >= 0 ? "#389e0d" : "#cf1322" }}>${netProfit.toFixed(2)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={9} />
                </Table.Summary.Row>
              </Table.Summary>
            );
          }}
        />
      </Spin>
    </Modal>
  );
}
