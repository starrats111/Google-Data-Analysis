"use client";

/**
 * D-245 复盘分析眼睛弹窗：单系列「暂停前 7 天」逐日明细 + 趋势图 + AI 复盘点评
 * 数据源：GET  /api/user/team/review-daily（逐日 + 缓存点评）
 *        POST /api/user/team/review-ai（按需生成 / 重新分析，缓存入库）
 */

import { useCallback, useEffect, useState } from "react";
import { Modal, Table, Typography, Tag, Button, Space, Spin, Empty, App } from "antd";
import { RobotOutlined, HistoryOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip as ChartTooltip,
  Legend, CartesianGrid, ResponsiveContainer,
} from "recharts";

const { Text } = Typography;

interface DailyRow {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  commission: number;
  rejectedCommission: number;
  avgCpc: number;
  roi: number | null;
}

interface ReviewInfo {
  summary: string;
  detail: string;
  updatedAt: string;
}

interface ModalData {
  campaign: {
    id: string;
    name: string | null;
    customerId: string | null;
    status: string;
    dailyBudget: number;
    pauseDate: string;
    pauseSourceLabel: string;
    owner: { username: string; displayName: string | null };
  };
  range: { start: string; end: string };
  daily: DailyRow[];
  totals: {
    impressions: number; clicks: number; cost: number;
    orders: number; commission: number; rejected_commission: number;
  };
  review: ReviewInfo | null;
}

interface Props {
  open: boolean;
  campaignId: string | null;
  campaignName?: string;
  onClose: () => void;
}

const statusLabels: Record<string, string> = { PAUSED: "暂停", REMOVED: "移除" };
const statusColors: Record<string, string> = { PAUSED: "orange", REMOVED: "red" };

