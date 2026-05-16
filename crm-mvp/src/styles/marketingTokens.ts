/**
 * D-010 公开页（marketing）专属设计 tokens
 *
 * 与 app dashboard themeConfig 区别：
 * - app dashboard 偏密集功能（小字号 13 / 紧凑 padding 16 / 浅蓝主色）
 * - marketing 公开页偏品牌门面（大字号 48 / 大留白 padding 96 / 主色 + 渐变 + 柔和阴影）
 *
 * 设计风格：现代极简（Linear / Vercel / Stripe 派系）
 * - 大留白：section 上下 80-96px 呼吸感
 * - 单色渐变 hero：#EBF5FF → #FFFFFF
 * - 柔和阴影：0 4px 24px rgba(15,23,42,0.06) 默认 / hover 上浮
 * - 收敛配色：主色 #4DA6FF + 中性灰阶 + 单一 emerald accent，删杂色
 * - 大字号标题：hero 48px / section 36px / card 18px
 */

export const MARKETING = {
  // ─── 主色 ───
  primary: "#4DA6FF",
  primaryDark: "#1A7FDB",
  primaryLight: "#EBF5FF",
  primaryDarker: "#0F5FA8",

  // ─── 中性色（Slate 色系，对标 Tailwind slate）───
  text: "#0F172A",       // slate-900 主文本
  textSub: "#475569",    // slate-600 次级文本
  textMuted: "#94A3B8",  // slate-400 三级文本（caption / footer）
  border: "#E2E8F0",     // slate-200 柔和分隔线
  bgPage: "#FFFFFF",
  bgCard: "#FFFFFF",
  bgSection: "#F8FAFC",  // slate-50 区段轻底色（隔离用）
  bgHeroLight: "#EBF5FF", // hero 区淡蓝
  bgHeroGradient: "linear-gradient(180deg, #EBF5FF 0%, #F8FBFF 60%, #FFFFFF 100%)",

  // ─── 语义点缀色（极简策略：只留 2 个 accent）───
  accentGreen: "#22C55E",   // emerald-500（CTA 次按钮 + 成功状态）
  accentAmber: "#F59E0B",   // amber-500（warning / 特殊点缀）

  // ─── 阴影系统（柔和 + 立体）───
  shadowSoft: "0 1px 3px rgba(15,23,42,0.04), 0 1px 2px rgba(15,23,42,0.03)",
  shadowMedium: "0 4px 24px rgba(15,23,42,0.06), 0 1px 4px rgba(15,23,42,0.04)",
  shadowHover: "0 12px 40px rgba(15,23,42,0.10), 0 4px 16px rgba(15,23,42,0.06)",
  shadowHero: "0 24px 80px rgba(26,127,219,0.08)",
} as const;

// ─── 间距档（marketing 专属，更大留白）───
export const MK_SPACING = {
  xs: 8,
  sm: 16,
  md: 24,
  lg: 40,
  xl: 64,
  hero: 96, // section 上下 padding
} as const;

// ─── 字号阶（marketing 专属，更大）───
export const MK_FONT = {
  hero: 56,        // hero h1（响应式：移动端 36）
  heroMobile: 36,
  sectionTitle: 36,
  cardTitle: 20,
  body: 17,
  bodySmall: 15,
  caption: 13,
} as const;

// ─── 圆角档 ───
export const MK_RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;
