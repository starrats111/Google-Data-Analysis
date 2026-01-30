import React, { useState, useEffect } from 'react'
import { Card, Form, Input, Button, Steps, message, Space, Typography, Alert, Divider } from 'antd'
import { CheckCircleOutlined, CopyOutlined, LinkOutlined } from '@ant-design/icons'
import api from '../services/api'

const { Title, Paragraph, Text } = Typography
const { TextArea } = Input

const OAuthTool = () => {
  const [currentStep, setCurrentStep] = useState(0)
  const [form] = Form.useForm()
  const [authorizationUrl, setAuthorizationUrl] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [sharedConfig, setSharedConfig] = useState({ client_id: '', client_secret: '', has_shared_config: false })

  // 从后端获取共享配置
  useEffect(() => {
    const fetchSharedConfig = async () => {
      try {
        const response = await api.get('/api/oauth/shared-credentials')
        setSharedConfig(response.data)
        
        // 如果存在共享配置，自动填充表单
        if (response.data.has_shared_config) {
          form.setFieldsValue({
            client_id: response.data.client_id,
            client_secret: response.data.client_secret
          })
        }
      } catch (error) {
        // 忽略错误，可能是旧版本后端不支持
        console.warn('无法获取共享配置:', error)
      }
    }
    
    fetchSharedConfig()
  }, [form])

  const handleGetAuthUrl = async (values) => {
    setLoading(true)
    try {
      // 优先使用表单值，如果没有则使用共享配置
      const clientId = values.client_id || sharedConfig.client_id
      const clientSecret = values.client_secret || sharedConfig.client_secret

      if (!clientId || !clientSecret) {
        message.error('请填写客户端ID和客户端密钥')
        return
      }

      const response = await api.get('/api/oauth/authorize', {
        params: {
          client_id: clientId,
          client_secret: clientSecret
        }
      })

      setAuthorizationUrl(response.data.authorization_url)
      setCurrentStep(1)
      message.success('授权URL已生成，请在新窗口中打开')
    } catch (error) {
      message.error(error.response?.data?.detail || '生成授权URL失败')
    } finally {
      setLoading(false)
    }
  }

  const handleExchangeCode = async () => {
    if (!authCode) {
      message.error('请先粘贴授权码')
      return
    }

    setLoading(true)
    try {
      const values = form.getFieldsValue()
      const clientId = values.client_id || sharedConfig.client_id
      const clientSecret = values.client_secret || sharedConfig.client_secret

      const response = await api.post('/api/oauth/exchange', null, {
        params: {
          code: authCode.trim(),
          client_id: clientId,
          client_secret: clientSecret
        }
      })

      if (response.data.success) {
        setRefreshToken(response.data.refresh_token)
        setCurrentStep(2)
        message.success('刷新令牌获取成功！')
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '交换令牌失败')
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      message.success('已复制到剪贴板')
    })
  }

  const steps = [
    {
      title: '输入信息',
      description: '填写客户端ID和密钥'
    },
    {
      title: '完成授权',
      description: '在浏览器中完成Google授权'
    },
    {
      title: '获取令牌',
      description: '复制刷新令牌'
    }
  ]

  return (
    <div style={{ padding: '24px', maxWidth: '900px', margin: '0 auto' }}>
      <Card>
        <Title level={2}>🔑 获取Google Ads刷新令牌工具</Title>
        <Paragraph>
          这个工具可以帮助你获取Google Ads API的刷新令牌，无需安装Python或访问本地文件。
        </Paragraph>

        <Steps current={currentStep} items={steps} style={{ marginBottom: '32px' }} />

        {/* 步骤1：输入信息 */}
        {currentStep === 0 && (
          <Form
            form={form}
            layout="vertical"
            onFinish={handleGetAuthUrl}
            initialValues={{
              client_id: sharedClientId,
              client_secret: sharedClientSecret
            }}
          >
            <Alert
              message={sharedConfig.has_shared_config ? "✅ 已自动填充共享配置" : "提示"}
              description={
                sharedConfig.has_shared_config 
                  ? "下面的字段已自动填充，可以直接点击"生成授权URL"。如果需要使用其他配置，可以手动修改。"
                  : "如果经理已配置共享配置，下面的字段会自动填充。如果没有，请向经理获取客户端ID和密钥。"
              }
              type={sharedConfig.has_shared_config ? "success" : "info"}
              showIcon
              style={{ marginBottom: '24px' }}
            />

            <Form.Item
              label="客户端ID (Client ID)"
              name="client_id"
              rules={[{ required: true, message: '请输入客户端ID' }]}
            >
              <Input 
                placeholder="例如: 123456789-xxx.apps.googleusercontent.com" 
                disabled={sharedConfig.has_shared_config && sharedConfig.client_id}
              />
            </Form.Item>

            <Form.Item
              label="客户端密钥 (Client Secret)"
              name="client_secret"
              rules={[{ required: true, message: '请输入客户端密钥' }]}
            >
              <Input.Password 
                placeholder="例如: GOCSPX-xxx"
                disabled={sharedConfig.has_shared_config && sharedConfig.client_secret}
              />
            </Form.Item>

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} size="large">
                生成授权URL
              </Button>
            </Form.Item>
          </Form>
        )}

        {/* 步骤2：完成授权 */}
        {currentStep === 1 && (
          <div>
            <Alert
              message="重要提示"
              description={
                <div>
                  <p>1. 点击下面的按钮，在新窗口中打开授权页面</p>
                  <p>2. 使用你的Google账号完成授权</p>
                  <p>3. 授权成功后，会显示一个授权码</p>
                  <p>4. 复制授权码，粘贴到下面的输入框中</p>
                </div>
              }
              type="warning"
              showIcon
              style={{ marginBottom: '24px' }}
            />

            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <Button
                type="primary"
                icon={<LinkOutlined />}
                size="large"
                onClick={() => window.open(authorizationUrl, '_blank')}
                block
              >
                在新窗口中打开授权页面
              </Button>

              <Divider>或复制链接</Divider>

              <Input.Group compact>
                <Input
                  value={authorizationUrl}
                  readOnly
                  style={{ width: 'calc(100% - 80px)' }}
                />
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => copyToClipboard(authorizationUrl)}
                >
                  复制
                </Button>
              </Input.Group>

              <Divider>粘贴授权码</Divider>

              <TextArea
                rows={4}
                placeholder="从授权页面复制授权码，粘贴到这里"
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
              />

              <Space>
                <Button onClick={() => setCurrentStep(0)}>上一步</Button>
                <Button
                  type="primary"
                  onClick={handleExchangeCode}
                  loading={loading}
                  disabled={!authCode}
                >
                  获取刷新令牌
                </Button>
              </Space>
            </Space>
          </div>
        )}

        {/* 步骤3：显示刷新令牌 */}
        {currentStep === 2 && (
          <div>
            <Alert
              message="✅ 成功！"
              description="请保存下面的刷新令牌，在添加MCC账号时会用到。"
              type="success"
              showIcon
              style={{ marginBottom: '24px' }}
            />

            <Card>
              <Title level={4}>刷新令牌 (Refresh Token)</Title>
              <Input.Group compact>
                <Input
                  value={refreshToken}
                  readOnly
                  style={{ width: 'calc(100% - 80px)' }}
                />
                <Button
                  type="primary"
                  icon={<CopyOutlined />}
                  onClick={() => copyToClipboard(refreshToken)}
                >
                  复制
                </Button>
              </Input.Group>

              <Divider />

              <Paragraph>
                <Text strong>下一步：</Text>
                <ol>
                  <li>复制上面的刷新令牌</li>
                  <li>登录系统，进入"MCC账号"页面</li>
                  <li>点击"添加MCC账号"</li>
                  <li>填写MCC账号ID和这个刷新令牌</li>
                  <li>保存并测试连接</li>
                </ol>
              </Paragraph>

              <Button onClick={() => {
                setCurrentStep(0)
                setRefreshToken('')
                setAuthCode('')
                setAuthorizationUrl('')
                form.resetFields()
              }}>
                重新开始
              </Button>
            </Card>
          </div>
        )}
      </Card>
    </div>
  )
}

export default OAuthTool

