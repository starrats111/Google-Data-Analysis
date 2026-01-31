import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Modal, Form, Input, message, Popconfirm, Tag, Space, Switch, Steps, Alert } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, SyncOutlined, LinkOutlined, CheckCircleOutlined } from '@ant-design/icons'
import api from '../services/api'
import { useAuth } from '../store/authStore'

export default function MccAccounts() {
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  
  const [mccAccounts, setMccAccounts] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingMcc, setEditingMcc] = useState(null)
  const [originalApiValues, setOriginalApiValues] = useState({}) // 保存原始API配置值
  const [form] = Form.useForm()
  const [syncLoading, setSyncLoading] = useState({})
  const [oauthModalVisible, setOauthModalVisible] = useState(false)
  const [oauthStep, setOauthStep] = useState(0) // 0: 输入信息, 1: 授权, 2: 完成
  const [authorizationUrl, setAuthorizationUrl] = useState('')
  const [oauthForm] = Form.useForm()
  const [obtainedRefreshToken, setObtainedRefreshToken] = useState('') // 保存获取到的Refresh Token

  useEffect(() => {
    fetchMccAccounts()
  }, [])

  const fetchMccAccounts = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/mcc/accounts')
      console.log('获取到的MCC账号数据:', response.data)
      setMccAccounts(response.data)
    } catch (error) {
      console.error('获取MCC账号列表失败:', error)
      message.error('获取MCC账号列表失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setEditingMcc(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (mcc) => {
    console.log('编辑MCC账号，原始数据:', {
      id: mcc.id,
      mcc_id: mcc.mcc_id,
      client_id: mcc.client_id ? '已配置' : '未配置',
      client_secret: mcc.client_secret ? '已配置' : '未配置',
      refresh_token: mcc.refresh_token ? '已配置' : '未配置'
    })
    setEditingMcc(mcc)
    // 保存原始API配置值（保留null/undefined，用于判断是否需要更新）
    const originalValues = {
      client_id: mcc.client_id,
      client_secret: mcc.client_secret,
      refresh_token: mcc.refresh_token
    }
    console.log('保存的原始API值:', {
      client_id: originalValues.client_id ? '有值' : '无值',
      client_secret: originalValues.client_secret ? '有值' : '无值',
      refresh_token: originalValues.refresh_token ? '有值' : '无值'
    })
    setOriginalApiValues(originalValues)
    form.setFieldsValue({
      mcc_id: mcc.mcc_id,
      mcc_name: mcc.mcc_name,
      email: mcc.email,
      // 不设置这些字段的值，留空表示不修改
      client_id: undefined,
      client_secret: undefined,
      refresh_token: undefined,
      is_active: mcc.is_active
    })
    setModalVisible(true)
  }

  const handleSubmit = async (values) => {
    try {
      const submitData = { ...values }
      
      // 简化逻辑：编辑时，如果字段为空字符串或undefined/null，则删除该字段（不发送，保留原值）
      // 如果字段有值（非空字符串），则发送（更新为新值）
      if (editingMcc) {
        // 编辑模式：只处理API字段
        const apiFields = ['client_id', 'client_secret', 'refresh_token']
        apiFields.forEach(field => {
          const value = submitData[field]
          // 如果值为空字符串、undefined或null，删除该字段（不发送，保留原值）
          if (!value || (typeof value === 'string' && value.trim() === '')) {
            delete submitData[field]
          }
        })
      } else {
        // 创建模式：空字符串不发送
        if (!submitData.client_id || submitData.client_id.trim() === '') {
          delete submitData.client_id
        }
        if (!submitData.client_secret || submitData.client_secret.trim() === '') {
          delete submitData.client_secret
        }
        if (!submitData.refresh_token || submitData.refresh_token.trim() === '') {
          delete submitData.refresh_token
        }
      }
      
      if (editingMcc) {
        const response = await api.put(`/api/mcc/accounts/${editingMcc.id}`, submitData)
        message.success('更新成功')
      } else {
        const response = await api.post('/api/mcc/accounts', submitData)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      setOriginalApiValues({})
      fetchMccAccounts()
    } catch (error) {
      console.error('保存失败:', error)
      const errorMessage = error.response?.data?.detail || error.message || '操作失败'
      message.error(errorMessage)
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.delete(`/api/mcc/accounts/${id}`)
      message.success('删除成功')
      fetchMccAccounts()
    } catch (error) {
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  const handleSync = async (mccId) => {
    // 获取当前日期范围（默认最近7天）
    const endDate = new Date()
    const beginDate = new Date()
    beginDate.setDate(endDate.getDate() - 7)
    
    const beginDateStr = beginDate.toISOString().split('T')[0]
    const endDateStr = endDate.toISOString().split('T')[0]
    
    setSyncLoading({ ...syncLoading, [mccId]: true })
    try {
      const response = await api.post(`/api/mcc/accounts/${mccId}/sync`, {
        begin_date: beginDateStr,
        end_date: endDateStr
      })
      message.success(response.data.message || '同步成功')
      fetchMccAccounts()
    } catch (error) {
      message.error(error.response?.data?.detail || '同步失败')
    } finally {
      setSyncLoading({ ...syncLoading, [mccId]: false })
    }
  }

  const columns = [
    {
      title: 'MCC ID',
      dataIndex: 'mcc_id',
      key: 'mcc_id',
    },
    {
      title: 'MCC名称',
      dataIndex: 'mcc_name',
      key: 'mcc_name',
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (val) => <Tag color={val ? 'green' : 'red'}>{val ? '激活' : '停用'}</Tag>
    },
    {
      title: '数据条数',
      dataIndex: 'data_count',
      key: 'data_count',
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            icon={<SyncOutlined />}
            onClick={() => handleSync(record.id)}
            loading={syncLoading[record.id]}
          >
            同步数据
          </Button>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确定要删除这个MCC账号吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button
              type="link"
              danger
              icon={<DeleteOutlined />}
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>MCC账号管理</h2>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleCreate}
        >
          添加MCC账号
        </Button>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={mccAccounts}
          loading={loading}
          rowKey="id"
          locale={{
            emptyText: '暂无MCC账号，请点击"添加MCC账号"按钮添加'
          }}
        />
      </Card>

      <Modal
        title={editingMcc ? '编辑MCC账号' : '添加MCC账号'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
        >
          <Form.Item
            name="mcc_id"
            label="MCC ID"
            rules={[{ required: !editingMcc, message: '请输入MCC ID' }]}
          >
            <Input placeholder="请输入MCC ID" disabled={!!editingMcc} />
          </Form.Item>

          <Form.Item
            name="mcc_name"
            label="MCC名称"
            rules={[{ required: true, message: '请输入MCC名称' }]}
          >
            <Input placeholder="请输入MCC名称" />
          </Form.Item>

          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '请输入有效的邮箱地址' }]}
          >
            <Input placeholder="请输入邮箱地址" />
          </Form.Item>

          <Form.Item
            name="client_id"
            label="Client ID（可选）"
            help={editingMcc ? (originalApiValues.client_id ? "已配置，留空则不修改，填写新值则更新" : "留空则不设置，填写新值则更新") : undefined}
          >
            <Input placeholder={editingMcc && originalApiValues.client_id ? "已配置，留空则不修改" : "Google Ads API Client ID"} />
          </Form.Item>

          <Form.Item
            name="client_secret"
            label="Client Secret（可选）"
            help={editingMcc ? (originalApiValues.client_secret ? "已配置，留空则不修改，填写新值则更新" : "留空则不设置，填写新值则更新") : undefined}
          >
            <Input.Password placeholder={editingMcc && originalApiValues.client_secret ? "已配置，留空则不修改" : "Google Ads API Client Secret"} />
          </Form.Item>

          <Form.Item
            name="refresh_token"
            label="Refresh Token（可选）"
            help={editingMcc ? (originalApiValues.refresh_token ? "已配置，留空则不修改，填写新值则更新" : "留空则不设置，填写新值则更新") : undefined}
          >
            <Input.Group compact>
              <Input.Password 
                style={{ width: 'calc(100% - 120px)' }}
                placeholder={editingMcc && originalApiValues.refresh_token ? "已配置，留空则不修改" : "Google Ads API Refresh Token"} 
              />
              <Button 
                type="link" 
                icon={<LinkOutlined />}
                onClick={() => {
                  if (!form.getFieldValue('client_id') || !form.getFieldValue('client_secret')) {
                    message.warning('请先填写Client ID和Client Secret')
                    return
                  }
                  oauthForm.setFieldsValue({
                    client_id: form.getFieldValue('client_id'),
                    client_secret: form.getFieldValue('client_secret')
                  })
                  setOauthStep(0)
                  setOauthModalVisible(true)
                }}
              >
                在线获取
              </Button>
            </Input.Group>
          </Form.Item>

          {editingMcc && (
            <Form.Item
              name="is_active"
              label="状态"
              valuePropName="checked"
            >
              <Switch checkedChildren="激活" unCheckedChildren="停用" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* OAuth获取Refresh Token模态框 */}
      <Modal
        title="获取Google Ads API Refresh Token"
        open={oauthModalVisible}
        onCancel={() => {
          setOauthModalVisible(false)
          setOauthStep(0)
          setAuthorizationUrl('')
          setObtainedRefreshToken('')
        }}
        footer={null}
        width={700}
      >
        <Steps
          current={oauthStep}
          items={[
            { title: '输入信息' },
            { title: '授权' },
            { title: '完成' }
          ]}
          style={{ marginBottom: 24 }}
        />

        {oauthStep === 0 && (
          <Form
            form={oauthForm}
            layout="vertical"
            onFinish={async (values) => {
              try {
                // 生成回调URL
                const redirectUri = `${window.location.origin}/google-oauth-callback`
                
                // 获取授权URL
                const response = await api.get('/api/google-oauth/authorize', {
                  params: {
                    client_id: values.client_id,
                    redirect_uri: redirectUri
                  }
                })
                
                setAuthorizationUrl(response.data.authorization_url)
                setOauthStep(1)
              } catch (error) {
                message.error(error.response?.data?.detail || '获取授权URL失败')
              }
            }}
          >
            <Alert
              message="获取Refresh Token步骤"
              description={
                <ol style={{ margin: 0, paddingLeft: 20 }}>
                  <li>填写Client ID和Client Secret（如果已填写会自动填充）</li>
                  <li>点击"获取授权URL"按钮</li>
                  <li>在新窗口中完成Google授权</li>
                  <li>授权完成后，Refresh Token会自动填充到表单中</li>
                </ol>
              }
              type="info"
              style={{ marginBottom: 24 }}
            />

            <Form.Item
              name="client_id"
              label="Client ID"
              rules={[{ required: true, message: '请输入Client ID' }]}
            >
              <Input placeholder="Google Ads API Client ID" />
            </Form.Item>

            <Form.Item
              name="client_secret"
              label="Client Secret"
              rules={[{ required: true, message: '请输入Client Secret' }]}
            >
              <Input.Password placeholder="Google Ads API Client Secret" />
            </Form.Item>

            <Form.Item
              name="redirect_uri"
              label="回调URL（Redirect URI）"
              help="必须在Google Cloud Console中配置此URL为授权重定向URI"
              initialValue={`${window.location.origin}/google-oauth-callback`}
            >
              <Input disabled />
            </Form.Item>

            <Form.Item>
              <Button type="primary" htmlType="submit" block>
                获取授权URL
              </Button>
            </Form.Item>
          </Form>
        )}

        {oauthStep === 1 && (
          <div>
            <Alert
              message="请完成以下步骤"
              description={
                <ol style={{ margin: 0, paddingLeft: 20 }}>
                  <li>点击下面的"打开授权页面"按钮</li>
                  <li>在新窗口中登录Google账号并完成授权</li>
                  <li>授权完成后，页面会跳转并显示授权码</li>
                  <li>复制授权码（URL参数中的code值）</li>
                  <li>回到此页面，粘贴授权码并点击"获取Token"</li>
                </ol>
              }
              type="warning"
              style={{ marginBottom: 24 }}
            />

            <Form
              layout="vertical"
              onFinish={async (values) => {
                try {
                  const redirectUri = `${window.location.origin}/google-oauth-callback`
                  const response = await api.get('/api/google-oauth/callback', {
                    params: {
                      code: values.code,
                      client_id: oauthForm.getFieldValue('client_id'),
                      client_secret: oauthForm.getFieldValue('client_secret'),
                      redirect_uri: redirectUri
                    }
                  })

                  if (response.data.success) {
                    const refreshToken = response.data.refresh_token
                    // 保存获取到的Refresh Token
                    setObtainedRefreshToken(refreshToken)
                    // 自动填充Refresh Token到主表单
                    form.setFieldsValue({
                      refresh_token: refreshToken
                    })
                    // 强制更新表单显示
                    setTimeout(() => {
                      form.setFieldsValue({
                        refresh_token: refreshToken
                      })
                    }, 100)
                    setOauthStep(2)
                    message.success('成功获取Refresh Token！已自动填充到表单中')
                  }
                } catch (error) {
                  message.error(error.response?.data?.detail || '获取Token失败')
                }
              }}
            >
              <Form.Item
                name="code"
                label="授权码（Authorization Code）"
                rules={[{ required: true, message: '请输入授权码' }]}
                help="从授权页面的回调URL中复制code参数的值"
              >
                <Input.TextArea 
                  rows={3}
                  placeholder="粘贴授权码（从回调URL的code参数中获取）"
                />
              </Form.Item>

              <Form.Item>
                <Space>
                  <Button 
                    type="primary"
                    icon={<LinkOutlined />}
                    onClick={() => {
                      window.open(authorizationUrl, '_blank')
                    }}
                  >
                    打开授权页面
                  </Button>
                  <Button htmlType="submit">
                    获取Token
                  </Button>
                  <Button onClick={() => setOauthStep(0)}>
                    返回
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          </div>
        )}

        {oauthStep === 2 && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <CheckCircleOutlined style={{ fontSize: 64, color: '#52c41a', marginBottom: 16 }} />
            <h3>成功获取Refresh Token！</h3>
            <p>Refresh Token已自动填充到表单中。</p>
            {obtainedRefreshToken && (
              <div style={{ marginTop: 16, padding: '12px', backgroundColor: '#f5f5f5', borderRadius: '4px', fontSize: '12px', wordBreak: 'break-all' }}>
                <strong>Token预览：</strong>{obtainedRefreshToken.substring(0, 50)}...
              </div>
            )}
            <div style={{ marginTop: 24 }}>
              <Space>
                <Button 
                  type="primary" 
                  onClick={() => {
                    // 再次确保表单值被设置
                    if (obtainedRefreshToken) {
                      form.setFieldsValue({
                        refresh_token: obtainedRefreshToken
                      })
                    }
                    setOauthModalVisible(false)
                    setOauthStep(0)
                    setAuthorizationUrl('')
                    setObtainedRefreshToken('')
                    // 提示用户点击主表单的确定按钮
                    message.info('请点击主表单的"确定"按钮保存MCC账号配置')
                  }}
                >
                  完成并返回
                </Button>
                <Button
                  onClick={async () => {
                    // 直接保存MCC账号，使用获取到的Refresh Token
                    try {
                      const refreshToken = obtainedRefreshToken || form.getFieldValue('refresh_token')
                      
                      if (!refreshToken) {
                        message.error('Refresh Token为空，无法保存')
                        return
                      }
                      
                      if (editingMcc) {
                        // 更新现有MCC账号
                        const submitData = {
                          refresh_token: refreshToken
                        }
                        
                        await api.put(`/api/mcc/accounts/${editingMcc.id}`, submitData)
                        message.success('Refresh Token已保存！')
                        setOauthModalVisible(false)
                        setOauthStep(0)
                        setAuthorizationUrl('')
                        setObtainedRefreshToken('')
                        fetchMccAccounts()
                        setModalVisible(false)
                      } else {
                        // 如果是新建，确保表单中有值，然后提示用户
                        if (refreshToken) {
                          form.setFieldsValue({
                            refresh_token: refreshToken
                          })
                        }
                        message.warning('请先填写MCC ID、名称和邮箱，然后点击主表单的"确定"按钮保存')
                        setOauthModalVisible(false)
                        setOauthStep(0)
                        setAuthorizationUrl('')
                        setObtainedRefreshToken('')
                      }
                    } catch (error) {
                      message.error(error.response?.data?.detail || '保存失败')
                    }
                  }}
                >
                  直接保存Refresh Token
                </Button>
              </Space>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

