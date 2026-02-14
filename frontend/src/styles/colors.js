/**
 * 天际蓝主题 - 颜色常量定义
 * 
 * 用途说明：
 * - 本文件作为颜色系统的单一真相源（Single Source of Truth）
 * - 可在 JSX 内联样式、自定义 CSS、未来组件中使用
 * - themeConfig.js 和 global.css 也参考此文件的色值定义
 */

// ============ 品牌主题色（天际蓝体系，v1.x 保持） ============
export const PRIMARY = '#4DA6FF'              // 主色
export const PRIMARY_DARK = '#1A7FDB'         // 深色（hover）
export const PRIMARY_LIGHT = '#EBF5FF'        // 浅底背景
export const PRIMARY_BORDER = '#A8D4FF'       // 浅边框
export const PRIMARY_RGB = '77, 166, 255'     // 用于 rgba() 构造
export const GRADIENT_START = '#4DA6FF'       // 渐变起点
export const GRADIENT_END = '#7B68EE'         // 渐变终点（品牌渐变）
export const GRADIENT_END_RGB = '123, 104, 238'
export const GRADIENT = 'linear-gradient(135deg, #4DA6FF 0%, #7B68EE 100%)'
export const GRADIENT_90 = 'linear-gradient(90deg, #4DA6FF, #7B68EE, #4DA6FF)'

// ============ v2.2 浅色主题相关（备用，未来组件可导入使用） ============
export const BG_PAGE = '#F0F5FA'              // 页面背景
export const BG_CARD = '#FFFFFF'              // 卡片背景
export const BG_SIDEBAR = '#FFFFFF'           // 侧边栏背景
export const TEXT_PRIMARY = '#202124'         // 主文字
export const TEXT_SECONDARY = '#5F6368'       // 次要文字
export const BORDER = '#E8EAED'               // 主边框

// ============ v2.2 渐变卡片（后续迭代 Dashboard 渐变卡片使用） ============
export const GRADIENT_CARD = 'linear-gradient(135deg, #4DA6FF 0%, #1A7FDB 100%)'

// ============ 侧边栏（v2.2 更新为白色） ============
export const SIDER_BG = '#FFFFFF'             // 白色侧边栏（原 #0C2D48）
export const SIDER_SUB_BG = '#FFFFFF'         // 子菜单背景（原 #0A2540）

// ============ 语义色（禁止修改） ============
export const COST_RED = '#cf1322'             // 广告花费
export const ERROR_RED = '#ff4d4f'            // 错误/拒绝
export const DANGER_RED = '#f5222d'           // 危险红
export const INCOME_GREEN = '#3f8600'         // 收入/盈利
export const SUCCESS_GREEN = '#52c41a'        // 成功
export const WARNING_ORANGE = '#faad14'       // 警告

// ============ 导出主题对象 ============
export default {
  primary: PRIMARY,
  primaryDark: PRIMARY_DARK,
  primaryLight: PRIMARY_LIGHT,
  primaryBorder: PRIMARY_BORDER,
  primaryRgb: PRIMARY_RGB,
  gradient: GRADIENT,
  gradientCard: GRADIENT_CARD,
  siderBg: SIDER_BG,
  bgPage: BG_PAGE,
}
