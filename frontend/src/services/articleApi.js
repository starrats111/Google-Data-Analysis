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
}

export default articleApi
