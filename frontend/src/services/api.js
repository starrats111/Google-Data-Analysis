import axios from 'axios'

// 获取API基础URL
const getApiBaseUrl = () => {
  // 优先使用环境变量
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL
  }
  
  // 生产环境：使用API子域名
  if (window.location.hostname === 'google-data-analysis.top' || 
      window.location.hostname === 'www.google-data-analysis.top') {
    return 'https://api.google-data-analysis.top'
  }
  
  // 开发环境：使用本地服务器
  return 'http://localhost:8000'
}

const API_BASE_URL = getApiBaseUrl()

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器：添加Token和URL修复
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  
  // 强制修复错误的URL格式（处理缓存导致的错误URL）
  if (config.url) {
    // 修复 mcc-accounts:1 或 mcc-accounts 为 mcc/accounts
    if (config.url.includes('mcc-accounts')) {
      const originalUrl = config.url
      config.url = config.url.replace(/\/api\/mcc-accounts:?\d*/g, '/api/mcc/accounts')
      config.url = config.url.replace(/mcc-accounts:?\d*/g, 'mcc/accounts')
      if (originalUrl !== config.url) {
        console.warn('[URL修复]', originalUrl, '→', config.url)
      }
    }
    
    // 确保URL以 / 开头
    if (!config.url.startsWith('/')) {
      config.url = '/' + config.url
    }
  }
  
  // 调试：记录最终请求URL
  const fullUrl = (config.baseURL || '') + config.url
  console.log('[API请求]', config.method?.toUpperCase(), config.url, '→', fullUrl)
  
  return config
})

// 响应拦截器：处理错误
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default api















