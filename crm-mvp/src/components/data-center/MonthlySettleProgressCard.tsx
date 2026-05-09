"use client";

import { useEffect, useState } from "react";
import { Card, Row, Col, Tag, Tooltip, Typography, Empty, Spin, Progress, Space } from "antd";
import { CheckCircleFilled, ClockCircleOutlined } from "@ant-design/icons";
import { COLORS } from "@/styles/themeConfig";

const { Text } = Typography;

export interface MonthSummary {
  month: string;
  total_count: number;
  total_amount: number;
  pending_count: number;
  pending_amount: number;
  approved_count: number;
  approved_amount: number;
  paid_count: number;
  paid_amount: number;
  rejected_count: number;
  rejected_amount: number;
  is_settled: boolean;
  settled_at: string | null;
  last_synced_at: string | null;
  settled_amount: number;
  settle_progress: number;
}

interface ProgressSummary {
  months_settled: number;
  months_unsettled: number;
  months_total: number;
  pending_amount: number;
  approved_amount: number;
  paid_amount: number;
  rejected_amount: number;
  total_amount: number;
  settle_progress: number;
}

interface ProgressData {
  months: MonthSummary[];
  summary: ProgressSummary;
  isLeader?: boolean;
}

interface Props {
  /** 组长视角时传入 member_id 切换不同成员 */
  memberId?: string;
}

/**
 * 月份结算进度卡片
 *
 * 视觉规范（07 验收点）：
 *   - 已结算月份：绿色边框 + 勾形图标 + "已结算"标签
 *   - 未结算月份：橙色边框 + 时钟图标 + 进度条（已结算金额 / 总金额）
 *   - 鼠标悬浮显示完整状态分布（pending / approved / paid / rejected）
 */
export default function MonthlySettleProgressCard({ memberId }: Props) {
  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    const fetchData = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (memberId) params.set("member_id", memberId);
        const url = `/api/user/data-center/settlement-progress${params.toString() ? `?${params}` : ""}`;
        const res = await fetch(url, { signal: ac.signal }).then((r) => r.json());
        if (res.code === 0) setData(res.data);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    return () => ac.abort();
  }, [memberId]);

  if (loading) {
    return (
      <Card size="small" title="月份结算进度" style={{ marginBottom: 12 }}>
        <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>
      </Card>
    );
  }

  if (!data || data.months.length === 0) {
    return (
      <Card size="small" title="月份结算进度" style={{ marginBottom: 12 }}>
        <Empty description="暂无月份数据" />
      </Card>
    );
  }

  const s = data.summary;

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space size={12} wrap>
          <Text strong>月份结算进度</Text>
          <Tag color="green" icon={<CheckCircleFilled />}>已结算 {s.months_settled} 个月</Tag>
          <Tag color="orange" icon={<ClockCircleOutlined />}>未结算 {s.months_unsettled} 个月</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            总进度：${s.total_amount.toLocaleString()}（{s.settle_progress}% 已落定）
          </Text>
        </Space>
      }
    >
      <Row gutter={[12, 12]}>
        {data.months.map((m) => {
          const settled = m.is_settled;
          const borderColor = settled ? COLORS.successGreen : "#faad14";
          const bgColor = settled ? "#f6ffed" : "#fffbe6";
          return (
            <Col key={m.month} xs={24} sm={12} md={8} lg={6} xl={4}>
              <Tooltip
                title={
                  <div style={{ fontSize: 12, lineHeight: "20px" }}>
                    <div>总：${m.total_amount.toFixed(2)}（{m.total_count} 单）</div>
                    <div style={{ color: "#73d13d" }}>已确认：${m.approved_amount.toFixed(2)}（{m.approved_count}）</div>
                    <div style={{ color: "#69c0ff" }}>已支付：${m.paid_amount.toFixed(2)}（{m.paid_count}）</div>
                    <div style={{ color: "#ff7875" }}>拒付：${m.rejected_amount.toFixed(2)}（{m.rejected_count}）</div>
                    <div style={{ color: "#ffc53d" }}>待审核：${m.pending_amount.toFixed(2)}（{m.pending_count}）</div>
                    {m.settled_at && (
                      <div style={{ marginTop: 6, color: "#bfbfbf" }}>
                        结算于：{new Date(m.settled_at).toLocaleString()}
                      </div>
                    )}
                    {m.last_synced_at && (
                      <div style={{ color: "#bfbfbf" }}>
                        最近同步：{new Date(m.last_synced_at).toLocaleString()}
                      </div>
                    )}
                  </div>
                }
              >
                <div
                  style={{
                    border: `1px solid ${borderColor}`,
                    background: bgColor,
                    borderRadius: 6,
                    padding: "8px 10px",
                    cursor: "default",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <Text strong style={{ fontSize: 13 }}>{m.month}</Text>
                    {settled ? (
                      <Tag color="green" style={{ marginRight: 0, fontSize: 11 }}>
                        <CheckCircleFilled /> 已结算
                      </Tag>
                    ) : (
                      <Tag color="orange" style={{ marginRight: 0, fontSize: 11 }}>
                        <ClockCircleOutlined /> 未结算
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    总额 ${m.total_amount.toLocaleString()}
                  </Text>
                  <Progress
                    percent={m.settle_progress}
                    size="small"
                    showInfo={false}
                    strokeColor={settled ? COLORS.successGreen : "#faad14"}
                    style={{ marginTop: 4, marginBottom: 4 }}
                  />
                  <div style={{ fontSize: 11, color: "#8c8c8c" }}>
                    待 ${m.pending_amount.toFixed(2)} / 已落定 ${m.settled_amount.toFixed(2)}
                  </div>
                </div>
              </Tooltip>
            </Col>
          );
        })}
      </Row>
    </Card>
  );
}
