"use client";

import { Tag } from "antd";
import type { TagProps } from "antd";
import type { ReactNode } from "react";

/**
 * D-009 F-17：全站统一 StatusTag（语义化 Tag）
 *
 * 替代 41 处 <Tag color="red/green/orange/blue/cyan/purple/default"> 自由发挥
 * 通过 status 语义直接映射 antd preset color：
 *
 *   success → green     warning → orange    danger  → red
 *   info    → blue      processing → cyan   neutral → default
 *   accent  → purple    primary → blue
 *
 * 用法：
 *   <StatusTag status="success">已通过</StatusTag>
 *   <StatusTag status="warning">异常</StatusTag>
 *
 * 仍支持 antd Tag 的全部其他 props（icon / closable / bordered / style 等）
 * 如需特殊配色（如品牌色），可直接用 <Tag color="#xxx">，本组件仅为语义化推荐路径。
 */

export type StatusType =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "processing"
  | "accent"
  | "primary"
  | "neutral";

const STATUS_COLOR_MAP: Record<StatusType, string> = {
  success: "green",
  warning: "orange",
  danger: "red",
  info: "blue",
  processing: "cyan",
  accent: "purple",
  primary: "blue",
  neutral: "default",
};

export interface StatusTagProps extends Omit<TagProps, "color"> {
  status: StatusType;
  children?: ReactNode;
}

export default function StatusTag({ status, children, ...rest }: StatusTagProps) {
  return (
    <Tag color={STATUS_COLOR_MAP[status]} {...rest}>
      {children}
    </Tag>
  );
}
