/**
 * CRM 系统 Ant Design 主题配置
 * 天际蓝 + 白色侧边栏 + 浅蓝灰背景
 * 与数据分析平台保持一致的视觉风格
 *
 * D-009：扩 COLORS 灰色梯度（F-15）+ FONT_SIZE 字号阶（F-11）+ MODAL_WIDTH 三档（F-19）
 */
import type { ThemeConfig } from "antd";

// ============ 颜色常量 ============
// D-009 F-15：扩 COLORS 灰色梯度 + 语义色，覆盖现状 #f0f0f0 / #fafafa / #999 / #5F6368 / #bfbfbf 五种灰色 + #fafbfc 表头
export const COLORS = {
  primary: "#4DA6FF",
  primaryDark: "#1A7FDB",
  primaryLight: "#EBF5FF",
  primaryBorder: "#A8D4FF",

  bgPage: "#F0F5FA",
  bgCard: "#FFFFFF",
  bgSidebar: "#FFFFFF",
  bgHover: "#F8F9FA",
  bgSubtle: "#F8FAFC",

  textPrimary: "#202124",
  textSecondary: "#5F6368",
  textTertiary: "#9AA0A6",
  textDisabled: "#BFBFBF",

  border: "#E8EAED",
  divider: "#F0F0F0",
  grayLighter: "#FAFAFA",
  grayLight: "#F5F5F5",

  costRed: "#cf1322",
  successGreen: "#52c41a",
  incomeGreen: "#3f8600",
  warningOrange: "#faad14",
  errorRed: "#ff4d4f",
  purpleAi: "#722ed1",
} as const;

// ============ 字号阶（F-11 务实策略：常量先有，新增代码强制用，老 inline 渐进替换）============
export const FONT_SIZE = {
  xs: 11,
  sm: 12,
  md: 13,
  base: 14,
  lg: 16,
  xl: 18,
  xxl: 20,
  hero: 24,
} as const;

// ============ Modal 宽度三档（F-19）============
export const MODAL_WIDTH = {
  sm: 480,
  md: 640,
  lg: 900,
} as const;

// ============ 间距阶（F-10 SectionCard padding 三档语义化）============
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: COLORS.primary,
    colorInfo: COLORS.primary,
    colorLink: COLORS.primary,
    colorLinkHover: COLORS.primaryDark,
    colorBgContainer: COLORS.bgCard,
    colorBgLayout: COLORS.bgPage,
    colorBorder: COLORS.border,
    colorBorderSecondary: COLORS.divider,
    borderRadius: 8,
    borderRadiusLG: 16,
    colorText: COLORS.textPrimary,
    colorTextSecondary: COLORS.textSecondary,
    colorTextTertiary: COLORS.textTertiary,
    colorTextDisabled: COLORS.textDisabled,
  },
  components: {
    Layout: {
      siderBg: COLORS.bgSidebar,
      headerBg: COLORS.bgCard,
      bodyBg: COLORS.bgPage,
    },
    Menu: {
      itemBg: COLORS.bgSidebar,
      subMenuItemBg: COLORS.bgSidebar,
      itemSelectedBg: COLORS.primaryLight,
      itemSelectedColor: COLORS.primary,
      itemColor: COLORS.textSecondary,
      itemHoverColor: COLORS.textPrimary,
      itemHoverBg: COLORS.bgHover,
    },
    Table: {
      headerBg: "#FAFBFC",
      headerColor: COLORS.textSecondary,
      rowHoverBg: COLORS.bgHover,
      borderColor: COLORS.border,
    },
  },
};

export default themeConfig;
