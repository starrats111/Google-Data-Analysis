/**
 * API请求缓存和防抖工具
 * 用于优化网络请求，减少重复请求
 */

// 请求缓存存储
const requestCache = new Map()

// 正在进行中的请求
const pendingRequests = new Map()

// 默认缓存时间（5分钟）
const DEFAULT_CACHE_TTL = 5 * 60 * 1000

/**
 * 生成缓存键
 */
export function generateCacheKey(url, params = {}) {
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${JSON.stringify(params[key])}`)
    .join('&')
  return `${url}?${sortedParams}`
}

/**
 * 获取缓存数据
 */
export function getCachedData(key) {
  const cached = requestCache.get(key)
  if (!cached) return null
  
  // 检查是否过期
  if (Date.now() > cached.expireAt) {
    requestCache.delete(key)
    return null
  }
  
  return cached.data
}

/**
 * 设置缓存数据
 */
export function setCacheData(key, data, ttl = DEFAULT_CACHE_TTL) {
  requestCache.set(key, {
    data,
    expireAt: Date.now() + ttl,
    createdAt: Date.now()
  })
}

/**
 * 清除指定缓存
 */
export function clearCache(keyPattern) {
  if (!keyPattern) {
    requestCache.clear()
    return
  }
  
  for (const key of requestCache.keys()) {
    if (key.includes(keyPattern)) {
      requestCache.delete(key)
    }
  }
}

/**
 * 带缓存的请求包装器
 * @param {Function} requestFn - 返回Promise的请求函数
 * @param {string} cacheKey - 缓存键
 * @param {number} ttl - 缓存时间（毫秒）
 * @returns {Promise}
 */
export async function cachedRequest(requestFn, cacheKey, ttl = DEFAULT_CACHE_TTL) {
  // 先检查缓存
  const cached = getCachedData(cacheKey)
  if (cached !== null) {
    return cached
  }
  
  // 检查是否有相同的请求正在进行
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey)
  }
  
  // 创建新请求
  const requestPromise = requestFn()
    .then(response => {
      // 缓存响应
      setCacheData(cacheKey, response, ttl)
      pendingRequests.delete(cacheKey)
      return response
    })
    .catch(error => {
      pendingRequests.delete(cacheKey)
      throw error
    })
  
  pendingRequests.set(cacheKey, requestPromise)
  return requestPromise
}

/**
 * 防抖函数
 * @param {Function} fn - 要防抖的函数
 * @param {number} delay - 延迟时间（毫秒）
 * @returns {Function}
 */
export function debounce(fn, delay = 300) {
  let timeoutId = null
  
  const debouncedFn = function (...args) {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    
    return new Promise((resolve, reject) => {
      timeoutId = setTimeout(async () => {
        try {
          const result = await fn.apply(this, args)
          resolve(result)
        } catch (error) {
          reject(error)
        }
      }, delay)
    })
  }
  
  debouncedFn.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }
  
  return debouncedFn
}

/**
 * 节流函数
 * @param {Function} fn - 要节流的函数
 * @param {number} limit - 时间限制（毫秒）
 * @returns {Function}
 */
export function throttle(fn, limit = 1000) {
  let inThrottle = false
  let lastResult = null
  
  return function (...args) {
    if (!inThrottle) {
      inThrottle = true
      lastResult = fn.apply(this, args)
      
      setTimeout(() => {
        inThrottle = false
      }, limit)
    }
    
    return lastResult
  }
}

/**
 * 批量请求合并
 * 将多个相同类型的请求合并为一个
 */
class BatchRequester {
  constructor(batchFn, delay = 50) {
    this.batchFn = batchFn
    this.delay = delay
    this.pending = []
    this.timeoutId = null
  }
  
  add(item) {
    return new Promise((resolve, reject) => {
      this.pending.push({ item, resolve, reject })
      
      if (!this.timeoutId) {
        this.timeoutId = setTimeout(() => this.flush(), this.delay)
      }
    })
  }
  
  async flush() {
    const batch = this.pending
    this.pending = []
    this.timeoutId = null
    
    if (batch.length === 0) return
    
    try {
      const items = batch.map(b => b.item)
      const results = await this.batchFn(items)
      
      batch.forEach((b, index) => {
        b.resolve(results[index])
      })
    } catch (error) {
      batch.forEach(b => b.reject(error))
    }
  }
}

export { BatchRequester }

// 导出缓存统计信息（调试用）
export function getCacheStats() {
  let validCount = 0
  let expiredCount = 0
  const now = Date.now()
  
  for (const [key, value] of requestCache.entries()) {
    if (now > value.expireAt) {
      expiredCount++
    } else {
      validCount++
    }
  }
  
  return {
    total: requestCache.size,
    valid: validCount,
    expired: expiredCount,
    pending: pendingRequests.size
  }
}

