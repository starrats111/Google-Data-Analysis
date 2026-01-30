import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, message, Popconfirm, Collapse, Tag, Space, DatePicker, Statistic, Row, Col, Spin } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, SyncOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { Option } = Select
const { RangePicker } = DatePicker

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
  
  // CollabGlow 同步相关状态
  const [syncModalVisible, setSyncModalVisible] = useState(false)
  const [syncAccount, setSyncAccount] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [syncForm] = Form.useForm()

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
    
    // 从notes中提取CollabGlow token（如果存在）
    let collabglowToken = ''
    try {
      if (account.notes) {
        const notesData = JSON.parse(account.notes)
        collabglowToken = notesData.collabglow_token || ''
      }
    } catch (e) {
      // 如果notes不是JSON格式，忽略
    }
    
    accountForm.setFieldsValue({
      platform_id: account.platform_id,
      account_name: account.account_name,
      account_code: account.account_code,
      email: account.email,
      is_active: account.is_active,
      notes: account.notes,
      collabglow_token: collabglowToken,
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
      // 处理CollabGlow token：如果提供了token且平台是CollabGlow，将其存储到notes中
      const { collabglow_token, platform_id, notes, ...otherValues } = values
      const selectedPlatform = platforms.find(p => p.id === platform_id)
      const isCollabGlow = selectedPlatform && isCollabGlowPlatform({ platform: selectedPlatform })
      
      let finalNotes = notes || ''
      if (isCollabGlow && collabglow_token) {
        // 将token存储到notes的JSON中
        try {
          let notesData = {}
          if (notes) {
            try {
              notesData = JSON.parse(notes)
            } catch (e) {
              // 如果notes不是JSON，保留原文本作为其他字段
              notesData = { other: notes }
            }
          }
          notesData.collabglow_token = collabglow_token
          finalNotes = JSON.stringify(notesData)
        } catch (e) {
          // 如果处理失败，使用原notes
          finalNotes = notes || ''
        }
      }
      
      const submitData = {
        ...otherValues,
        platform_id,
        notes: finalNotes,
      }
      
      if (editingAccount) {
        await api.put(`/api/affiliate/accounts/${editingAccount.id}`, submitData)
        message.success('更新成功')
      } else {
        await api.post('/api/affiliate/accounts', submitData)
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

  // CollabGlow 同步功能
  const handleSyncCollabGlow = (account) => {
    setSyncAccount(account)
    syncForm.resetFields()
    // 默认选择最近30天
    const endDate = dayjs()
    const beginDate = endDate.subtract(30, 'day')
    syncForm.setFieldsValue({
      dateRange: [beginDate, endDate],
      token: ''
    })
    setSyncResult(null)
    setSyncModalVisible(true)
  }

  const handleSyncSubmit = async (values) => {
    if (!syncAccount) return
    
    setSyncing(true)
    setSyncResult(null)
    
    try {
      const { dateRange, token } = values
      const beginDate = dateRange[0].format('YYYY-MM-DD')
      const endDate = dateRange[1].format('YYYY-MM-DD')
      
      const response = await api.post('/api/collabglow/sync-commissions', {
        account_id: syncAccount.id,
        begin_date: beginDate,
        end_date: endDate,
        token: token || undefined // 如果不提供token，会从账号备注中读取
      })
      
      setSyncResult(response.data)
      message.success(`成功同步 ${response.data.total_records} 条佣金记录`)
    } catch (error) {
      message.error(error.response?.data?.detail || '同步失败')
      setSyncResult({
        success: false,
        message: error.response?.data?.detail || '同步失败'
      })
    } finally {
      setSyncing(false)
    }
  }

  const handleTestConnection = async () => {
    if (!syncAccount) return
    
    setSyncing(true)
    try {
      const token = syncForm.getFieldValue('token')
      const response = await api.get('/api/collabglow/test-connection', {
        params: {
          account_id: syncAccount.id,
          token: token || undefined
        }
      })
      
      if (response.data.success) {
        message.success(`连接成功！找到 ${response.data.records_found} 条记录`)
      } else {
        message.error(response.data.message)
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '测试连接失败')
    } finally {
      setSyncing(false)
    }
  }

  // 检查是否为 CollabGlow 平台
  const isCollabGlowPlatform = (account) => {
    const platform = account.platform || account
    const platformName = platform.platform_name || platform.platformName || ''
    return platformName.toLowerCase().includes('collabglow') || 
           platformName.toLowerCase().includes('collab')
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
          {isCollabGlowPlatform(record) && (
            <Button
              type="link"
              icon={<SyncOutlined />}
              onClick={() => handleSyncCollabGlow(record)}
            >
              同步数据
            </Button>
          )}
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
                        {
                          title: '操作',
                          key: 'action',
                          render: (_, record) => (
                            isCollabGlowPlatform(record) ? (
                              <Button
                                type="link"
                                size="small"
                                icon={<SyncOutlined />}
                                onClick={() => handleSyncCollabGlow(record)}
                              >
                                同步数据
                              </Button>
                            ) : null
                          ),
                        },
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

        {/* CollabGlow 同步模态框 */}
        <Modal
          title={`同步 CollabGlow 数据 - ${syncAccount?.account_name || ''}`}
          open={syncModalVisible}
          onCancel={() => {
            setSyncModalVisible(false)
            setSyncResult(null)
          }}
          onOk={() => syncForm.submit()}
          width={700}
          okText="开始同步"
          cancelText="关闭"
          confirmLoading={syncing}
        >
          <Form
            form={syncForm}
            layout="vertical"
            onFinish={handleSyncSubmit}
          >
            <Form.Item
              name="dateRange"
              label="选择日期范围"
              rules={[{ required: true, message: '请选择日期范围' }]}
            >
              <RangePicker
                style={{ width: '100%' }}
                format="YYYY-MM-DD"
                disabledDate={(current) => current && current > dayjs().endOf('day')}
              />
            </Form.Item>

            <Form.Item
              name="token"
              label="CollabGlow Token（可选）"
              help="如果不填写，将从账号备注中读取 token"
            >
              <Input.Password 
                placeholder="留空则使用账号备注中配置的 token"
              />
            </Form.Item>

            <Form.Item>
              <Button 
                type="default" 
                onClick={handleTestConnection}
                loading={syncing}
                icon={<SyncOutlined />}
              >
                测试连接
              </Button>
            </Form.Item>
          </Form>

          {syncResult && (
            <div style={{ marginTop: 24, padding: 16, background: '#f5f5f5', borderRadius: 4 }}>
              <Spin spinning={syncing}>
                {syncResult.success ? (
                  <div>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Statistic
                          title="同步记录数"
                          value={syncResult.total_records}
                          valueStyle={{ color: '#3f8600' }}
                        />
                      </Col>
                      <Col span={8}>
                        <Statistic
                          title="总佣金"
                          value={syncResult.total_commission}
                          prefix="$"
                          precision={2}
                          valueStyle={{ color: '#3f8600' }}
                        />
                      </Col>
                      <Col span={8}>
                        <Statistic
                          title="状态"
                          value="成功"
                          valueStyle={{ color: '#3f8600' }}
                        />
                      </Col>
                    </Row>
                    {syncResult.data && syncResult.data.length > 0 && (
                      <div style={{ marginTop: 16 }}>
                        <h4>佣金明细（前5条）：</h4>
                        <Table
                          dataSource={syncResult.data.slice(0, 5)}
                          columns={[
                            { title: '品牌ID', dataIndex: 'brand_id', key: 'brand_id' },
                            { title: 'MCID', dataIndex: 'mcid', key: 'mcid' },
                            { title: '佣金', dataIndex: 'sale_commission', key: 'sale_commission', render: (v) => `$${v?.toFixed(2) || 0}` },
                            { title: '结算日期', dataIndex: 'settlement_date', key: 'settlement_date' },
                          ]}
                          pagination={false}
                          size="small"
                          rowKey="settlement_id"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ color: '#ff4d4f' }}>
                    <strong>同步失败：</strong> {syncResult.message}
                  </div>
                )}
              </Spin>
            </div>
          )}
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

            {/* CollabGlow Token 字段（仅当选择CollabGlow平台时显示） */}
            <Form.Item
              noStyle
              shouldUpdate={(prevValues, currentValues) => 
                prevValues.platform_id !== currentValues.platform_id
              }
            >
              {({ getFieldValue }) => {
                const selectedPlatformId = getFieldValue('platform_id')
                const selectedPlatform = platforms.find(p => p.id === selectedPlatformId)
                const showTokenField = selectedPlatform && isCollabGlowPlatform({ platform: selectedPlatform })
                
                return showTokenField ? (
                  <Form.Item
                    name="collabglow_token"
                    label="CollabGlow API Token"
                    help="请输入你的 CollabGlow API Token，用于同步佣金数据"
                  >
                    <Input.Password 
                      placeholder="请输入 CollabGlow API Token"
                    />
                  </Form.Item>
                ) : null
              }}
            </Form.Item>
          </Form>
        </Modal>

        {/* CollabGlow 同步模态框 */}
        <Modal
          title={`同步 CollabGlow 数据 - ${syncAccount?.account_name || ''}`}
          open={syncModalVisible}
          onCancel={() => {
            setSyncModalVisible(false)
            setSyncResult(null)
          }}
          onOk={() => syncForm.submit()}
          width={700}
          okText="开始同步"
          cancelText="关闭"
          confirmLoading={syncing}
        >
          <Form
            form={syncForm}
            layout="vertical"
            onFinish={handleSyncSubmit}
          >
            <Form.Item
              name="dateRange"
              label="选择日期范围"
              rules={[{ required: true, message: '请选择日期范围' }]}
            >
              <RangePicker
                style={{ width: '100%' }}
                format="YYYY-MM-DD"
                disabledDate={(current) => current && current > dayjs().endOf('day')}
              />
            </Form.Item>

            <Form.Item
              name="token"
              label="CollabGlow Token（可选）"
              help="如果不填写，将从账号备注中读取 token"
            >
              <Input.Password 
                placeholder="留空则使用账号备注中配置的 token"
              />
            </Form.Item>

            <Form.Item>
              <Button 
                type="default" 
                onClick={handleTestConnection}
                loading={syncing}
                icon={<SyncOutlined />}
              >
                测试连接
              </Button>
            </Form.Item>
          </Form>

          {syncResult && (
            <div style={{ marginTop: 24, padding: 16, background: '#f5f5f5', borderRadius: 4 }}>
              <Spin spinning={syncing}>
                {syncResult.success ? (
                  <div>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Statistic
                          title="同步记录数"
                          value={syncResult.total_records}
                          valueStyle={{ color: '#3f8600' }}
                        />
                      </Col>
                      <Col span={8}>
                        <Statistic
                          title="总佣金"
                          value={syncResult.total_commission}
                          prefix="$"
                          precision={2}
                          valueStyle={{ color: '#3f8600' }}
                        />
                      </Col>
                      <Col span={8}>
                        <Statistic
                          title="状态"
                          value="成功"
                          valueStyle={{ color: '#3f8600' }}
                        />
                      </Col>
                    </Row>
                    {syncResult.data && syncResult.data.length > 0 && (
                      <div style={{ marginTop: 16 }}>
                        <h4>佣金明细（前5条）：</h4>
                        <Table
                          dataSource={syncResult.data.slice(0, 5)}
                          columns={[
                            { title: '品牌ID', dataIndex: 'brand_id', key: 'brand_id' },
                            { title: 'MCID', dataIndex: 'mcid', key: 'mcid' },
                            { title: '佣金', dataIndex: 'sale_commission', key: 'sale_commission', render: (v) => `$${v?.toFixed(2) || 0}` },
                            { title: '结算日期', dataIndex: 'settlement_date', key: 'settlement_date' },
                          ]}
                          pagination={false}
                          size="small"
                          rowKey="settlement_id"
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ color: '#ff4d4f' }}>
                    <strong>同步失败：</strong> {syncResult.message}
                  </div>
                )}
              </Spin>
            </div>
          )}
        </Modal>
      </div>
    )
  }

  return isManager ? renderManagerView() : renderEmployeeView()
}

export default AffiliateAccounts
