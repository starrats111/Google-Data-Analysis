import api from './api'
import { getToken } from './tokenHolder'

const articleApi = {
  // 文章 CRUD
  getArticles: (params) => api.get('/api/articles', { params }),
  getArticle: (id) => api.get(`/api/articles/${id}`),
  createArticle: (data) => api.post('/api/articles', data),
  updateArticle: (id, data) => api.put(`/api/articles/${id}`, data),
  deleteArticle: (id) => api.delete(`/api/articles/${id}`),
  getArticleVersions: (id) => api.get(`/api/articles/${id}/versions`),

  // AI 生成
  generateTitles: (data) => api.post('/api/article-gen/titles', data),
  generateArticle: (data) => api.post('/api/article-gen/article', data),
  generateImages: (data) => api.post('/api/article-gen/images', data),

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
  crawlMerchant: (data) => api.post('/api/article-gen/crawl', data),
  generateMerchantArticle: async (data, onProgress) => {
    const baseUrl = api.defaults.baseURL || ''
    const headers = { 'Content-Type': 'application/json' }
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const resp = await fetch(`${baseUrl}/api/article-gen/merchant-article`, {
      method: 'POST', headers, body: JSON.stringify(data), credentials: 'include',
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: '生成失败' }))
      throw new Error(err.detail || '生成失败')
    }
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.status === 'generating' && onProgress) onProgress(parsed.progress)
            if (parsed.status === 'done') result = parsed.result
            if (parsed.status === 'error') throw new Error(parsed.detail)
          } catch (e) { if (e.message !== 'generating') throw e }
        }
      }
    }
    return { data: result }
  },
  getTrackingLinks: (params) => api.get('/api/article-gen/tracking-links', { params }),
  searchImages: (data) => api.post('/api/article-gen/search-images', data),

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
}

export default articleApi
