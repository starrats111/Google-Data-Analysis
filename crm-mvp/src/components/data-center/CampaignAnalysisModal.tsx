"use client";

/**
 * D-238 眼睛弹窗：单系列最近 7 天逐日明细 + AI 完整分析报告 + 重新分析 / 一键执行
 * 数据源：GET /api/user/data-center/campaign-daily（逐日 + 缓存分析）
 *        POST /api/user/data-center/ai-analysis（重新分析，双层详细模式）
 *        POST /api/user/data-center/apply-actions（一键执行）
 */

import { useCallback, useEffect, useState } from "react";
import { Modal, Table, Typography, Tag, Button, Space, Spin, Empty, Select, App, Popconfirm } from "antd";
import { RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";

const { Text } = Typography;

export interface AnalysisActionItem {
  type: string;
  targetValue?: number | null;
  percentChange?: number | null;
}

export interface AnalysisItem {
  campaignId: string;
  status: string;
  summary?: string;
  detail?: string;
  actionItems?: AnalysisActionItem[];
  updatedAt?: string;
  errorMessage?: string;
}

export const STRATEGY_OPTIONS = [
  { value: "balanced", label: "平衡版" },
  { value: "aggressive", label: "进攻版" },
  { value: "conservative", label: "保守版" },
];

const ACTION_LABELS: Record<string, string> = {
  increase_budget: "提高预算",
  decrease_budget: "降低预算",
  increase_cpc: "提高出价",
  decrease_cpc: "降低出价",
  keep: "维持现状",
  pause: "暂停广告",
};

const ACTION_COLORS: Record<string, string> = {
  increase_budget: "green",
  decrease_budget: "orange",
  increase_cpc: "cyan",
  decrease_cpc: "gold",
  keep: "default",
  pause: "red",
};

export function formatActionItem(item: AnalysisActionItem): string {
  const label = ACTION_LABELS[item.type] || item.type;
  if (item.type === "keep" || item.type === "pause") return label;
  if (item.targetValue != null && item.targetValue > 0) return `${label}至 $${Number(item.targetValue).toFixed(2)}`;
  if (item.percentChange != null && item.percentChange > 0) return `${label} ${item.percentChange}%`;
  return label;
}

export function actionColor(type: string): string {
  return ACTION_COLORS[type] || "default";
}

interface DailyRow {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  commission: number;
  avgCpc: number;
  maxCpc: number;
  isBudget: number;
  isRank: number;
  qualityScore: number | null;
  roi: number | null;
}

interface ModalData {
  campaign: { id: string; name: string; dailyBudget: number; maxCpc: number | null; status: string };
  range: { start: string; end: string };
  daily: DailyRow[];
  analysis: AnalysisItem | null;
}

interface Props {
  open: boolean;
  campaignId: string | null;
  campaignName?: string;
  strategy: string;
  onClose: () => void;
  /** 执行动作成功后回调（父页刷新列表） */
  onApplied?: () => void;
  /** 重新分析成功后回调（父页刷新建议列） */
  onReanalyzed?: () => void;
}

export default function CampaignAnalysisModal({
  open, campaignId, campaignName, strategy: initialStrategy, onClose, onApplied, onReanalyzed,
}: Props) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ModalData | null>(null);
  const [strategy, setStrategy] = useState(initialStrategy);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => { setStrategy(initialStrategy); }, [initialStrategy, campaignId]);

  const load = useCallback(async (cid: string, strat: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/data-center/campaign-daily?campaignId=${cid}&strategy=${strat}`).then((r) => r.json());
      if (res.code === 0) setData(res.data);
      else message.error(res.message || "明细加载失败");
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (open && campaignId) {
      setData(null);
      void load(campaignId, strategy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, campaignId, strategy]);

  const handleReanalyze = useCallback(async () => {
    if (!campaignId) return;
    setReanalyzing(true);
    try {
      const res = await fetch("/api/user/data-center/ai-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignIds: [campaignId], strategy, forceRefresh: true, detailed: true }),
      }).then((r) => r.json());
      if (res.code === 0) {
        const item = res.data?.items?.[0];
        if (item?.status === "failed") {
          message.error(item.errorMessage || "分析失败");
        } else {
          message.success("重新分析完成");
          await load(campaignId, strategy);
          onReanalyzed?.();
        }
      } else {
        message.error(res.message || "分析失败");
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setReanalyzing(false);
    }
  }, [campaignId, strategy, load, message, onReanalyzed]);

  const handleApply = useCallback(async () => {
    if (!campaignId || !data?.analysis?.actionItems?.length) return;
    // 与 kyads 一致：一键执行只执行第 1 条建议
    const first = data.analysis.actionItems[0];
    setApplying(true);
    try {
      const res = await fetch("/api/user/data-center/apply-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, actions: [first] }),
      }).then((r) => r.json());
      if (res.code === 0) {
        const results: Array<{ success: boolean; message: string }> = res.data?.results || [];
        const failed = results.filter((r) => !r.success);
        if (failed.length === 0) message.success(results[0]?.message || "执行完成");
        else message.error(failed[0].message || "执行失败");
        onApplied?.();
      } else {
        message.error(res.message || "执行失败");
      }
    } catch {
      message.error("网络异常，请重试");
    } finally {
      setApplying(false);
    }
  }, [campaignId, data, message, onApplied]);

  const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

  const dailyColumns: ColumnsType<DailyRow> = [
    { title: "日期", dataIndex: "date", width: 90, fixed: "left", render: (v: string) => <Text style={{ fontSize: 12 }}>{v.slice(5)}</Text> },
    { title: "展示", dataIndex: "impressions", width: 70, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v.toLocaleString()}</Text> },
    { title: "点击", dataIndex: "clicks", width: 55, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text> },
    { title: "花费", dataIndex: "spend", width: 70, align: "right", render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#cf1322" : undefined }}>${v.toFixed(2)}</Text> },
    { title: "订单", dataIndex: "orders", width: 50, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text> },
    { title: "佣金", dataIndex: "commission", width: 70, align: "right", render: (v: number) => <Text style={{ fontSize: 12, color: v > 0 ? "#389e0d" : undefined }}>${v.toFixed(2)}</Text> },
    { title: "ROI", dataIndex: "roi", width: 60, align: "right", render: (v: number | null) => (v == null ? <Text type="secondary" style={{ fontSize: 12 }}>—</Text> : <Text style={{ fontSize: 12, color: v >= 0 ? "#389e0d" : "#cf1322" }}>{v.toFixed(2)}</Text>) },
    { title: "AvgCPC", dataIndex: "avgCpc", width: 75, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>${v.toFixed(4)}</Text> },
    { title: "MaxCPC", dataIndex: "maxCpc", width: 70, align: "right", render: (v: number) => <Text style={{ fontSize: 12 }}>{v > 0 ? `$${v.toFixed(2)}` : "—"}</Text> },
    { title: "IS_Bgt", dataIndex: "isBudget", width: 65, align: "right", render: (v: number) => <Text style={{ fontSize: 12, color: v >= 0.1 ? "#cf1322" : undefined }}>{pct(v)}</Text> },
    { title: "IS_Rnk", dataIndex: "isRank", width: 65, align: "right", render: (v: number) => <Text style={{ fontSize: 12, color: v >= 0.3 ? "#cf1322" : undefined }}>{pct(v)}</Text> },
    { title: "QS", dataIndex: "qualityScore", width: 45, align: "right", render: (v: number | null) => (v ? <Text style={{ fontSize: 12, color: v < 5 ? "#cf1322" : undefined }}>{v}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>) },
  ];

  const analysis = data?.analysis;
  const firstAction = analysis?.actionItems?.[0];
  const canApply = firstAction && firstAction.type !== "keep";

  return (
    <Modal
      title={
        <Space>
          <RobotOutlined />
          <span style={{ fontSize: 14 }}>广告分析 — {data?.campaign?.name || campaignName || ""}</span>
          {data?.range && <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal" }}>{data.range.start} ~ {data.range.end}</Text>}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={980}
      destroyOnHidden
    >
      <Spin spinning={loading}>
        {/* 逐日明细 */}
        <Table<DailyRow>
          rowKey="date"
          dataSource={data?.daily || []}
          columns={dailyColumns}
          size="small"
          pagination={false}
          scroll={{ x: 885 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="区间内无投放数据" /> }}
          style={{ marginBottom: 16 }}
        />

        {/* 操作建议 + 按钮区 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <Space size={6} wrap>
            <Text strong style={{ fontSize: 13 }}>操作建议：</Text>
            {analysis?.actionItems?.length
              ? analysis.actionItems.slice(0, 2).map((a, i) => (
                  <Tag key={i} color={actionColor(a.type)} style={{ fontSize: 12 }}>{formatActionItem(a)}</Tag>
                ))
              : <Text type="secondary" style={{ fontSize: 12 }}>暂无分析结果，点击右侧「重新分析」生成</Text>}
            {analysis?.updatedAt && (
              <Text type="secondary" style={{ fontSize: 11 }}>更新于 {analysis.updatedAt.slice(0, 16).replace("T", " ")}</Text>
            )}
          </Space>
          <Space>
            <Select size="small" value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} style={{ width: 90 }} />
            <Button size="small" icon={<RobotOutlined />} loading={reanalyzing} onClick={handleReanalyze}>
              重新分析
            </Button>
            {canApply && (
              <Popconfirm
                title={`确认执行「${formatActionItem(firstAction!)}」？`}
                description="将通过 Google Ads API 实际修改广告系列"
                onConfirm={handleApply}
                okText="执行"
                cancelText="取消"
              >
                <Button size="small" type="primary" icon={<ThunderboltOutlined />} loading={applying}>
                  一键执行
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>

        {/* 完整分析报告 */}
        {analysis?.detail ? (
          <div
            style={{
              maxHeight: 380, overflow: "auto", padding: "12px 16px", background: "#fafafa",
              border: "1px solid #f0f0f0", borderRadius: 6, fontSize: 12.5, lineHeight: 1.8,
              whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
            }}
          >
            {analysis.detail}
          </div>
        ) : !loading && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分析报告" style={{ margin: "24px 0" }} />
        )}
      </Spin>
    </Modal>
  );
}
