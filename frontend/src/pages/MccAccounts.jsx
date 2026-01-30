import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Modal, Form, Input, Switch, message, Popconfirm, Tag, Space } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const MccAccounts = () => {
  const { user } = useAuth()
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingAccount, setEditingAccount] = useState(null)
  const [testingAccountId, setTestingAccountId] = useState(null)
  const [form] = Form.useForm()

  useEffect(() => {
    fetchAccounts()
  }, [])

  const fetchAccounts = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/mcc/accounts')
      setAccounts(response.data)
    } catch (error) {
      message.error('获取MCC账号列表失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setEditingAccount(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (account) => {
    setEditingAccount(account)
    form.setFieldsValue({
      mcc_account_id: account.mcc_account_id,
      mcc_account_name: account.mcc_account_name,
      email: account.email,
      refresh_token: account.refresh_token,
      client_id: account.client_id,
      client_secret: account.client_secret,
      developer_token: account.developer_token,
      is_active: account.is_active,
    })
    setModalVisible(true)
  }

  const handleSubmit = async (values) => {
    try {
      if (editingAccount) {
        await api.put(`/api/mcc/accounts/${editingAccount.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/api/mcc/accounts', values)
        message.success('创建成功')
      }
      setModalVisible(false)
      fetchAccounts()
    } catch (error) {
      message.error(error.response?.data?.detail || '操作失败')
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.delete(`/api/mcc/accounts/${id}`)
      message.success('删除成功')
      fetchAccounts()
    } catch (error) {
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  const handleTestConnection = async (account) => {
    setTestingAccountId(account.id)
    try {
      const response = await api.post(`/api/mcc/accounts/${account.id}/test-connection`)
      if (response.data.success) {
        message.success('连接测试成功')
      } else {
        message.warning(response.data.message)
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '测试连接失败')
    } finally {
      setTestingAccountId(null)
    }
  }

  const columns = [
    { title: 'MCC账号ID', dataIndex: 'mcc_account_id', key: 'mcc_account_id' },
    { title: '账号名称', dataIndex: 'mcc_account_name', key: 'mcc_account_name' },
    { title: '邮箱', dataIndex: 'email', key: 'email' },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (val) => (
        <Tag color={val ? 'green' : 'red'}>
          {val ? <CheckCircleOutlined /> : <CloseCircleOutlined />} {val ? '激活' : '停用'}
        </Tag>
      )
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            icon={<CheckCircleOutlined />}
            onClick={() => handleTestConnection(record)}
            loading={testingAccountId === record.id}
          >
            测试连接
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
          dataSource={accounts}
          loading={loading}
          rowKey="id"
          locale={{
            emptyText: '暂无MCC账号，请点击"添加MCC账号"按钮添加'
          }}
        />
      </Card>

      <Modal
        title={editingAccount ? '编辑MCC账号' : '添加MCC账号'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={700}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
        >
          <Form.Item
            name="mcc_account_id"
            label="MCC账号ID"
            rules={[{ required: true, message: '请输入MCC账号ID' }]}
          >
            <Input 
              placeholder="例如：941-949-6301" 
              disabled={!!editingAccount}
            />
          </Form.Item>

          <Form.Item
            name="mcc_account_name"
            label="账号名称"
          >
            <Input placeholder="可选：给账号起个名字" />
          </Form.Item>

          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ type: 'email', message: '请输入有效的邮箱地址' }]}
          >
            <Input placeholder="可选：关联邮箱" />
          </Form.Item>

          <Form.Item
            name="developer_token"
            label="开发者令牌"
            rules={[{ required: true, message: '请输入开发者令牌' }]}
          >
            <Input.Password placeholder="请输入开发者令牌" />
          </Form.Item>

          <Form.Item
            name="client_id"
            label="客户端ID"
            rules={[{ required: true, message: '请输入客户端ID' }]}
          >
            <Input placeholder="请输入客户端ID" />
          </Form.Item>

          <Form.Item
            name="client_secret"
            label="客户端密钥"
            rules={[{ required: true, message: '请输入客户端密钥' }]}
          >
            <Input.Password placeholder="请输入客户端密钥" />
          </Form.Item>

          <Form.Item
            name="refresh_token"
            label="刷新令牌"
            rules={[{ required: true, message: '请输入刷新令牌' }]}
          >
            <Input.Password placeholder="请输入刷新令牌" />
          </Form.Item>

          <Form.Item
            name="is_active"
            label="状态"
            valuePropName="checked"
            initialValue={true}
          >
            <Switch checkedChildren="激活" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default MccAccounts

