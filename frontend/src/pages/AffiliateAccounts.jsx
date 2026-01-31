import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, message, Popconfirm, Collapse, Tag, Space, DatePicker, Statistic, Row, Col, Spin } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, SyncOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'
import { getPlatformApiConfig, extractApiConfigFromNotes, mergeApiConfigToNotes, PLATFORM_API_CONFIG } from '../config/platformApiConfig'

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
    let isMounted = true
    
    const loadData = async () => {
      try {
        await fetchPlatforms()
        if (isMounted) {
          if (isManager) {
            await fetchAccountsByEmployees()
          } else {
            await fetchAccounts()
          }
        }
      } catch (error) {
        console.error('加载数据失败:', error)
      }
    }
    
    loadData()
    
    return () => {
      isMounted = false
    }
  }, [isManager])

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms', {
        timeout: 10000 // 10秒超时
      })
      setPlatforms(response.data || [])
    } catch (error) {
      console.error('获取平台列表失败:', error)
      if (error.code !== 'ECONNABORTED') {
        message.error('获取平台列表失败')
      }
      setPlatforms([]) // 设置空数组避免卡顿
    }
  }

  const fetchAccounts = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/affiliate/accounts', {
        timeout: 15000 // 15秒超时
      })
      setAccounts(response.data || [])
    } catch (error) {
      console.error('获取账号列表失败:', error)
      if (error.code !== 'ECONNABORTED') {
        message.error('获取账号列表失败')
      }
      setAccounts([]) // 设置空数组避免卡顿
    } finally {
      setLoading(false)
    }
  }

  const fetchAccountsByEmployees = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/affiliate/accounts/by-employees', {
        timeout: 15000 // 15秒超时
      })
      setEmployeesData(response.data || [])
    } catch (error) {
      console.error('获取员工账号信息失败:', error)
      if (error.code !== 'ECONNABORTED') {
        message.error('获取员工账号信息失败')
      }
      setEmployeesData([]) // 设置空数组避免卡顿
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
    
    // 从notes中提取API配置
    const apiConfig = extractApiConfigFromNotes(account.notes)
    
    // 获取平台配置
    const platform = platforms.find(p => p.id === account.platform_id)
    const platformConfig = getPlatformApiConfig(platform?.platform_code)
    
    // 构建表单初始值
    const formValues = {
      platform_id: account.platform_id,
      account_name: account.account_name,
      account_code: account.account_code,
      email: account.email,
      is_active: account.is_active,
      notes: account.notes,
    }
    
    // 添加API字段的初始值
    platformConfig.fields.forEach(field => {
      formValues[field.name] = apiConfig[field.name] || ''
    })
    
    accountForm.setFieldsValue(formValues)
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
      const { platform_id, notes, ...otherValues } = values
      const selectedPlatform = platforms.find(p => p.id === platform_id)
      const platformConfig = getPlatformApiConfig(selectedPlatform?.platform_code)
      
      // 提取API配置字段
      const apiConfig = {}
      platformConfig.fields.forEach(field => {
        if (values[field.name]) {
          apiConfig[field.name] = values[field.name]
        }
      })
      
      // 将API配置合并到notes中
      const finalNotes = mergeApiConfigToNotes(notes, apiConfig)
      
      // 移除API字段，只保留基本字段
      const submitData = {
        ...otherValues,
        platform_id,
        notes: finalNotes,
      }
      
      // 清理API字段
      platformConfig.fields.forEach(field => {
        delete submitData[field.name]
      })
      
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
    
    // 从账号备注中读取已有的配置
    let existingToken = ''
    let existingApiUrl = ''
    if (account.notes) {
      try {
        const notesData = JSON.parse(account.notes)
        existingToken = notesData.rewardoo_token || notesData.rw_token || notesData.api_token || ''
        existingApiUrl = notesData.rewardoo_api_url || notesData.rw_api_url || notesData.api_url || ''
      } catch (e) {
        // 忽略解析错误
      }
    }
    
    syncForm.setFieldsValue({
      dateRange: [beginDate, endDate],
      token: existingToken,
      api_url: existingApiUrl
    })
    setSyncResult(null)
    setSyncModalVisible(true)
  }

  const handleSyncSubmit = async (values) => {
    if (!syncAccount) return
    
    setSyncing(true)
    setSyncResult(null)
    
    try {
      const { dateRange, token, api_url } = values
      const beginDate = dateRange[0].format('YYYY-MM-DD')
      const endDate = dateRange[1].format('YYYY-MM-DD')
      
      // 构建请求数据
      const requestData = {
        begin_date: beginDate,
        end_date: endDate
      }
      
      // 如果提供了token，添加到请求中
      if (token) {
        requestData.token = token
      }
      
      // 如果提供了API URL，保存到账号备注中（用于Rewardoo多渠道支持）
      if (api_url && syncAccount?.platform) {
        const platformCode = (syncAccount.platform.platform_code || '').toLowerCase()
        if (platformCode === 'rewardoo' || platformCode === 'rw') {
          // 更新账号备注，保存API URL配置
          try {
            let notesData = {}
            if (syncAccount.notes) {
              try {
                notesData = JSON.parse(syncAccount.notes)
              } catch (e) {
                // 忽略解析错误
              }
            }
            notesData.rewardoo_api_url = api_url
            notesData.rw_api_url = api_url
            
            // 更新账号备注
            await api.put(`/api/affiliate/accounts/${syncAccount.id}`, {
              notes: JSON.stringify(notesData)
            })
          } catch (e) {
            console.warn('保存API URL配置失败:', e)
          }
        }
      }
      
      // 使用通用的平台数据同步API
      const response = await api.post(`/api/affiliate/accounts/${syncAccount.id}/sync`, requestData)
      
      setSyncResult(response.data)
      message.success(`成功同步 ${response.data.saved_count || 0} 条记录`)
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
      const dateRange = syncForm.getFieldValue('dateRange')
      if (!dateRange || dateRange.length !== 2) {
        message.warning('请先选择日期范围')
        setSyncing(false)
        return
      }
      
      const beginDate = dateRange[0].format('YYYY-MM-DD')
      const endDate = dateRange[1].format('YYYY-MM-DD')
      
      // 使用同步接口进行测试（只同步1天数据作为测试）
      const response = await api.post(`/api/affiliate/accounts/${syncAccount.id}/sync`, {
        begin_date: beginDate,
        end_date: beginDate, // 只测试第一天
        token: token || undefined
      })
      
      if (response.data.success) {
        message.success(`连接成功！找到 ${response.data.saved_count || 0} 条记录`)
      } else {
        message.error(response.data.message || '测试连接失败')
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
    const platformCode = platform.platform_code || platform.platformCode || ''
    return platformName.toLowerCase().includes('collabglow') || 
           platformName.toLowerCase().includes('collab') ||
           platformCode.toLowerCase() === 'collabglow'
  }

  // 检查是否为 LinkHaitao 平台
  const isLinkHaitaoPlatform = (account) => {
    const platform = account.platform || account
    const platformName = platform.platform_name || platform.platformName || ''
    const platformCode = platform.platform_code || platform.platformCode || ''
    return platformName.toLowerCase().includes('linkhaitao') || 
           platformName.toLowerCase().includes('link-haitao') ||
           platformCode.toLowerCase() === 'linkhaitao' ||
           platformCode.toLowerCase() === 'link-haitao'
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
            icon={<SyncOutlined />}
            onClick={() => handleSyncCollabGlow(record)}
          >
            同步数据
          </Button>
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
                            <Button
                              type="link"
                              size="small"
                              icon={<SyncOutlined />}
                              onClick={() => handleSyncCollabGlow(record)}
                            >
                              同步数据
                            </Button>
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
          title={`同步数据 - ${syncAccount?.account_name || ''}`}
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
              label={(() => {
                if (!syncAccount?.platform) return "API Token（可选）"
                const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                const field = platformConfig.fields[0]
                return field?.label || "API Token（可选）"
              })()}
              help={(() => {
                if (!syncAccount?.platform) return "如果不填写，将从账号备注中读取 token"
                const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                const field = platformConfig.fields[0]
                return field?.help ? `${field.help}。如果不填写，将从账号备注中读取 token` : `如果不填写，将从账号备注中读取 token`
              })()}
            >
              <Input.Password 
                placeholder={(() => {
                  if (!syncAccount?.platform) return "留空则使用账号备注中配置的 token"
                  const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                  const field = platformConfig.fields[0]
                  return field?.placeholder || "留空则使用账号备注中配置的 token"
                })()}
              />
            </Form.Item>

            {/* Rewardoo多渠道支持：API URL配置 */}
            {syncAccount?.platform && (() => {
              const platformCode = (syncAccount.platform.platform_code || '').toLowerCase()
              const platformName = (syncAccount.platform.platform_name || '').toLowerCase()
              // 支持多种平台代码和名称匹配（包括RW、rw、Rewardoo等）
              const isRewardoo = platformCode === 'rewardoo' || platformCode === 'rw' || 
                                platformName.includes('rewardoo') || platformName.includes('rw')
              
              if (isRewardoo) {
                const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                const apiUrlField = platformConfig.fields.find(f => f.name === 'rewardoo_api_url')
                if (apiUrlField) {
                  return (
                    <Form.Item
                      name="api_url"
                      label={apiUrlField.label}
                      help={apiUrlField.help}
                    >
                      <Input 
                        placeholder={apiUrlField.placeholder}
                      />
                    </Form.Item>
                  )
                }
              }
              return null
            })()}

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
                          value={syncResult.saved_count || 0}
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

            {/* 动态显示平台API配置字段 */}
            <Form.Item
              noStyle
              shouldUpdate={(prevValues, currentValues) => 
                prevValues.platform_id !== currentValues.platform_id
              }
            >
              {({ getFieldValue }) => {
                const selectedPlatformId = getFieldValue('platform_id')
                const selectedPlatform = platforms.find(p => p.id === selectedPlatformId)
                if (!selectedPlatform) return null
                
                // 获取平台代码和名称（转换为小写用于匹配）
                const platformCode = (selectedPlatform.platform_code || '').toLowerCase()
                const platformName = (selectedPlatform.platform_name || '').toLowerCase()
                
                // 检查是否是Rewardoo平台（支持多种代码格式）
                const isRewardoo = platformCode === 'rewardoo' || platformCode === 'rw' || 
                                  platformName.includes('rewardoo') || platformName.includes('rw')
                
                // 获取平台配置
                const platformConfig = getPlatformApiConfig(selectedPlatform.platform_code)
                
                // 检查是否是特定平台的配置（不是默认配置）
                const hasSpecificConfig = PLATFORM_API_CONFIG[platformCode] && 
                                        PLATFORM_API_CONFIG[platformCode] !== PLATFORM_API_CONFIG.default
                
                // 如果是Rewardoo平台或有特定配置，显示字段
                if ((isRewardoo || hasSpecificConfig) && platformConfig.fields && platformConfig.fields.length > 0) {
                  return platformConfig.fields.map(field => (
                    <Form.Item
                      key={field.name}
                      name={field.name}
                      label={field.label}
                      help={field.help}
                      rules={field.required ? [{ required: true, message: `请输入${field.label}` }] : []}
                    >
                      {field.type === 'password' ? (
                        <Input.Password placeholder={field.placeholder} />
                      ) : (
                        <Input placeholder={field.placeholder} />
                      )}
                    </Form.Item>
                  ))
                }
                return null
              }}
            </Form.Item>
          </Form>
        </Modal>

        {/* CollabGlow 同步模态框 */}
        <Modal
          title={`同步数据 - ${syncAccount?.account_name || ''}`}
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
              label={(() => {
                if (!syncAccount?.platform) return "API Token（可选）"
                const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                const field = platformConfig.fields[0]
                return field?.label || "API Token（可选）"
              })()}
              help={(() => {
                if (!syncAccount?.platform) return "如果不填写，将从账号备注中读取 token"
                const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                const field = platformConfig.fields[0]
                return field?.help ? `${field.help}。如果不填写，将从账号备注中读取 token` : `如果不填写，将从账号备注中读取 token`
              })()}
            >
              <Input.Password 
                placeholder={(() => {
                  if (!syncAccount?.platform) return "留空则使用账号备注中配置的 token"
                  const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                  const field = platformConfig.fields[0]
                  return field?.placeholder || "留空则使用账号备注中配置的 token"
                })()}
              />
            </Form.Item>

            {/* Rewardoo多渠道支持：API URL配置 */}
            {syncAccount?.platform && (() => {
              const platformCode = (syncAccount.platform.platform_code || '').toLowerCase()
              const platformName = (syncAccount.platform.platform_name || '').toLowerCase()
              // 支持多种平台代码和名称匹配（包括RW、rw、Rewardoo等）
              const isRewardoo = platformCode === 'rewardoo' || platformCode === 'rw' || 
                                platformName.includes('rewardoo') || platformName.includes('rw')
              
              if (isRewardoo) {
                const platformConfig = getPlatformApiConfig(syncAccount.platform.platform_code)
                const apiUrlField = platformConfig.fields.find(f => f.name === 'rewardoo_api_url')
                if (apiUrlField) {
                  return (
                    <Form.Item
                      name="api_url"
                      label={apiUrlField.label}
                      help={apiUrlField.help}
                    >
                      <Input 
                        placeholder={apiUrlField.placeholder}
                      />
                    </Form.Item>
                  )
                }
              }
              return null
            })()}

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
                          value={syncResult.saved_count || 0}
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
