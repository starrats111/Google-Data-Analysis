import React from 'react'
import { Button, Result } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

/**
 * 错误边界组件
 * 捕获子组件的渲染错误，防止白屏
 */
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
    // 更新 state 使下一次渲染显示错误 UI
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    this.setState({ errorInfo })
  }

  handleReload = () => {
    // 清除缓存并重新加载页面
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
      const isChunkError = this.state.error?.message?.includes('Loading chunk') ||
                           this.state.error?.message?.includes('Failed to fetch') ||
                           this.state.error?.message?.includes('dynamically imported module')

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
            title={isChunkError ? "页面加载失败" : "页面出现错误"}
            subTitle={
              isChunkError 
                ? "网络连接问题或页面已更新，请刷新重试"
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
          {this.state.error && (
            <div style={{
              background: '#1a1a2e',
              color: '#e94560',
              padding: '16px 24px',
              borderRadius: '8px',
              marginTop: '16px',
              maxWidth: '90vw',
              maxHeight: '300px',
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              <div style={{ color: '#fff', marginBottom: '8px', fontWeight: 'bold' }}>
                {this.state.error?.name}: {this.state.error?.message}
              </div>
              <div style={{ color: '#aaa' }}>
                {this.state.error?.stack}
              </div>
              {this.state.errorInfo?.componentStack && (
                <div style={{ color: '#888', marginTop: '8px', borderTop: '1px solid #333', paddingTop: '8px' }}>
                  {this.state.errorInfo.componentStack}
                </div>
              )}
            </div>
          )}
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary

