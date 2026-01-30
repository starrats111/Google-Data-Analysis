import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Modal, Form, Input, message, Popconfirm, Tag, Space, Switch } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, SyncOutlined } from '@ant-design/icons'
import api from '../services/api'
import { useAuth } from '../store/authStore'

export default function MccAccounts() {
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  
  const [mccAccounts, setMccAccounts] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingMcc, setEditingMcc] = useState(null)
  const [form] = Form.useForm()
  const [syncLoading, setSyncLoading] = useState({})

  useEffect(() => {
    fetchMccAccounts()
  }, [])

  const fetchMccAccounts = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/mcc/accounts')
      setMccAccounts(response.data)
    } catch (error) {
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
    setEditingMcc(mcc)
    form.setFieldsValue({
      mcc_id: mcc.mcc_id,
      mcc_name: mcc.mcc_name,
      email: mcc.email,
      client_id: '',  // 不显示敏感信息
      client_secret: '',  // 不显示敏感信息
      refresh_token: '',  // 不显示敏感信息
      is_active: mcc.is_active
    })
    setModalVisible(true)
  }

  const handleSubmit = async (values) => {
    try {
      if (editingMcc) {
        await api.put(`/api/mcc/accounts/${editingMcc.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/api/mcc/accounts', values)
        message.success('创建成功')
      }
      setModalVisible(false)
      fetchMccAccounts()
    } catch (error) {
      message.error(error.response?.data?.detail || '操作失败')
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
    setSyncLoading({ ...syncLoading, [mccId]: true })
    try {
      const response = await api.post(`/api/mcc/accounts/${mccId}/sync`)
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
          >
            <Input placeholder="Google Ads API Client ID" />
          </Form.Item>

          <Form.Item
            name="client_secret"
            label="Client Secret（可选）"
          >
            <Input.Password placeholder="Google Ads API Client Secret" />
          </Form.Item>

          <Form.Item
            name="refresh_token"
            label="Refresh Token（可选）"
          >
            <Input.Password placeholder="Google Ads API Refresh Token" />
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

