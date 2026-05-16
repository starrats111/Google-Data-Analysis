"use client";

/**
 * D-011 (v1) → D-014 (v2) fengdu-ads brand mark
 *
 * 设计语言（D-014 升级版）：
 * - 现代粗体 F（笔画粗 = 字宽 22.5%，黄金比例，类似 Inter Black / Geist Bold 风格）
 * - F 比例：宽 18 / 高 20（5:7 黄金分割），上横满 + 中横 62%，比例匀称
 * - 末端柔化：stroke-linejoin/linecap=round + stroke-width 0.6，去掉锐利切角僵硬感
 * - 琥珀色数据点：从右上角内移到 F 上横右端的延伸位置（cx 27.4 cy 6.6 r 2.6），强化"广告数据点"语义
 * - 蓝 #1A7FDB→#4DA6FF + 琥珀 #F59E0B = Google Ads 经典配色
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
        width={Math.round(size * 0.66)}
        height={Math.round(size * 0.66)}
        viewBox="0 0 32 32"
        fill="none"
      >
        <path
          d="M8 6 H26 V9.3 H11.6 V14.4 H22 V17.7 H11.6 V26 H8 Z"
          fill="white"
          stroke="white"
          strokeWidth="0.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx="27.4" cy="6.6" r="2.6" fill="#F59E0B" />
      </svg>
    </div>
  );
}