export default function ReviewAnalysisModal({ open, campaignId, campaignName, onClose }: Props) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ModalData | null>(null);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async (cid: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/team/review-daily?campaignId=${cid}`).then((r) => r.json());
      if (res.code === 0) setData(res.data);
      else message.error(res.message || "复盘明细加载失败");
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (open && campaignId) {
      setData(null);
      void load(campaignId);
    }
  }, [open, campaignId, load]);

  const handleGenerate = useCallback(async () => {
    if (!campaignId) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/user/team/review-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId }),
      }).then((r) => r.json());
      if (res.code === 0 && res.data?.review) {
        message.success("复盘点评已生成");
        setData((prev) => (prev ? { ...prev, review: res.data.review } : prev));
      } else {
        message.error(res.message || "点评生成失败");
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setGenerating(false);
    }
  }, [campaignId, message]);

  const dailyColumns: ColumnsType<DailyRow> = [
    { title: "日期", dataIndex: "date", width: 90, fixed: "left", render: (v: string) => <Text style={{ fontSize: 12 }}>{v.slice(5)}</Text> },
    { title: "展示", dataIndex: "impressions", width: 70, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v.toLocaleString()}</Text> },
    { title: "点击", dataIndex: "clicks", width: 55, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text> },
    { title: "花费", dataIndex: "spend", width: 75, align: "right", render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#cf1322" : undefined }}>${v.toFixed(2)}</Text> },
    { title: "订单", dataIndex: "orders", width: 50, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text> },
    { title: "佣金", dataIndex: "commission", width: 75, align: "right", render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#389e0d" : undefined }}>${v.toFixed(2)}</Text> },
    { title: "拒付", dataIndex: "rejectedCommission", width: 70, align: "right", render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"} style={{ fontSize: 12 }}>${v.toFixed(2)}</Text> },
    { title: "ROI", dataIndex: "roi", width: 60, align: "right", render: (v: number | null) => (v == null ? <Text type="secondary" style={{ fontSize: 12 }}>—</Text> : <Text style={{ fontSize: 12, color: v >= 0 ? "#389e0d" : "#cf1322" }}>{v.toFixed(2)}</Text>) },
    { title: "AvgCPC", dataIndex: "avgCpc", width: 75, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v > 0 ? `$${v.toFixed(4)}` : "—"}</Text> },
  ];

  const chartData = (data?.daily || []).map((d) => ({
    date: d.date.slice(5),
    花费: d.spend,
    佣金: d.commission,
    ROI: d.roi,
  }));

  const c = data?.campaign;

  return (
    <Modal
      title={
        <Space wrap>
          <HistoryOutlined />
          <span style={{ fontSize: 14 }}>暂停复盘 — {c?.name || campaignName || ""}</span>
          {c && (
            <>
              <Tag color={statusColors[c.status] || "default"} style={{ fontSize: 11 }}>{statusLabels[c.status] || c.status}</Tag>
              <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal" }}>
                {c.pauseDate} 暂停（{c.pauseSourceLabel}）· 投放人 {c.owner.displayName || c.owner.username}
              </Text>
            </>
          )}
          {data?.range && (
            <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal" }}>
              窗口 {data.range.start} ~ {data.range.end}
            </Text>
          )}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={980}
      destroyOnHidden
    >
      <Spin spinning={loading}>
        {/* 暂停前 7 天逐日明细 */}
        <Table<DailyRow>
          rowKey="date"
          dataSource={data?.daily || []}
          columns={dailyColumns}
          size="small"
          pagination={false}
          scroll={{ x: 720 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="窗口内无投放数据" /> }}
          style={{ marginBottom: 16 }}
          summary={() => {
            const t = data?.totals;
            if (!t) return null;
            const roi = t.cost > 0 ? (t.commission - t.cost) / t.cost : null;
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}><Text strong style={{ fontSize: 12 }}>合计</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right"><Text strong style={{ fontSize: 12 }}>{t.impressions.toLocaleString()}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right"><Text strong style={{ fontSize: 12 }}>{t.clicks}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right"><Text strong style={{ fontSize: 12, color: "#cf1322" }}>${t.cost.toFixed(2)}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right"><Text strong style={{ fontSize: 12 }}>{t.orders}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right"><Text strong style={{ fontSize: 12, color: "#389e0d" }}>${t.commission.toFixed(2)}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={6} align="right"><Text strong type={t.rejected_commission > 0 ? "danger" : "secondary"} style={{ fontSize: 12 }}>${t.rejected_commission.toFixed(2)}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={7} align="right">
                  {roi == null
                    ? <Text strong type="secondary" style={{ fontSize: 12 }}>—</Text>
                    : <Text strong style={{ fontSize: 12, color: roi >= 0 ? "#389e0d" : "#cf1322" }}>{roi.toFixed(2)}</Text>}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={8} align="right">
                  <Text strong style={{ fontSize: 12 }}>{t.clicks > 0 ? `$${(t.cost / t.clicks).toFixed(4)}` : "—"}</Text>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            );
          }}
        />

        {/* 趋势图：花费/佣金（左轴，$）+ ROI（右轴，倍数） */}
        {chartData.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="usd" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <YAxis yAxisId="roi" orientation="right" tick={{ fontSize: 11 }} />
                <ChartTooltip
                  formatter={(value, name) => {
                    if (name === "ROI") return [value == null ? "—" : Number(value).toFixed(2), "ROI"];
                    return [`$${Number(value).toFixed(2)}`, String(name)];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="usd" dataKey="花费" fill="#ff7875" barSize={16} radius={[2, 2, 0, 0]} />
                <Bar yAxisId="usd" dataKey="佣金" fill="#95de64" barSize={16} radius={[2, 2, 0, 0]} />
                <Line yAxisId="roi" type="monotone" dataKey="ROI" stroke="#1677ff" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* AI 复盘点评 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <Space size={6}>
            <RobotOutlined />
            <Text strong style={{ fontSize: 13 }}>AI 复盘点评</Text>
            {data?.review?.updatedAt && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                生成于 {data.review.updatedAt.slice(0, 16).replace("T", " ")}
              </Text>
            )}
          </Space>
          <Button
            size="small"
            icon={<RobotOutlined />}
            loading={generating}
            disabled={loading || !data}
            onClick={handleGenerate}
          >
            {data?.review ? "重新分析" : "生成点评"}
          </Button>
        </div>
        {data?.review ? (
          <div
            style={{
              maxHeight: 320, overflow: "auto", padding: "12px 16px", background: "#fafafa",
              border: "1px solid #f0f0f0", borderRadius: 6, fontSize: 12.5, lineHeight: 1.8,
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}
          >
            {data.review.detail}
          </div>
        ) : !loading && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无点评，点击右上「生成点评」由 AI 复盘这次暂停"
            style={{ margin: "16px 0" }}
          />
        )}
      </Spin>
    </Modal>
  );
}
