"use client";

import type { ReactNode, CSSProperties } from "react";
import { COLORS, SPACING } from "@/styles/themeConfig";

/**
 * D-009 F-9：全站统一 FilterBar（筛选栏）
 *
 * 复用 globals.css 已验证好的 .filter-bar 样式：
 * - background #F8FAFC + padding 10/16 + radius 8
 *
 * 适用场景：merchants / advertisers / data-center / link-exchange 顶部筛选区
 */

export interface FilterBarProps {
  children: ReactNode;
  /** 右侧扩展（如统计/快捷按钮），靠右展示 */
  extra?: ReactNode;
  /** 自定义样式覆盖 */
  style?: CSSProperties;
}

export default function FilterBar({ children, extra, style }: FilterBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: SPACING.sm,
        padding: "10px 16px",
        background: COLORS.bgSubtle,
        borderRadius: 8,
        marginBottom: SPACING.sm + 4,
        flexWrap: "wrap",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: SPACING.sm, flexWrap: "wrap", flex: 1, minWidth: 0 }}>
        {children}
      </div>
      {extra && (
        <div style={{ display: "flex", alignItems: "center", gap: SPACING.sm, marginLeft: "auto" }}>
          {extra}
        </div>
      )}
    </div>
  );
}
