/**
 * 露出功能 API 服务
 */
import api from './api'

// ============ 文章相关 ============

export const getArticles = (params = {}) => {
  return api.get('/api/luchu/articles', { params })
}

export const getArticle = (id) => {
  return api.get(`/api/luchu/articles/${id}`)
}

export const createArticle = (data) => {
  return api.post('/api/luchu/articles', data)
}

export const updateArticle = (id, data) => {
  return api.put(`/api/luchu/articles/${id}`, data)
}

export const deleteArticle = (id) => {
  return api.delete(`/api/luchu/articles/${id}`)
}

export const submitArticle = (id) => {
  return api.post(`/api/luchu/articles/${id}/submit`)
}

export const getArticleVersions = (id) => {
  return api.get(`/api/luchu/articles/${id}/versions`)
}

export const restoreVersion = (articleId, versionNumber) => {
  return api.post(`/api/luchu/articles/${articleId}/versions/${versionNumber}/restore`)
}

// ============ AI 相关 ============

export const analyzeMerchant = (url) => {
  // 分析商家网站可能需要较长时间（Playwright渲染），设置2分钟超时
  return api.post('/api/luchu/ai/analyze', { url }, { timeout: 120000 })
}

export const generateArticle = (data) => {
  // 生成文章也可能需要较长时间，设置2分钟超时
  return api.post('/api/luchu/ai/generate', data, { timeout: 120000 })
}

export const regenerateSection = (articleId, section, instructions) => {
  return api.post('/api/luchu/ai/regenerate', null, {
    params: { article_id: articleId, section, instructions }
  })
}

// ============ 审核相关 ============

export const getPendingReviews = (params = {}) => {
  return api.get('/api/luchu/reviews', { params })
}

export const approveArticle = (id, comment = null) => {
  return api.post(`/api/luchu/reviews/${id}/approve`, { comment })
}

export const rejectArticle = (id, comment) => {
  return api.post(`/api/luchu/reviews/${id}/reject`, { comment })
}

export const selfCheckArticle = (id) => {
  return api.post(`/api/luchu/reviews/${id}/self-check`)
}

// ============ 发布相关 ============

export const getReadyToPublish = (params = {}) => {
  return api.get('/api/luchu/publish/ready', { params })
}

export const publishArticle = (id, commitMessage = null) => {
  return api.post(`/api/luchu/publish/${id}`, { commit_message: commitMessage })
}

export const getPublishLogs = (params = {}) => {
  return api.get('/api/luchu/publish/logs', { params })
}

// ============ 网站相关 ============

export const getWebsites = () => {
  return api.get('/api/luchu/websites')
}

export const getWebsite = (id) => {
  return api.get(`/api/luchu/websites/${id}`)
}

export const updateWebsite = (id, data) => {
  return api.put(`/api/luchu/websites/${id}`, data)
}

export const createWebsite = (data) => {
  return api.post('/api/luchu/websites', data)
}

// ============ 统计相关 ============

export const getDashboardStats = () => {
  return api.get('/api/luchu/stats/dashboard')
}

export const getPublishTrend = () => {
  return api.get('/api/luchu/stats/publish-trend')
}

export const getCategoryStats = () => {
  return api.get('/api/luchu/stats/category-stats')
}

export const getReviewEfficiency = () => {
  return api.get('/api/luchu/stats/review-efficiency')
}

// ============ 通知相关 ============

export const getNotifications = (params = {}) => {
  return api.get('/api/luchu/notifications', { params })
}

export const getUnreadCount = () => {
  return api.get('/api/luchu/notifications/unread-count')
}

export const markAsRead = (id) => {
  return api.post(`/api/luchu/notifications/${id}/read`)
}

export const markAllAsRead = () => {
  return api.post('/api/luchu/notifications/read-all')
}

// ============ 提示词模板 ============

export const getPromptTemplates = () => {
  return api.get('/api/luchu/prompts')
}

export const getPromptTemplate = (id) => {
  return api.get(`/api/luchu/prompts/${id}`)
}

export const createPromptTemplate = (data) => {
  return api.post('/api/luchu/prompts', data)
}

export const updatePromptTemplate = (id, data) => {
  return api.put(`/api/luchu/prompts/${id}`, data)
}

export const deletePromptTemplate = (id) => {
  return api.delete(`/api/luchu/prompts/${id}`)
}

// ============ 操作日志 ============

export const getOperationLogs = (params = {}) => {
  return api.get('/api/luchu/logs', { params })
}

export const getActionTypes = () => {
  return api.get('/api/luchu/logs/actions')
}

export const getResourceTypes = () => {
  return api.get('/api/luchu/logs/resource-types')
}

// ============ 图片代理 ============

/**
 * 获取图片代理 URL
 * 用于绕过商家网站的防盗链限制
 * @param {string} originalUrl - 原始图片 URL
 * @returns {string} 代理后的图片 URL
 */
export const getProxyImageUrl = (originalUrl) => {
  if (!originalUrl) return ''
  
  // 如果已经是相对路径或本地图片，直接返回
  if (originalUrl.startsWith('/') || originalUrl.startsWith('data:')) {
    return originalUrl
  }
  
  // 获取 API 基础 URL
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'https://api.google-data-analysis.top'
  
  // 返回代理 URL
  return `${apiBaseUrl}/api/luchu/images/proxy-public?url=${encodeURIComponent(originalUrl)}`
}

export default {
  // 文章
  getArticles,
  getArticle,
  createArticle,
  updateArticle,
  deleteArticle,
  submitArticle,
  getArticleVersions,
  restoreVersion,
  // AI
  analyzeMerchant,
  generateArticle,
  regenerateSection,
  // 审核
  getPendingReviews,
  approveArticle,
  rejectArticle,
  selfCheckArticle,
  // 发布
  getReadyToPublish,
  publishArticle,
  getPublishLogs,
  // 网站
  getWebsites,
  getWebsite,
  updateWebsite,
  createWebsite,
  // 统计
  getDashboardStats,
  getPublishTrend,
  getCategoryStats,
  getReviewEfficiency,
  // 通知
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  // 提示词
  getPromptTemplates,
  getPromptTemplate,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
  // 日志
  getOperationLogs,
  getActionTypes,
  getResourceTypes,
  // 图片代理
  getProxyImageUrl,
}

