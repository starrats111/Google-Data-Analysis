"use client";

import { Card, Tooltip, Typography } from "antd";
import type { ReactNode } from "react";
import { COLORS, FONT_SIZE, SPACING } from "@/styles/themeConfig";

const { Text } = Typography;

/**
 * D-009 F-7：全站统一 StatCard（统计卡片）
 *
 * 替代场景：
 * - advertisers 今日广告 Tab 4 卡片（339/108/92/16）
 * - merchants 4 stat-card-hero（我的商家/广告投放/节日营销/AI 人设）
 * - team-overview 多 StatCard
 * - data-center 顶部数据条
 *
 * 视觉规格：
 * - icon 18px 灰色（左上）
 * - label 13px 灰色 → value 24px 强调色
 * - hint 12px 灰色三级（可选副提示）
 * - trend 12px 红/绿（可选趋势）
 */

export interface StatCardProps {
  icon?: ReactNode;
  label: ReactNode;
  value: ReactNode;
  /** 数值颜色（默认 primary 蓝；可传 cost/success/warning 等） */
  valueColor?: string;
  /** 副提示（灰色 12） */
  hint?: ReactNode;
  /** 趋势文本（如 ↑3.2%）；正值绿色，负值红色由调用方决定 */
  trend?: ReactNode;
  trendColor?: string;
  /** hover 提示 */
  tooltip?: string;
  /** 卡片可点击时的回调 */
  onClick?: () => void;
}

export default function StatCard({
  icon,
  label,
  value,
  valueColor = COLORS.primary,
  hint,
  trend,
  trendColor = COLORS.successGreen,
  tooltip,
  onClick,
}: StatCardProps) {
  const inner = (
    <Card
      size="small"
      hoverable={!!onClick}
      onClick={onClick}
      styles={{ body: { padding: `${SPACING.sm + 2}px ${SPACING.md - 2}px` } }}
      style={{ height: "100%" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: SPACING.xs, color: COLORS.textTertiary, fontSize: FONT_SIZE.md }}>
          {icon && <span style={{ fontSize: FONT_SIZE.lg, display: "inline-flex" }}>{icon}</span>}
          <span>{label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: SPACING.sm }}>
          <span style={{ fontSize: FONT_SIZE.hero, fontWeight: 600, color: valueColor, lineHeight: 1.1 }}>
            {value}
          </span>
          {trend && (
            <span style={{ fontSize: FONT_SIZE.sm, color: trendColor }}>{trend}</span>
          )}
        </div>
        {hint && (
          <Text type="secondary" style={{ fontSize: FONT_SIZE.sm }}>
            {hint}
          </Text>
        )}
      </div>
    </Card>
  );

  if (tooltip) {
    return <Tooltip title={tooltip}>{inner}</Tooltip>;
  }
  return inner;
}
