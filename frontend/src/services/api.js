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

// 请求拦截器：添加Token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  // 调试：记录请求URL的详细信息
  const fullUrl = config.baseURL + config.url
  console.log('[API Request]', {
    method: config.method?.toUpperCase(),
    url: config.url,
    baseURL: config.baseURL,
    fullURL: fullUrl,
    headers: config.headers,
    // 检查URL是否被修改
    urlType: typeof config.url,
    urlLength: config.url?.length
  })
  
  // 确保URL格式正确
  if (config.url && config.url.includes('mcc-accounts')) {
    console.error('[URL ERROR] 检测到错误的URL格式:', config.url)
    console.error('[URL ERROR] 应该使用 /api/mcc/accounts 而不是', config.url)
    // 尝试修复URL
    config.url = config.url.replace(/mcc-accounts:?\d*/, 'mcc/accounts')
    console.log('[URL FIX] 已修复URL为:', config.url)
  }
  
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















