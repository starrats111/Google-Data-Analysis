/**
 * dayjs 全局配置
 * 确保所有时间显示使用本地系统时间
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import 'dayjs/locale/zh-cn'

// 启用插件
dayjs.extend(utc)
dayjs.extend(timezone)

// 设置默认时区为中国时区
dayjs.tz.setDefault('Asia/Shanghai')

// 设置默认语言为中文
dayjs.locale('zh-cn')

/**
 * 将 UTC 时间转换为本地时间并格式化
 * @param {string|Date} utcTime - UTC 时间
 * @param {string} format - 格式化模板，默认 'YYYY-MM-DD HH:mm'
 * @returns {string} 格式化后的本地时间
 */
export const formatLocalTime = (utcTime, format = 'YYYY-MM-DD HH:mm') => {
  if (!utcTime) return '-'
  return dayjs.utc(utcTime).local().format(format)
}

/**
 * 获取当前本地时间
 * @returns {dayjs.Dayjs} 当前本地时间
 */
export const now = () => dayjs()

/**
 * 格式化日期（仅日期部分）
 * @param {string|Date} date - 日期
 * @returns {string} 格式化后的日期
 */
export const formatDate = (date) => {
  if (!date) return '-'
  return dayjs(date).format('YYYY-MM-DD')
}

/**
 * 格式化时间（完整日期时间）
 * @param {string|Date} datetime - 日期时间
 * @returns {string} 格式化后的日期时间
 */
export const formatDateTime = (datetime) => {
  if (!datetime) return '-'
  return dayjs.utc(datetime).local().format('YYYY-MM-DD HH:mm:ss')
}

export default dayjs

