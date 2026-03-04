import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './index.css'
import './styles/global.css'
// 全局 dayjs 配置（设置默认时区为中国）
import './utils/dayjs'
// 天际蓝主题配置
import themeConfig from './styles/themeConfig'

// #region agent log
const __agentLog = (hypothesisId, location, message, data = {}, runId = 'run1') => {
  fetch('', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6b95b2' }, body: JSON.stringify({ sessionId: '6b95b2', runId, hypothesisId, location, message, data, timestamp: Date.now() }) }).catch(() => {})
}
window.__agentLog = __agentLog

window.addEventListener('error', (event) => {
  __agentLog('H2', 'src/main.jsx:error-listener', 'window error captured', {
    message: event?.message,
    filename: event?.filename,
    lineno: event?.lineno,
    colno: event?.colno,
    stack: event?.error?.stack,
  })
}, true)

window.addEventListener('unhandledrejection', (event) => {
  __agentLog('H3', 'src/main.jsx:unhandledrejection', 'promise rejection captured', {
    reason: event?.reason?.message || String(event?.reason),
    stack: event?.reason?.stack,
  })
}, true)

__agentLog('H1', 'src/main.jsx:startup', 'startup resources snapshot', {
  href: window.location.href,
  userAgent: navigator.userAgent,
  scripts: Array.from(document.querySelectorAll('script[src]')).map((s) => s.src),
  modulepreloads: Array.from(document.querySelectorAll('link[rel="modulepreload"]')).map((l) => l.href),
  buildMetaVersion: document.querySelector('meta[name="version"]')?.getAttribute('content') || null,
})
// #endregion

// 隐藏初始 loading 状态
function hideInitialLoading() {
  const loadingEl = document.getElementById('initial-loading')
  if (loadingEl) {
    loadingEl.classList.add('fade-out')
    setTimeout(() => {
      loadingEl.remove()
    }, 300)
  }
}

// React 渲染完成后隐藏初始 loading
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
)

// 延迟隐藏 loading，确保 React 渲染完成
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    hideInitialLoading()
  })
})


















