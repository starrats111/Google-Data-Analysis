"use client";

import { useEffect, useState } from "react";
import { Card, Row, Col, Tag, Tooltip, Typography, Empty, Spin, Space, Button } from "antd";
import { CheckCircleFilled, ClockCircleOutlined, DownOutlined, UpOutlined } from "@ant-design/icons";
import { COLORS } from "@/styles/themeConfig";

/** 折叠状态本地持久化 key（同一浏览器下次进来保持上次选择） */
const COLLAPSE_STORAGE_KEY = "crm.monthlyProgress.collapsed";

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

// 三段进度条配色（与佣金详情、结算中心其他模块保持一致）
const SEG_GREEN = COLORS.successGreen;   // 已确认（approved + paid）
const SEG_RED = COLORS.errorRed;         // 拒付（rejected）
const SEG_YELLOW = COLORS.warningOrange; // 待确认（pending）
const TRACK_BG = "#F0F2F5";              // 进度槽底色

/**
 * 月份结算进度卡片（C-075 视觉版）
 *
 * 视觉规范：
 *   - 整体白蓝色调，与系统主题一致；不再使用橙底/绿底卡片。
 *   - 已结算月份：白底 + 浅绿描边 + 右上"已结算"绿色 Tag。
 *   - 未结算月份：白底 + 浅蓝描边 + 右上"未结算"蓝色 Tag。
 *   - 进度条三段式色块（一条内三色）：
 *       绿 = 已确认 (approved + paid)
 *       红 = 拒付  (rejected)
 *       黄 = 待确认 (pending)
 *   - Hover 升起一档阴影 + 描边加深，回应交互。
 *   - Tooltip 显示完整状态分布与时间戳。
 */
