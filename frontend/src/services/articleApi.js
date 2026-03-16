import api from './api'

const articleApi = {
  // 文章 CRUD
  getArticles: (params) => api.get('/api/articles', { params }),
  getArticle: (id) => api.get(`/api/articles/${id}`),
  createArticle: (data) => api.post('/api/articles', data),
  updateArticle: (id, data) => api.put(`/api/articles/${id}`, data),
  deleteArticle: (id) => api.delete(`/api/articles/${id}`),
  getArticleVersions: (id) => api.get(`/api/articles/${id}/versions`),

  // AI 生成
  generateTitles: (data) => api.post('/api/article-gen/titles', data, { timeout: 300000 }),
  generateArticle: (data) => api.post('/api/article-gen/article', data, { timeout: 600000 }),
  generateImages: (data) => api.post('/api/article-gen/images', data, { timeout: 300000 }),

  // 分类
  getCategories: () => api.get('/api/article-categories'),
  createCategory: (data) => api.post('/api/article-categories', data),
  updateCategory: (id, data) => api.put(`/api/article-categories/${id}`, data),
  deleteCategory: (id) => api.delete(`/api/article-categories/${id}`),

  // 标签
  getTags: () => api.get('/api/article-tags'),
  createTag: (data) => api.post('/api/article-tags', data),
  deleteTag: (id) => api.delete(`/api/article-tags/${id}`),

  // 标题库
  getTitles: (params) => api.get('/api/article-titles', { params }),
  batchCreateTitles: (data) => api.post('/api/article-titles/batch', data),
  deleteTitle: (id) => api.delete(`/api/article-titles/${id}`),

  // 商家推广（OPT-012）
  crawlMerchant: (data) => api.post('/api/article-gen/crawl', data, { timeout: 300000 }),
  generateMerchantArticle: async (data, onProgress) => {
    // 1. 提交后台任务（秒级返回）
    const submitRes = await api.post('/api/article-gen/merchant-article', data, { timeout: 30000 })
    const taskId = submitRes.data?.task_id
    if (!taskId) throw new Error('任务提交失败')

    // 2. 轮询状态（每 3 秒，最多 10 分钟）
    const maxAttempts = 200
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        const statusRes = await api.get(`/api/article-gen/merchant-article/${taskId}/status`, { timeout: 15000 })
        const { status, progress, result, error } = statusRes.data || {}
        if (onProgress && progress) onProgress(progress)
        if (status === 'done' && result) return { data: result }
        if (status === 'error') throw new Error(error || '文章生成失败')
      } catch (e) {
        // 网络抖动时继续轮询，不立即报错
        if (e.response?.status === 404) throw new Error('任务不存在或已过期')
        if (e.message?.includes('文章生成失败')) throw e
        if (i > 5) console.warn(`轮询第 ${i + 1} 次网络异常，继续重试...`)
      }
    }
    throw new Error('文章生成超时，请刷新页面查看文章列表')
  },
  getTrackingLinks: (params) => api.get('/api/article-gen/tracking-links', { params }),
  searchImages: (data) => api.post('/api/article-gen/search-images', data),
  analyzeUrl: (data) => api.post('/api/article-gen/analyze-url', data),

  // Campaign Links（OPT-015）
  getCampaignLink: (data) => api.post('/api/article-gen/campaign-link', data),
  getUserPlatforms: () => api.get('/api/article-gen/user-platforms'),

  // 网站管理（OPT-013）
  getSites: () => api.get('/api/sites'),
  createSite: (data) => api.post('/api/sites', data),
  updateSite: (id, data) => api.put(`/api/sites/${id}`, data),
  deleteSite: (id) => api.delete(`/api/sites/${id}`),
  verifySite: (id) => api.post(`/api/sites/${id}/verify`),
  publishToSite: (articleId, siteId) => api.post(`/api/articles/${articleId}/publish-to-site`, { site_id: siteId }),
  unpublishFromSite: (articleId) => api.delete(`/api/articles/${articleId}/unpublish-from-site`),

  // 图片缓存（CR-040）
  uploadImageToCache: (data) => api.post('/api/article-gen/image-cache/upload-base64', data),
  cleanupImageCache: (sessionId) => api.delete(`/api/article-gen/image-cache/${sessionId}`),
}

export default articleApi
