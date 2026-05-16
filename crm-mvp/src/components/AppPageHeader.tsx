"use client";

import { Space, Typography } from "antd";
import type { ReactNode } from "react";
import { COLORS, FONT_SIZE, SPACING } from "@/styles/themeConfig";

const { Title, Text } = Typography;

/**
 * D-009 F-1~F-5：全站统一 AppPageHeader 组件（app dashboard 风格页头）
 *
 * 与 PageHeader.tsx 区别：
 * - PageHeader.tsx：公开营销页用的绿色顶部导航（含 logo + 语言切换）
 * - AppPageHeader：登录后 app dashboard 各页面的统一页头（icon + 标题 + 副标题 + extra）
 *
 * 视觉规格（F-3=A）：
 * - icon 24px（与 Title level=4 高度协调）
 * - Title level=4（与现有 settings/team-* 已用 level=4 对齐）
 * - subtitle 12px secondary
 * - 16px 底部间距
 *
 * 用法：
 *   <AppPageHeader icon={<ShopOutlined />} title="我的商家" subtitle="..." extra={<Button>...</Button>} />
 *
 * Tabs 放 AppPageHeader 兄弟节点（不并入 props，F-2=A 最小集）
 */

export interface AppPageHeaderProps {
  /** 左侧图标（推荐 Antd Icon，详见 design-system.md F-5） */
  icon?: ReactNode;
  /** 标题文本 */
  title: ReactNode;
  /** 副标题（灰色 12px） */
  subtitle?: ReactNode;
  /** 右侧扩展槽（按钮组 / 提示文字 / Tooltip 等） */
  extra?: ReactNode;
  /** 底部间距，默认 16；密集页面可调 8 */
  marginBottom?: number;
}

export default function AppPageHeader({
  icon,
  title,
  subtitle,
  extra,
  marginBottom = SPACING.md,
}: AppPageHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom,
        gap: SPACING.md,
        flexWrap: "wrap",
      }}
    >
      <Space size={SPACING.sm} align="center" style={{ minHeight: 32 }}>
        {icon && (
          <span
            style={{
              fontSize: FONT_SIZE.hero,
              color: COLORS.primary,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            {icon}
          </span>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Title level={4} style={{ margin: 0, lineHeight: 1.25 }}>
            {title}
          </Title>
          {subtitle && (
            <Text type="secondary" style={{ fontSize: FONT_SIZE.sm }}>
              {subtitle}
            </Text>
          )}
        </div>
      </Space>
      {extra && <div style={{ display: "flex", alignItems: "center", gap: SPACING.sm }}>{extra}</div>}
    </div>
  );
}
