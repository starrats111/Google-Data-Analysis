"use client";

import { useState, useMemo, useCallback } from "react";
import {
  Card, Table, Row, Col, Statistic, Select, Space, Typography, Tag, Button,
  Dropdown, DatePicker, Tooltip, App, Input, Modal,
} from "antd";
import {
  RiseOutlined, FallOutlined, SyncOutlined,
  CloudDownloadOutlined, TableOutlined, EditOutlined, SearchOutlined,
  PlayCircleOutlined, PauseCircleOutlined, RedoOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { COLORS } from "@/styles/themeConfig";
import { PLATFORMS } from "@/lib/constants";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import EditCampaignModal from "@/components/data-center/EditCampaignModal";
import { useStaleApi, useApiWithParams, refreshApi } from "@/lib/swr";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

interface MccAccount { id: string; mcc_id: string; mcc_name: string; currency: string; }

interface CampaignRow {
  id: string; google_campaign_id: string; customer_id: string; campaign_name: string;
  status: string; daily_budget: number; max_cpc: number | null;
  cost: number; clicks: number; impressions: number; cpc: number;
  commission: number; rejected_commission: number; approved_commission: number; orders: number; roi: number;
  target_country: string; last_synced: string | null;
}

interface Summary {
  totalCost: number; totalCommission: number; totalRejectedCommission: number; totalApprovedCommission: number;
  totalClicks: number; totalImpressions: number;
  avgCpc: number; roi: number; campaignCount: number; enabledCount: number; pausedCount: number;
}

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
  const { message } = App.useApp();
  const [selectedMcc, setSelectedMcc] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [platformFilter, setPlatformFilter] = useState<string>("");
  const [midFilter, setMidFilter] = useState<string>("");
  const [searchFilter, setSearchFilter] = useState<string>("");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([defaultStartDate, defaultEndDate]);
  const [syncing, setSyncing] = useState(false);
  const [editModal, setEditModal] = useState<{ open: boolean; campaign: CampaignRow | null; field: "budget" | "max_cpc" }>({ open: false, campaign: null, field: "budget" });
  const [detailModal, setDetailModal] = useState(false);
  const [commissionModal, setCommissionModal] = useState(false);
  const [commissionByAccount, setCommissionByAccount] = useState<{
    account_name: string; platform: string; total_commission: number;
    rejected_commission: number; pending_commission: number; order_count: number; order_amount: number;
  }[]>([]);
  const [loadingCommission, setLoadingCommission] = useState(false);

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

  const { data: campaignData, isLoading } = useApiWithParams<{ rows: CampaignRow[]; summary: Summary }>(
    "/api/user/data-center/campaigns", queryParams
  );

  const rows = campaignData?.rows || [];
  const summary = campaignData?.summary || {
    totalCost: 0, totalCommission: 0, totalRejectedCommission: 0, totalApprovedCommission: 0,
    totalClicks: 0, totalImpressions: 0, avgCpc: 0, roi: 0, campaignCount: 0, enabledCount: 0, pausedCount: 0,
  };

  // 按广告系列汇总花费和佣金
  const detailByRow = useMemo(() => {
    return rows.map((r) => ({
      id: r.id,
      campaign_name: r.campaign_name,
      cost: r.cost,
      commission: r.commission,
      rejected_commission: r.rejected_commission || 0,
      approved_commission: r.approved_commission || 0,
    }));
  }, [rows]);

  // 一键同步：广告数据 + 联盟交易（合并为单个操作）
  const handleSync = useCallback(async (forceFullSync = false) => {
    if (mccAccounts.length === 0) { message.warning("请先添加 MCC 账户"); return; }
    setSyncing(true);
    try {
      const idsToSync = selectedMcc ? [selectedMcc] : mccAccounts.map((m) => m.id);
      let successCount = 0;
      const errors: string[] = [];

      for (const mccId of idsToSync) {
        const res = await fetch("/api/user/data-center/sync", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "all", mcc_account_id: mccId, force_full_sync: forceFullSync }),
        }).then((r) => r.json());
        if (res.code === 0) successCount++;
        else errors.push(res.message);
      }

      if (successCount > 0) {
        message.success(`${successCount} 个 MCC ${forceFullSync ? "全量" : ""}同步完成${errors.length > 0 ? `，${errors.length} 个失败` : ""}`);
        refreshApi(/\/api\/user\/data-center/);
      } else {
        message.error(errors[0] || "同步失败");
      }
    } finally { setSyncing(false); }
  }, [selectedMcc, mccAccounts, message]);

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
    } finally { setSyncingCid(false); }
  }, [selectedMcc, mccAccounts, message]);

  const handleOpenCommissionModal = useCallback(async () => {
    setCommissionModal(true);
    setLoadingCommission(true);
    try {
      const params = new URLSearchParams({
        date_start: dateRange[0].format("YYYY-MM-DD"),
        date_end: dateRange[1].format("YYYY-MM-DD"),
      });
      const res = await fetch(`/api/user/data-center/commission-by-account?${params}`).then((r) => r.json());
      if (res.code === 0) setCommissionByAccount(res.data || []);
    } finally { setLoadingCommission(false); }
  }, [dateRange]);

  const handleEditSuccess = useCallback(() => {
    setEditModal({ open: false, campaign: null, field: "budget" });
    refreshApi(/\/api\/user\/data-center/);
  }, []);

  // 重新发布广告
  const [republishingId, setRepublishingId] = useState<string | null>(null);
  const handleRepublish = useCallback(async (row: CampaignRow) => {
    if (!row.google_campaign_id) { message.warning("该广告系列尚未提交到 Google Ads"); return; }
    Modal.confirm({
      title: "重新发布广告",
      content: `确定要移除旧广告「${row.campaign_name}」并重新发布吗？旧广告将从 Google Ads 中移除。`,
      okText: "确定重新发布",
      cancelText: "取消",
      onOk: async () => {
        setRepublishingId(row.id);
        try {
          const res = await fetch("/api/user/ad-creation/republish", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign_id: row.id }),
          }).then((r) => r.json());
          if (res.code === 0) {
            message.success("旧广告已移除，正在跳转到广告预览页重新提交...");
            refreshApi(/\/api\/user\/data-center/);
            window.open(`/user/ad-preview/${row.id}`, "_blank");
          } else message.error(res.message);
        } finally { setRepublishingId(null); }
      },
    });
  }, [message]);

  // 切换广告状态
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const handleToggleStatus = useCallback(async (row: CampaignRow) => {
    if (!row.google_campaign_id) { message.warning("该广告系列尚未提交到 Google Ads"); return; }
    const action = row.status === "ENABLED" ? "pause" : "enable";
    setTogglingId(row.id);
    try {
      const res = await fetch("/api/user/data-center/campaigns/toggle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: row.id, action }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || `广告已${action === "enable" ? "启用" : "暂停"}`);
        refreshApi(/\/api\/user\/data-center/);
      } else message.error(res.message);
    } finally { setTogglingId(null); }
  }, [message]);

  const statusColors: Record<string, string> = { ENABLED: "green", PAUSED: "orange", REMOVED: "red" };
  const statusLabels: Record<string, string> = { ENABLED: "已启用", PAUSED: "已暂停", REMOVED: "已移除" };

  const columns: ColumnsType<CampaignRow> = [
    {
      title: "CID", dataIndex: "customer_id", width: 110, fixed: "left",
      render: (v: string) => <Text copyable={{ text: v }} style={{ fontSize: 12 }}>{formatCid(v)}</Text>,
    },
    {
      title: "广告系列", dataIndex: "campaign_name", width: 280, fixed: "left",
      render: (v: string) => (
        <Text style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal", lineHeight: "1.4" }}>{v}</Text>
      ),
    },
    {
      title: "状态", dataIndex: "status", width: 100, align: "center",
      render: (v: string, r: CampaignRow) => (
        <Space size={4}>
          <Tag color={statusColors[v] || "default"} style={{ fontSize: 11, margin: 0 }}>{statusLabels[v] || v}</Tag>
          {v !== "REMOVED" && r.google_campaign_id && (
            <Tooltip title={v === "ENABLED" ? "暂停广告" : "启用广告"}>
              <Button
                type="text" size="small"
                loading={togglingId === r.id}
                icon={v === "ENABLED" ? <PauseCircleOutlined style={{ color: "#faad14" }} /> : <PlayCircleOutlined style={{ color: "#52c41a" }} />}
                onClick={() => handleToggleStatus(r)}
                style={{ padding: 0, height: 20, width: 20 }}
              />
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "预算", dataIndex: "daily_budget", width: 70, align: "right",
      render: (v: number, r: CampaignRow) => (
        <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }}
          onClick={() => setEditModal({ open: true, campaign: r, field: "budget" })}>
          ${v?.toFixed(2)} <EditOutlined style={{ fontSize: 10 }} />
        </Button>
      ),
    },
    {
      title: "最高出价", dataIndex: "max_cpc", width: 90, align: "right",
      render: (v: number | null, r: CampaignRow) => (
        <Button type="link" size="small" style={{ padding: 0, fontSize: 12 }}
          onClick={() => setEditModal({ open: true, campaign: r, field: "max_cpc" })}>
          ${(v ?? 0).toFixed(4)} <EditOutlined style={{ fontSize: 10 }} />
        </Button>
      ),
    },
    {
      title: "平均CPC", dataIndex: "cpc", width: 80, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12 }}>${v?.toFixed(4)}</Text>,
    },
    {
      title: "花费", dataIndex: "cost", width: 70, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#cf1322" : undefined }}>${v?.toFixed(2)}</Text>,
    },
    {
      title: "佣金", dataIndex: "commission", width: 70, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#389e0d" : undefined }}>${v?.toFixed(2)}</Text>,
    },
    {
      title: "拒付佣金", dataIndex: "rejected_commission", width: 80, align: "right",
      render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"} style={{ fontSize: 12 }}>${(v || 0).toFixed(2)}</Text>,
    },
    {
      title: "已确认佣金", dataIndex: "approved_commission", width: 80, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#1890ff" : undefined }}>${(v || 0).toFixed(2)}</Text>,
    },
    {
      title: "点击", dataIndex: "clicks", width: 55, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: "展示", dataIndex: "impressions", width: 55, align: "right",
      render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: "操作", width: 80, align: "center", fixed: "right",
      render: (_: unknown, r: CampaignRow) => (
        r.google_campaign_id ? (
          <Tooltip title="移除旧广告并重新发布">
            <Button
              type="link" size="small"
              loading={republishingId === r.id}
              icon={<RedoOutlined />}
              onClick={() => handleRepublish(r)}
              style={{ fontSize: 12 }}
            >
              重发
            </Button>
          </Tooltip>
        ) : null
      ),
    },
  ];

  return (
    <div>
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
              <Tooltip title="增量同步广告数据和联盟交易佣金">
                <Button type="primary" size="small" icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={() => handleSync(false)}>
                  {syncing ? "同步中..." : "重新同步"}
                </Button>
              </Tooltip>
              <Tooltip title="从 MCC 创建时间开始全量重新拉取所有数据（耗时较长）">
                <Button size="small" icon={<CloudDownloadOutlined />} loading={syncing} onClick={() => {
                  Modal.confirm({
                    title: "全量重新同步",
                    content: "将从 MCC 创建时间起重新拉取所有广告数据和交易佣金，耗时较长，确定继续？",
                    okText: "确定", cancelText: "取消",
                    onOk: () => handleSync(true),
                  });
                }}>全量同步</Button>
              </Tooltip>
              <Button size="small" icon={<CloudDownloadOutlined />} loading={syncingCid} onClick={handleSyncCids}>同步 CID</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* ========== 统计卡片（精简：总花费 + 总佣金 + 拒付佣金） ========== */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} sm={8} md={8}>
          <Card size="small" styles={{ body: { padding: "8px 12px", cursor: "pointer" } }} hoverable onClick={() => setDetailModal(true)}>
            <Statistic title="总花费" value={summary.totalCost} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: "#cf1322" } }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={8}>
          <Card size="small" styles={{ body: { padding: "8px 12px", cursor: "pointer" } }} hoverable onClick={handleOpenCommissionModal}>
            <Statistic title="总佣金" value={summary.totalCommission} prefix="$" precision={2}
              suffix={<Text style={{ fontSize: 11, color: "#999" }}>点击查看详情</Text>}
              styles={{ content: { fontSize: 18, color: "#389e0d" } }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={8}>
          <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
            <Statistic title="拒付佣金" value={summary.totalRejectedCommission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: summary.totalRejectedCommission > 0 ? "#cf1322" : undefined } }} />
          </Card>
        </Col>
      </Row>

      {/* ========== 广告系列表格 ========== */}
      <Card size="small" styles={{ body: { padding: "0 8px 8px" } }}>
        <Table<CampaignRow>
          rowKey="id" loading={isLoading} dataSource={rows} columns={columns}
          size="small" scroll={{ x: 1040 }}
          pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 条`, showSizeChanger: true, pageSizeOptions: ["20", "50", "100"] }}
          summary={() => {
            if (rows.length === 0) return null;
            return (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={3}><Text strong>合计</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={3} />
                  <Table.Summary.Cell index={4} />
                  <Table.Summary.Cell index={5} align="right"><Text strong>${summary.avgCpc.toFixed(4)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right"><Text strong style={{ color: "#cf1322" }}>${summary.totalCost.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={7} align="right"><Text strong style={{ color: "#389e0d" }}>${summary.totalCommission.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={8} align="right"><Text strong type="danger">${summary.totalRejectedCommission.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={9} align="right"><Text strong style={{ color: "#1890ff" }}>${summary.totalApprovedCommission.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={10} align="right"><Text strong>{summary.totalClicks}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={11} align="right"><Text strong>{summary.totalImpressions}</Text></Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            );
          }}
        />
      </Card>

      {/* ========== 花费/佣金详情弹窗（按广告系列） ========== */}
      <Modal title="花费 / 佣金明细" open={detailModal} onCancel={() => setDetailModal(false)} footer={null} width={700}>
        <Table rowKey="id" dataSource={detailByRow} size="small" pagination={false}
          columns={[
            { title: "广告系列", dataIndex: "campaign_name", width: 280, render: (v: string) => <Text style={{ fontSize: 12, wordBreak: "break-all", whiteSpace: "normal" }}>{v}</Text> },
            { title: "总花费", dataIndex: "cost", width: 100, align: "right", render: (v: number) => <Text style={{ color: v > 0 ? "#cf1322" : undefined }}>${v.toFixed(2)}</Text> },
            { title: "总佣金", dataIndex: "commission", width: 100, align: "right", render: (v: number) => <Text style={{ color: v > 0 ? "#389e0d" : undefined }}>${v.toFixed(2)}</Text> },
            { title: "拒付佣金", dataIndex: "rejected_commission", width: 100, align: "right", render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"}>${v.toFixed(2)}</Text> },
            { title: "已确认佣金", dataIndex: "approved_commission", width: 100, align: "right", render: (v: number) => <Text style={{ color: v > 0 ? "#1890ff" : undefined }}>${v.toFixed(2)}</Text> },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right"><Text strong style={{ color: "#cf1322" }}>${summary.totalCost.toFixed(2)}</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right"><Text strong style={{ color: "#389e0d" }}>${summary.totalCommission.toFixed(2)}</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right"><Text strong type="danger">${detailByRow.reduce((s, r) => s + r.rejected_commission, 0).toFixed(2)}</Text></Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right"><Text strong style={{ color: "#1890ff" }}>${detailByRow.reduce((s, r) => s + r.approved_commission, 0).toFixed(2)}</Text></Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      </Modal>

      {/* ========== 佣金详情弹窗（含汇总指标 + 按平台账号明细） ========== */}
      <Modal title="佣金详情" open={commissionModal} onCancel={() => setCommissionModal(false)} footer={null} width={750}>
        {/* 汇总指标 */}
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          <Col span={8}>
            <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
              <Statistic title="已确认佣金" value={summary.totalApprovedCommission} prefix="$" precision={2} styles={{ content: { fontSize: 16, color: summary.totalApprovedCommission > 0 ? "#1890ff" : undefined } }} />
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
              <Statistic title="待审核佣金"
                value={summary.totalCommission - summary.totalRejectedCommission - summary.totalApprovedCommission}
                prefix="$" precision={2}
                styles={{ content: { fontSize: 16, color: (summary.totalCommission - summary.totalRejectedCommission - summary.totalApprovedCommission) > 0 ? "#faad14" : undefined } }} />
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
              <Statistic title="拒付佣金" value={summary.totalRejectedCommission} prefix="$" precision={2} styles={{ content: { fontSize: 16, color: summary.totalRejectedCommission > 0 ? "#cf1322" : undefined } }} />
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

        {/* 按平台账号明细 */}
        <Text strong style={{ display: "block", marginBottom: 8 }}>按平台账号</Text>
        <Table
          rowKey={(r) => `${r.platform}-${r.account_name}`}
          dataSource={commissionByAccount}
          size="small"
          loading={loadingCommission}
          pagination={false}
          columns={[
            { title: "账号", dataIndex: "account_name", width: 120, render: (v: string, r) => <Tag color="blue">{v} ({r.platform})</Tag> },
            { title: "已确认佣金", dataIndex: "total_commission", width: 120, align: "right", render: (v: number) => <Text style={{ color: v > 0 ? "#389e0d" : undefined }}>${v.toFixed(2)}</Text> },
            { title: "待审核佣金", dataIndex: "pending_commission", width: 120, align: "right", render: (v: number) => <Text style={{ color: v > 0 ? "#faad14" : undefined }}>${v.toFixed(2)}</Text> },
            { title: "拒付佣金", dataIndex: "rejected_commission", width: 100, align: "right", render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"}>${v.toFixed(2)}</Text> },
            { title: "订单数", dataIndex: "order_count", width: 80, align: "right" },
          ]}
          summary={() => {
            if (commissionByAccount.length === 0) return null;
            const totals = commissionByAccount.reduce(
              (acc, r) => ({
                commission: acc.commission + r.total_commission,
                pending: acc.pending + r.pending_commission,
                rejected: acc.rejected + r.rejected_commission,
                orders: acc.orders + r.order_count,
              }),
              { commission: 0, pending: 0, rejected: 0, orders: 0 }
            );
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right"><Text strong style={{ color: "#389e0d" }}>${totals.commission.toFixed(2)}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right"><Text strong style={{ color: "#faad14" }}>${totals.pending.toFixed(2)}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right"><Text strong type="danger">${totals.rejected.toFixed(2)}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right"><Text strong>{totals.orders}</Text></Table.Summary.Cell>
              </Table.Summary.Row>
            );
          }}
        />
      </Modal>

      <EditCampaignModal
        open={editModal.open} campaign={editModal.campaign} field={editModal.field}
        mccAccountId={selectedMcc || mccAccounts[0]?.id || ""} onSuccess={handleEditSuccess}
        onCancel={() => setEditModal({ open: false, campaign: null, field: "budget" })}
      />
    </div>
  );
}
