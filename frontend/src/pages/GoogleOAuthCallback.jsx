import React, { useEffect, useState } from 'react'
import { Card, Alert, Button, Space } from 'antd'
import { CheckCircleOutlined, CopyOutlined } from '@ant-design/icons'
import { useSearchParams, useNavigate } from 'react-router-dom'

export default function GoogleOAuthCallback() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const codeParam = searchParams.get('code')
    const errorParam = searchParams.get('error')

    if (errorParam) {
      setError(`授权失败: ${errorParam}`)
    } else if (codeParam) {
      setCode(codeParam)
    } else {
      setError('未找到授权码，请重新授权')
    }
  }, [searchParams])

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    alert('授权码已复制到剪贴板！')
  }

  return (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center', 
      minHeight: '100vh',
      padding: '20px'
    }}>
      <Card style={{ width: '100%', maxWidth: 600 }}>
        {error ? (
          <Alert
            message="授权失败"
            description={error}
            type="error"
            showIcon
            action={
              <Button size="small" onClick={() => window.close()}>
                关闭
              </Button>
            }
          />
        ) : code ? (
          <>
            <Alert
              message="授权成功！"
              description="请复制下面的授权码，然后回到MCC账号编辑页面粘贴并获取Token。"
              type="success"
              showIcon
              style={{ marginBottom: 24 }}
            />
            
            <div style={{ marginBottom: 16 }}>
              <strong>授权码：</strong>
              <div style={{ 
                marginTop: 8,
                padding: '12px',
                backgroundColor: '#f5f5f5',
                borderRadius: '4px',
                wordBreak: 'break-all',
                fontFamily: 'monospace'
              }}>
                {code}
              </div>
            </div>

            <Space>
              <Button 
                type="primary" 
                icon={<CopyOutlined />}
                onClick={handleCopy}
              >
                复制授权码
              </Button>
              <Button onClick={() => window.close()}>
                关闭窗口
              </Button>
            </Space>

            <div style={{ marginTop: 24, padding: '16px', backgroundColor: '#EBF5FF', borderRadius: '4px' }}>
              <strong>下一步：</strong>
              <ol style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
                <li>复制上面的授权码</li>
                <li>回到MCC账号编辑页面</li>
                <li>在"获取Refresh Token"对话框中粘贴授权码</li>
                <li>点击"获取Token"按钮</li>
              </ol>
            </div>
          </>
        ) : (
          <Alert
            message="正在处理..."
            description="请稍候..."
            type="info"
            showIcon
          />
        )}
      </Card>
    </div>
  )
}

