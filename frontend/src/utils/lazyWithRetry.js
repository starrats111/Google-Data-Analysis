import { lazy } from 'react'

const RELOAD_KEY = '__chunk_reload__'

function isChunkError(error) {
  const msg = error?.message || ''
  return msg.includes('Loading chunk') ||
    msg.includes('Failed to fetch') ||
    msg.includes('dynamically imported module') ||
    msg.includes('Importing a module script failed')
}

/**
 * 带自动刷新的懒加载
 * chunk 文件因新版本部署而不存在时，自动刷新页面获取新 index.html
 * 通过 sessionStorage 记录时间戳防止无限刷新（10秒内不重复刷新）
 */
export function lazyWithRetry(componentImport) {
  return lazy(async () => {
    try {
      return await componentImport()
    } catch (error) {
      if (isChunkError(error)) {
        const lastReload = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
        const now = Date.now()
        if (now - lastReload > 10000) {
          sessionStorage.setItem(RELOAD_KEY, String(now))
          if ('caches' in window) {
            const names = await caches.keys()
            await Promise.all(names.map(n => caches.delete(n)))
          }
          window.location.reload()
          return { default: () => null }
        }
      }
      throw error
    }
  })
}

export function preloadComponent(componentImport) {
  try { componentImport() } catch {}
}

export default lazyWithRetry

