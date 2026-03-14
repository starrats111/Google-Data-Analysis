import React from 'react'
import { Button, Result } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

/**
 * 错误边界组件
 * 捕获子组件的渲染错误，防止白屏
 */
const RELOAD_KEY = '__chunk_reload__'

function isChunkError(error) {
  const msg = error?.message || ''
  return msg.includes('Loading chunk') ||
    msg.includes('Failed to fetch') ||
    msg.includes('dynamically imported module') ||
    msg.includes('Importing a module script failed')
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { 
      hasError: false, 
      error: null,
      errorInfo: null 
    }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    this.setState({ errorInfo })

    if (isChunkError(error)) {
      const lastReload = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
      if (Date.now() - lastReload > 10000) {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
        window.location.reload()
      }
    }
  }

  handleReload = () => {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => caches.delete(name))
      })
    }
    window.location.reload()
  }

  handleGoHome = () => {
    window.location.href = '/'
  }

  render() {
    if (this.state.hasError) {
      const chunkErr = isChunkError(this.state.error)

      return (
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column',
          justifyContent: 'center', 
          alignItems: 'center', 
          minHeight: '100vh',
          background: 'linear-gradient(135deg, #4DA6FF 0%, #7B68EE 100%)',
          padding: '20px'
        }}>
          <Result
            status="warning"
            title={chunkErr ? "页面版本已更新" : "页面出现错误"}
            subTitle={
              chunkErr 
                ? "系统已部署新版本，正在自动刷新..."
                : "抱歉，页面渲染时出现了问题"
            }
            style={{ 
              background: 'white', 
              borderRadius: '16px', 
              padding: '40px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
              maxWidth: '90vw'
            }}
            extra={[
              <Button 
                type="primary" 
                key="reload" 
                icon={<ReloadOutlined />}
                onClick={this.handleReload}
                size="large"
              >
                刷新页面
              </Button>,
              <Button 
                key="home" 
                onClick={this.handleGoHome}
                size="large"
              >
                返回首页
              </Button>,
            ]}
          />
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary

