import { lazy } from 'react'

/**
 * 带重试机制的懒加载
 * 当 chunk 加载失败时自动重试（最多3次）
 * 
 * @param {Function} componentImport - 动态导入函数，如 () => import('./MyComponent')
 * @param {number} retries - 最大重试次数
 * @returns {React.LazyExoticComponent}
 */
export function lazyWithRetry(componentImport, retries = 3) {
  return lazy(async () => {
    let lastError
    
    for (let i = 0; i < retries; i++) {
      try {
        // 如果不是第一次尝试，添加随机参数强制绕过缓存
        if (i > 0) {
          console.log(`[LazyLoad] 第 ${i + 1} 次重试加载组件...`)
          // 等待一小段时间后重试
          await new Promise(resolve => setTimeout(resolve, 500 * i))
        }
        
        const component = await componentImport()
        return component
        
      } catch (error) {
        lastError = error
        console.warn(`[LazyLoad] 加载失败 (尝试 ${i + 1}/${retries}):`, error.message)
        
        // 如果是最后一次重试，尝试清除缓存
        if (i === retries - 1) {
          // 检测是否是 chunk 加载失败
          if (error.message?.includes('Loading chunk') || 
              error.message?.includes('Failed to fetch') ||
              error.message?.includes('dynamically imported module')) {
            console.log('[LazyLoad] 检测到 chunk 加载失败，尝试清除缓存...')
            
            // 清除 Service Worker 缓存
            if ('caches' in window) {
              try {
                const cacheNames = await caches.keys()
                await Promise.all(cacheNames.map(name => caches.delete(name)))
                console.log('[LazyLoad] 缓存已清除')
              } catch (e) {
                console.warn('[LazyLoad] 清除缓存失败:', e)
              }
            }
          }
        }
      }
    }
    
    // 所有重试都失败，抛出错误
    throw lastError
  })
}

/**
 * 预加载组件
 * 用于在用户可能导航到某个页面之前预先加载
 * 
 * @param {Function} componentImport - 动态导入函数
 */
export function preloadComponent(componentImport) {
  try {
    componentImport()
  } catch (e) {
    // 预加载失败不影响正常使用
    console.warn('[Preload] 预加载失败:', e)
  }
}

export default lazyWithRetry

