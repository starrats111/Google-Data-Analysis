/**
 * 天际蓝主题 - 颜色常量定义
 * @description 统一管理所有主题色，方便后续维护
 */

// ============ 品牌主题色（可替换） ============
export const PRIMARY = '#4DA6FF'              // 主色
export const PRIMARY_DARK = '#1A7FDB'         // 深色（hover）
export const PRIMARY_LIGHT = '#EBF5FF'        // 浅底背景
export const PRIMARY_BORDER = '#A8D4FF'       // 浅边框
export const PRIMARY_RGB = '77, 166, 255'     // 用于 rgba() 构造
export const GRADIENT_START = '#4DA6FF'       // 渐变起点
export const GRADIENT_END = '#7B68EE'         // 渐变终点
export const GRADIENT_END_RGB = '123, 104, 238'  // #7B68EE 的 RGB
export const GRADIENT = 'linear-gradient(135deg, #4DA6FF 0%, #7B68EE 100%)'
export const GRADIENT_90 = 'linear-gradient(90deg, #4DA6FF, #7B68EE, #4DA6FF)'

// ============ 侧边栏 ============
export const SIDER_BG = '#0C2D48'
export const SIDER_SUB_BG = '#0A2540'

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
  siderBg: SIDER_BG,
}