export default function MonthlySettleProgressCard({ memberId }: Props) {
  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoverMonth, setHoverMonth] = useState<string | null>(null);
  // 折叠状态：默认展开；恢复 localStorage 上次选择
  const [collapsed, setCollapsed] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (saved === "1") setCollapsed(true);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      }
      return next;
    });
  };

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

  // 全月份汇总三段比例（折叠时的概览条）
  const sumTotal = s.total_amount > 0 ? s.total_amount : 1;
  const sumApprovedConfirmed = s.approved_amount + s.paid_amount;
  const sumGreenPct = (sumApprovedConfirmed / sumTotal) * 100;
  const sumRedPct = (s.rejected_amount / sumTotal) * 100;
  const sumYellowPct = (s.pending_amount / sumTotal) * 100;

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space size={12} wrap>
          <Text strong>月份结算进度</Text>
          <Tag color="green" icon={<CheckCircleFilled />} style={{ marginRight: 0 }}>
            已结算 {s.months_settled} 个月
          </Tag>
          <Tag color="processing" icon={<ClockCircleOutlined />} style={{ marginRight: 0 }}>
            未结算 {s.months_unsettled} 个月
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            总进度：${s.total_amount.toLocaleString()}（{s.settle_progress}% 已落定）
          </Text>
        </Space>
      }
      extra={
        <Button
          type="text"
          size="small"
          icon={collapsed ? <DownOutlined /> : <UpOutlined />}
          onClick={toggleCollapsed}
          style={{ color: COLORS.textSecondary, fontSize: 12 }}
        >
          {collapsed ? "展开" : "折叠"}
        </Button>
      }
    >
      {collapsed ? (
        // 折叠时的精简概览：一条三段式总进度条 + 三色金额
        <div>
          <div
            style={{
              display: "flex",
              height: 10,
              borderRadius: 5,
              overflow: "hidden",
              background: TRACK_BG,
              marginBottom: 8,
            }}
          >
            {sumGreenPct > 0 && (
              <div style={{ width: `${sumGreenPct}%`, background: SEG_GREEN, transition: "width 0.3s ease" }} />
            )}
            {sumRedPct > 0 && (
              <div style={{ width: `${sumRedPct}%`, background: SEG_RED, transition: "width 0.3s ease" }} />
            )}
            {sumYellowPct > 0 && (
              <div style={{ width: `${sumYellowPct}%`, background: SEG_YELLOW, transition: "width 0.3s ease" }} />
            )}
          </div>
          <Space size={16} wrap style={{ fontSize: 12 }}>
            {sumApprovedConfirmed > 0 && (
              <span style={{ color: SEG_GREEN }}>
                已确认 ${sumApprovedConfirmed.toLocaleString()}
              </span>
            )}
            {s.rejected_amount > 0 && (
              <span style={{ color: SEG_RED }}>
                拒付 ${s.rejected_amount.toLocaleString()}
              </span>
            )}
            {s.pending_amount > 0 && (
              <span style={{ color: SEG_YELLOW }}>
                待确认 ${s.pending_amount.toLocaleString()}
              </span>
            )}
            <Text type="secondary" style={{ fontSize: 12 }}>
              （展开查看每月明细）
            </Text>
          </Space>
        </div>
      ) : (
        <Row gutter={[12, 12]}>
        {data.months.map((m) => {
          const settled = m.is_settled;
          const isHover = hoverMonth === m.month;

          // 三段比例（金额 → 百分比）
          const total = m.total_amount > 0 ? m.total_amount : 1;
          const approvedConfirmed = m.approved_amount + m.paid_amount;
          const greenPct = (approvedConfirmed / total) * 100;
          const redPct = (m.rejected_amount / total) * 100;
          const yellowPct = (m.pending_amount / total) * 100;

          // 描边色 / 阴影色
          const accentColor = settled ? COLORS.successGreen : COLORS.primary;
          const borderColor = settled ? "#B7EB8F" : COLORS.primaryBorder;
          const shadow = isHover
            ? settled
              ? "0 4px 12px rgba(82, 196, 26, 0.18)"
              : "0 4px 12px rgba(77, 166, 255, 0.18)"
            : "0 1px 2px rgba(0, 0, 0, 0.03)";

          return (
            <Col key={m.month} xs={24} sm={12} md={8} lg={6} xl={4}>
              <Tooltip
                title={
                  <div style={{ fontSize: 12, lineHeight: "20px" }}>
                    <div>总：${m.total_amount.toFixed(2)}（{m.total_count} 单）</div>
                    <div style={{ color: SEG_GREEN }}>
                      已确认：${approvedConfirmed.toFixed(2)}（{m.approved_count + m.paid_count}）
                      {m.paid_count > 0 && (
                        <span style={{ color: "#bfbfbf", marginLeft: 4 }}>
                          含支付 {m.paid_count}
                        </span>
                      )}
                    </div>
                    <div style={{ color: SEG_RED }}>
                      拒付：${m.rejected_amount.toFixed(2)}（{m.rejected_count}）
                    </div>
                    <div style={{ color: SEG_YELLOW }}>
                      待确认：${m.pending_amount.toFixed(2)}（{m.pending_count}）
                    </div>
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
                  onMouseEnter={() => setHoverMonth(m.month)}
                  onMouseLeave={() => setHoverMonth(null)}
                  style={{
                    background: "#FFFFFF",
                    border: `1px solid ${isHover ? accentColor : borderColor}`,
                    borderRadius: 8,
                    padding: "10px 12px",
                    cursor: "default",
                    transition: "border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease",
                    boxShadow: shadow,
                    transform: isHover ? "translateY(-1px)" : "none",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <Text strong style={{ fontSize: 13 }}>
                      {m.month}
                    </Text>
                    {settled ? (
                      <Tag
                        color="success"
                        style={{ marginRight: 0, fontSize: 11, lineHeight: "18px" }}
                        icon={<CheckCircleFilled />}
                      >
                        已结算
                      </Tag>
                    ) : (
                      <Tag
                        color="processing"
                        style={{ marginRight: 0, fontSize: 11, lineHeight: "18px" }}
                        icon={<ClockCircleOutlined />}
                      >
                        未结算
                      </Tag>
                    )}
                  </div>

                  <Text type="secondary" style={{ fontSize: 11 }}>
                    总额 ${m.total_amount.toLocaleString()}
                  </Text>

                  {/* 三段式进度条：绿=已确认 / 红=拒付 / 黄=待确认 */}
                  <div
                    style={{
                      display: "flex",
                      height: 8,
                      borderRadius: 4,
                      overflow: "hidden",
                      background: TRACK_BG,
                      marginTop: 8,
                      marginBottom: 6,
                    }}
                  >
                    {greenPct > 0 && (
                      <div
                        style={{
                          width: `${greenPct}%`,
                          background: SEG_GREEN,
                          transition: "width 0.3s ease",
                        }}
                      />
                    )}
                    {redPct > 0 && (
                      <div
                        style={{
                          width: `${redPct}%`,
                          background: SEG_RED,
                          transition: "width 0.3s ease",
                        }}
                      />
                    )}
                    {yellowPct > 0 && (
                      <div
                        style={{
                          width: `${yellowPct}%`,
                          background: SEG_YELLOW,
                          transition: "width 0.3s ease",
                        }}
                      />
                    )}
                  </div>

                  {/* 三色金额标注（按比例显示 / 0 值不显示） */}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "4px 8px",
                      fontSize: 11,
                      lineHeight: "16px",
                    }}
                  >
                    {approvedConfirmed > 0 && (
                      <span style={{ color: SEG_GREEN }}>
                        已确 ${approvedConfirmed.toFixed(2)}
                      </span>
                    )}
                    {m.rejected_amount > 0 && (
                      <span style={{ color: SEG_RED }}>
                        拒 ${m.rejected_amount.toFixed(2)}
                      </span>
                    )}
                    {m.pending_amount > 0 && (
                      <span style={{ color: SEG_YELLOW }}>
                        待 ${m.pending_amount.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              </Tooltip>
            </Col>
          );
        })}
        </Row>
      )}
    </Card>
  );
}
