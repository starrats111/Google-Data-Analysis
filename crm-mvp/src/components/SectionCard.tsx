"use client";

import { Card } from "antd";
import type { CardProps } from "antd";
import type { ReactNode } from "react";

/**
 * D-009 F-6/F-10：全站统一 SectionCard 组件
 *
 * 解决三套 padding 体系并存：
 * - size="small" + styles={{body:padding:"8px 12px"}}（data-center 风格）
 * - size="small" + bodyStyle={{padding:"10px 14px"}}（advertisers 风格）
 * - 默认 size + className="stat-card-hero"（merchants 风格）
 *
 * 三档语义化 padding（F-10=A）：
 * - sm：8px 12px（密集列表 / 紧凑卡组）
 * - md：16px（默认，覆盖 90% 场景）
 * - lg：20px 24px（页头主体 / 大表格容器）
 */

export type SectionCardPadding = "sm" | "md" | "lg" | "none";

export interface SectionCardProps extends Omit<CardProps, "size" | "bodyStyle" | "styles"> {
  /** padding 档位，默认 md=16px；sm=8/12（密集）；lg=20/24（主容器）；none=0 */
  padding?: SectionCardPadding;
  /** 标题左侧图标（可选；与 PageHeader 不同，这里是卡片内嵌图标） */
  titleIcon?: ReactNode;
}

const PADDING_MAP: Record<SectionCardPadding, string> = {
  sm: "8px 12px",
  md: "16px",
  lg: "20px 24px",
  none: "0",
};

export default function SectionCard({
  padding = "md",
  titleIcon,
  title,
  children,
  ...rest
}: SectionCardProps) {
  const mergedTitle =
    titleIcon && title ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {titleIcon}
        {title}
      </span>
    ) : (
      title
    );

  return (
    <Card
      size={padding === "sm" ? "small" : "default"}
      styles={{ body: { padding: PADDING_MAP[padding] } }}
      title={mergedTitle}
      {...rest}
    >
      {children}
    </Card>
  );
}
