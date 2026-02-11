import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './index.css'
// 全局 dayjs 配置（设置默认时区为中国）
import './utils/dayjs'

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
    <ConfigProvider locale={zhCN}>
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


















