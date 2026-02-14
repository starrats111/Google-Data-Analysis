import axios from 'axios'
import { generateCacheKey, getCachedData, setCacheData } from './apiCache'

// 正在进行的请求（用于取消重复请求）
const pendingRequests = new Map()

// 生成请求唯一标识
const getRequestKey = (config) => {
  return `${config.method}:${config.url}:${JSON.stringify(config.params || {})}:${JSON.stringify(config.data || {})}`
}

// 获取API基础URL
const getApiBaseUrl = () => {
  // 优先使用环境变量
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL
  }
  
  const hostname = window.location.hostname
  
  // 生产环境：使用API子域名
  // 包括自定义域名和 Cloudflare Pages 域名
  if (hostname === 'google-data-analysis.top' || 
      hostname === 'www.google-data-analysis.top' ||
      hostname.endsWith('.google-data-analysis.pages.dev') ||
      hostname === 'google-data-analysis.pages.dev') {
    return 'https://api.google-data-analysis.top'
  }
  
  // 开发环境：使用本地服务器
  return 'http://localhost:8000'
}

const API_BASE_URL = getApiBaseUrl()

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 120000, // 120秒超时，AI分析可能需要较长时间
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // 允许跨域请求携带 Cookie（Refresh Token）
})

// 请求拦截器：添加Token、URL修复、取消重复请求
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
  
  // 取消重复的GET请求（同一个GET请求如果正在进行中，取消之前的）
  if (config.method?.toLowerCase() === 'get' && !config.skipDuplicateCancel) {
    const requestKey = getRequestKey(config)
    
    // 如果有相同的请求正在进行，取消它
    if (pendingRequests.has(requestKey)) {
      const controller = pendingRequests.get(requestKey)
      controller.abort()
    }
    
    // 创建新的AbortController
    const controller = new AbortController()
    config.signal = controller.signal
    pendingRequests.set(requestKey, controller)
    
    // 保存key到config用于响应后清理
    config._requestKey = requestKey
  }
  
  // GET请求缓存检查（仅对标记为可缓存的请求）
  if (config.method?.toLowerCase() === 'get' && config.useCache) {
    const cacheKey = generateCacheKey(config.url, config.params)
    const cached = getCachedData(cacheKey)
    if (cached) {
      // 返回一个特殊的已取消请求，但带有缓存数据
      config._cachedResponse = cached
    }
    config._cacheKey = cacheKey
  }
  
  // 调试：记录最终请求URL（仅开发环境）
  if (import.meta.env.DEV) {
    const fullUrl = (config.baseURL || '') + config.url
    console.log('[API请求]', config.method?.toUpperCase(), config.url, '→', fullUrl)
  }
  
  return config
})

// 刷新 Token 的并发控制
let isRefreshing = false
let refreshSubscribers = []

// 订阅刷新完成事件
const subscribeTokenRefresh = (callback) => {
  refreshSubscribers.push(callback)
}

// 通知所有订阅者刷新完成
const onTokenRefreshed = (newToken) => {
  refreshSubscribers.forEach(callback => callback(newToken))
  refreshSubscribers = []
}

// 通知所有订阅者刷新失败
const onTokenRefreshFailed = () => {
  refreshSubscribers.forEach(callback => callback(null))
  refreshSubscribers = []
}

// 响应拦截器：处理错误、清理pending请求、缓存响应
api.interceptors.response.use(
  (response) => {
    // 清理pending请求
    const requestKey = response.config._requestKey
    if (requestKey && pendingRequests.has(requestKey)) {
      pendingRequests.delete(requestKey)
    }
    
    // 缓存GET请求响应
    const cacheKey = response.config._cacheKey
    if (cacheKey && response.config.useCache) {
      const cacheTTL = response.config.cacheTTL || 5 * 60 * 1000 // 默认5分钟
      setCacheData(cacheKey, response, cacheTTL)
    }
    
    return response
  },
  async (error) => {
    // 清理pending请求
    const requestKey = error.config?._requestKey
    if (requestKey && pendingRequests.has(requestKey)) {
      pendingRequests.delete(requestKey)
    }
    
    // 忽略取消的请求
    if (axios.isCancel(error) || error.name === 'CanceledError' || error.name === 'AbortError') {
      return Promise.reject({ isCanceled: true, message: '请求已取消' })
    }
    
    // 处理超时错误
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      console.error('请求超时:', error.config?.url)
      error.message = '请求超时，请检查网络连接或稍后重试'
    }
    
    // 处理网络错误
    if (!error.response && error.request) {
      console.error('网络错误:', error.config?.url)
      error.message = '网络错误，请检查网络连接'
    }
    
    // 处理401未授权 - 尝试刷新 Token
    if (error.response?.status === 401) {
      const originalRequest = error.config
      
      // 避免刷新接口本身401时无限循环
      if (originalRequest.url?.includes('/api/auth/refresh') || 
          originalRequest.url?.includes('/api/auth/login')) {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        window.location.href = '/login'
        return Promise.reject(error)
      }
      
      // 避免重复请求
      if (originalRequest._retry) {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        window.location.href = '/login'
        return Promise.reject(error)
      }
      
      // 如果正在刷新，等待刷新完成后重试
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          subscribeTokenRefresh((newToken) => {
            if (newToken) {
              originalRequest.headers.Authorization = `Bearer ${newToken}`
              resolve(api(originalRequest))
            } else {
              reject(error)
            }
          })
        })
      }
      
      // 开始刷新
      originalRequest._retry = true
      isRefreshing = true
      
      try {
        const response = await api.post('/api/auth/refresh')
        const newToken = response.data.access_token
        
        // 保存新 Token
        localStorage.setItem('token', newToken)
        
        // 通知所有等待的请求
        onTokenRefreshed(newToken)
        isRefreshing = false
        
        // 重试原请求
        originalRequest.headers.Authorization = `Bearer ${newToken}`
        return api(originalRequest)
      } catch (refreshError) {
        // 刷新失败，清除登录状态
        onTokenRefreshFailed()
        isRefreshing = false
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        window.location.href = '/login'
        return Promise.reject(refreshError)
      }
    }
    
    return Promise.reject(error)
  }
)

export default api















