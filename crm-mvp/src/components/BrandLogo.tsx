"use client";

/**
 * D-011 fengdu-ads brand mark
 *
 * 设计：白色 F 字母 + 右上角琥珀色数据点 + 蓝色渐变方块容器
 * - F = fengdu 首字母（公司品牌）
 * - 琥珀点 = 广告点击 / 数据点 / 转化（行业元素暗示）
 * - 蓝 #1A7FDB→#4DA6FF + 琥珀 #F59E0B = Google Ads 经典配色（蓝+黄）
 * - 单一可复用组件：PageHeader / PageFooter / favicon / og-image 全用同一设计
 */
export default function BrandLogo({
  size = 36,
  withShadow = true,
}: {
  size?: number;
  withShadow?: boolean;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        background: "linear-gradient(135deg, #1A7FDB 0%, #4DA6FF 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: withShadow ? "0 4px 14px rgba(26,127,219,0.32)" : "none",
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      <svg
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        viewBox="0 0 24 24"
        fill="none"
      >
        <path
          d="M6 5 H17 V7.5 H8.5 V11 H15 V13.5 H8.5 V19 H6 Z"
          fill="white"
        />
        <circle cx="18.6" cy="6.4" r="2.2" fill="#F59E0B" />
      </svg>
    </div>
  );
}
