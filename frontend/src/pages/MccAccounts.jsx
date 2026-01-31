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
    </div>
  )
}

