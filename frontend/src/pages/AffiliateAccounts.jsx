import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, message, Popconfirm, Collapse, Tag, Space } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { Option } = Select

const AffiliateAccounts = () => {
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  
  const [accounts, setAccounts] = useState([])
  const [employeesData, setEmployeesData] = useState([]) // 经理视图：按员工分组的数据
  const [platforms, setPlatforms] = useState([])
  const [loading, setLoading] = useState(false)
  const [accountModalVisible, setAccountModalVisible] = useState(false)
  const [platformModalVisible, setPlatformModalVisible] = useState(false)
  const [editingAccount, setEditingAccount] = useState(null)
  const [accountForm] = Form.useForm()
  const [platformForm] = Form.useForm()

  useEffect(() => {
    fetchPlatforms()
    if (isManager) {
      fetchAccountsByEmployees()
    } else {
      fetchAccounts()
    }
  }, [isManager])

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms')
      setPlatforms(response.data)
    } catch (error) {
      message.error('获取平台列表失败')
    }
  }

  const fetchAccounts = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/affiliate/accounts')
      setAccounts(response.data)
    } catch (error) {
      message.error('获取账号列表失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchAccountsByEmployees = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/affiliate/accounts/by-employees')
      setEmployeesData(response.data)
    } catch (error) {
      message.error('获取员工账号信息失败')
    } finally {
      setLoading(false)
    }
  }

  // 添加联盟平台（经理专用）
  const handleCreatePlatform = () => {
    platformForm.resetFields()
    setPlatformModalVisible(true)
  }

  const handlePlatformSubmit = async (values) => {
    try {
      await api.post('/api/affiliate/platforms', values)
      message.success('平台创建成功')
      setPlatformModalVisible(false)
      fetchPlatforms()
      fetchAccountsByEmployees()
    } catch (error) {
      message.error(error.response?.data?.detail || '创建平台失败')
    }
  }

  // 添加/编辑账号（员工使用）
  const handleCreateAccount = () => {
    setEditingAccount(null)
    accountForm.resetFields()
    setAccountModalVisible(true)
  }

  const handleEditAccount = (account) => {
    setEditingAccount(account)
    accountForm.setFieldsValue({
      platform_id: account.platform_id,
      account_name: account.account_name,
      account_code: account.account_code,
      email: account.email,
      is_active: account.is_active,
      notes: account.notes,
    })
    setAccountModalVisible(true)
  }

  const handleDeleteAccount = async (accountId) => {
    try {
      await api.delete(`/api/affiliate/accounts/${accountId}`)
      message.success('删除成功')
      if (isManager) {
        fetchAccountsByEmployees()
      } else {
        fetchAccounts()
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  const handleAccountSubmit = async (values) => {
    try {
      if (editingAccount) {
        await api.put(`/api/affiliate/accounts/${editingAccount.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/api/affiliate/accounts', values)
        message.success('创建成功')
      }
      setAccountModalVisible(false)
      if (isManager) {
        fetchAccountsByEmployees()
      } else {
        fetchAccounts()
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '操作失败')
    }
  }

  // 员工视图：显示自己的账号列表
  const employeeColumns = [
    { title: '账号名称', dataIndex: 'account_name', key: 'account_name' },
    { title: '联盟平台', key: 'platform', render: (_, record) => record.platform?.platform_name },
    { title: '账号代码', dataIndex: 'account_code', key: 'account_code' },
    { title: '邮箱', dataIndex: 'email', key: 'email' },
    { 
      title: '状态', 
      dataIndex: 'is_active', 
      key: 'is_active', 
      render: (val) => <Tag color={val ? 'green' : 'red'}>{val ? '激活' : '停用'}</Tag>
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            icon={<EditOutlined />}
            onClick={() => handleEditAccount(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确定要删除此账号吗？"
            onConfirm={() => handleDeleteAccount(record.id)}
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
      ),
    },
  ]

  // 经理视图：按员工显示
  const renderManagerView = () => {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2>联盟账号管理</h2>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreatePlatform}
          >
            添加联盟平台
          </Button>
        </div>

        <Card>
          <Collapse
            items={employeesData.map((employee) => ({
              key: employee.employee_username,
              label: (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>
                    <strong>员工 {employee.employee_username}</strong>
                    <Tag color="blue" style={{ marginLeft: 8 }}>
                      总账号数: {employee.total_accounts}
                    </Tag>
                    <Tag color="green" style={{ marginLeft: 8 }}>
                      活跃账号: {employee.active_accounts}
                    </Tag>
                  </span>
                </div>
              ),
              children: employee.platforms.length === 0 ? (
                <p style={{ color: '#999', textAlign: 'center', padding: '20px' }}>
                  该员工尚未添加任何联盟账号
                </p>
              ) : (
                employee.platforms.map((platform) => (
                  <Card
                    key={platform.platform_id}
                    title={platform.platform_name}
                    style={{ marginBottom: 16 }}
                    size="small"
                  >
                    <Table
                      columns={[
                        { title: '账号名称', dataIndex: 'account_name', key: 'account_name' },
                        { title: '账号代码', dataIndex: 'account_code', key: 'account_code' },
                        { title: '邮箱', dataIndex: 'email', key: 'email' },
                        { 
                          title: '状态', 
                          dataIndex: 'is_active', 
                          key: 'is_active',
                          render: (val) => <Tag color={val ? 'green' : 'red'}>{val ? '激活' : '停用'}</Tag>
                        },
                        { title: '备注', dataIndex: 'notes', key: 'notes', ellipsis: true },
                      ]}
                      dataSource={platform.accounts}
                      rowKey="id"
                      pagination={false}
                      size="small"
                    />
                  </Card>
                ))
              ),
            }))}
          />
        </Card>

        {/* 添加平台模态框 */}
        <Modal
          title="添加联盟平台"
          open={platformModalVisible}
          onCancel={() => setPlatformModalVisible(false)}
          onOk={() => platformForm.submit()}
        >
          <Form
            form={platformForm}
            layout="vertical"
            onFinish={handlePlatformSubmit}
          >
            <Form.Item
              name="platform_name"
              label="平台名称"
              rules={[{ required: true, message: '请输入平台名称' }]}
            >
              <Input placeholder="例如：Amazon Associates" />
            </Form.Item>

            <Form.Item
              name="platform_code"
              label="平台代码"
              rules={[{ required: true, message: '请输入平台代码' }]}
            >
              <Input placeholder="例如：amazon" />
            </Form.Item>

            <Form.Item
              name="description"
              label="平台描述"
            >
              <Input.TextArea rows={3} placeholder="可选：平台描述信息" />
            </Form.Item>
          </Form>
        </Modal>
      </div>
    )
  }

  // 员工视图：显示自己的账号
  const renderEmployeeView = () => {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2>我的联盟账号</h2>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreateAccount}
          >
            添加账号
          </Button>
        </div>

        <Card>
          <Table
            columns={employeeColumns}
            dataSource={accounts}
            loading={loading}
            rowKey="id"
            locale={{
              emptyText: '暂无账号，请点击"添加账号"按钮添加'
            }}
          />
        </Card>

        {/* 添加/编辑账号模态框 */}
        <Modal
          title={editingAccount ? '编辑账号' : '添加账号'}
          open={accountModalVisible}
          onCancel={() => setAccountModalVisible(false)}
          onOk={() => accountForm.submit()}
          width={600}
        >
          <Form
            form={accountForm}
            layout="vertical"
            onFinish={handleAccountSubmit}
          >
            <Form.Item
              name="platform_id"
              label="联盟平台"
              rules={[{ required: true, message: '请选择联盟平台' }]}
            >
              <Select disabled={!!editingAccount} placeholder="请选择联盟平台">
                {platforms.map(platform => (
                  <Option key={platform.id} value={platform.id}>
                    {platform.platform_name}
                  </Option>
                ))}
              </Select>
            </Form.Item>

            <Form.Item
              name="account_name"
              label="账号名称"
              rules={[{ required: true, message: '请输入账号名称' }]}
            >
              <Input placeholder="请输入账号名称" />
            </Form.Item>

            <Form.Item
              name="account_code"
              label="账号代码"
            >
              <Input placeholder="可选：账号代码" />
            </Form.Item>

            <Form.Item
              name="email"
              label="邮箱"
              rules={[{ type: 'email', message: '请输入有效的邮箱地址' }]}
            >
              <Input placeholder="可选：邮箱地址" />
            </Form.Item>

            <Form.Item
              name="is_active"
              label="状态"
              valuePropName="checked"
              initialValue={true}
            >
              <Switch checkedChildren="激活" unCheckedChildren="停用" />
            </Form.Item>

            <Form.Item
              name="notes"
              label="备注"
            >
              <Input.TextArea rows={3} placeholder="可选：备注信息" />
            </Form.Item>
          </Form>
        </Modal>
      </div>
    )
  }

  return isManager ? renderManagerView() : renderEmployeeView()
}

export default AffiliateAccounts
