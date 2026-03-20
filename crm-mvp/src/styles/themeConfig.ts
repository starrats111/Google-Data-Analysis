/**
 * CRM 系统 Ant Design 主题配置
 * 天际蓝 + 白色侧边栏 + 浅蓝灰背景
 * 与数据分析平台保持一致的视觉风格
 */
import type { ThemeConfig } from "antd";

// ============ 颜色常量 ============
export const COLORS = {
  primary: "#4DA6FF",
  primaryDark: "#1A7FDB",
  primaryLight: "#EBF5FF",
  primaryBorder: "#A8D4FF",
  bgPage: "#F0F5FA",
  bgCard: "#FFFFFF",
  bgSidebar: "#FFFFFF",
  textPrimary: "#202124",
  textSecondary: "#5F6368",
  border: "#E8EAED",
  costRed: "#cf1322",
  successGreen: "#52c41a",
  incomeGreen: "#3f8600",
  warningOrange: "#faad14",
  errorRed: "#ff4d4f",
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
    colorBorderSecondary: "#F0F0F0",
    borderRadius: 8,
    borderRadiusLG: 16,
    colorText: COLORS.textPrimary,
    colorTextSecondary: COLORS.textSecondary,
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
      itemHoverBg: "#F8F9FA",
    },
    Table: {
      headerBg: "#FAFBFC",
      headerColor: COLORS.textSecondary,
      rowHoverBg: "#F8F9FA",
      borderColor: COLORS.border,
    },
  },
};

export default themeConfig;
