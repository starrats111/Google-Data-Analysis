import React, { useState, useEffect } from 'react'
import { 
  Card, Table, Button, Modal, Form, Input, message, Popconfirm, Tag, Space, 
  Switch, Steps, Alert, Upload, Tabs, Progress, Tooltip, DatePicker, Divider,
  Typography, Badge, Descriptions, Row, Col
} from 'antd'
import { 
  PlusOutlined, EditOutlined, DeleteOutlined, SyncOutlined, LinkOutlined, 
  CheckCircleOutlined, UploadOutlined, CloudSyncOutlined, HistoryOutlined,
  ApiOutlined, InfoCircleOutlined, WarningOutlined, ClockCircleOutlined,
  FileTextOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import api from '../services/api'
import { useAuth } from '../store/authStore'

// 启用时区插件
dayjs.extend(utc)
dayjs.extend(timezone)

const { TextArea } = Input
const { RangePicker } = DatePicker
const { Text, Paragraph } = Typography

export default function MccAccounts() {
  const { user } = useAuth()
  const isManager = user?.role === 'manager' || user?.username === 'wenjun123'
  
  const [mccAccounts, setMccAccounts] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingMcc, setEditingMcc] = useState(null)
  const [form] = Form.useForm()
  const [syncLoading, setSyncLoading] = useState({})
  const [testLoading, setTestLoading] = useState({})
  
  // 批量导入
  const [batchModalVisible, setBatchModalVisible] = useState(false)
  const [batchForm] = Form.useForm()
  const [batchLoading, setBatchLoading] = useState(false)
  
  // 历史数据同步
  const [historyModalVisible, setHistoryModalVisible] = useState(false)
  const [historyMcc, setHistoryMcc] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  
  // 服务账号配置
  const [serviceAccountStatus, setServiceAccountStatus] = useState(null)
  const [saModalVisible, setSaModalVisible] = useState(false)
  const [saForm] = Form.useForm()
  const [saLoading, setSaLoading] = useState(false)
  
  // 同步状态
  const [syncStatusVisible, setSyncStatusVisible] = useState(false)
  const [syncStatusData, setSyncStatusData] = useState([])

  useEffect(() => {
    fetchMccAccounts()
    fetchServiceAccountStatus()
  }, [])

  const fetchMccAccounts = async () => {
    if (loading) return
    
    setLoading(true)
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)
      
      const response = await api.get('/api/mcc/accounts', { signal: controller.signal })
      clearTimeout(timeoutId)
      
      setMccAccounts(response.data || [])
    } catch (error) {
      console.error('获取MCC账号列表失败:', error)
      message.error('获取MCC账号列表失败')
      setMccAccounts([])
    } finally {
      setLoading(false)
    }
  }

  const fetchServiceAccountStatus = async () => {
    try {
      const response = await api.get('/api/mcc/service-account/status')
      setServiceAccountStatus(response.data)
    } catch (error) {
      console.error('获取服务账号状态失败:', error)
    }
  }

  const handleCreate = () => {
    setEditingMcc(null)
    form.resetFields()
    form.setFieldsValue({ use_service_account: true })
    setModalVisible(true)
  }

  const handleEdit = (mcc) => {
    setEditingMcc(mcc)
    form.setFieldsValue({
      mcc_id: mcc.mcc_id,
      mcc_name: mcc.mcc_name,
      email: mcc.email || '',
      use_service_account: mcc.use_service_account !== false,
      is_active: mcc.is_active
    })
    setModalVisible(true)
  }

  const handleSubmit = async (values) => {
    try {
      const submitData = { ...values }
      
      // 清理空值
      Object.keys(submitData).forEach(key => {
        if (submitData[key] === '' || submitData[key] === undefined) {
          delete submitData[key]
        }
      })
      
      if (editingMcc) {
        await api.put(`/api/mcc/accounts/${editingMcc.id}`, submitData)
        message.success('更新成功')
      } else {
        await api.post('/api/mcc/accounts', submitData)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      fetchMccAccounts()
    } catch (error) {
      console.error('保存失败:', error)
      message.error(error.response?.data?.detail || '操作失败')
    }
  }

  const handleDelete = async (id, record) => {
    try {
      const mccId = typeof id === 'number' ? id : parseInt(id.toString().split(':')[0], 10)
      
      if (isNaN(mccId) || mccId <= 0) {
        message.error('无效的MCC账号ID')
        return
      }
      
      const response = await api.delete(`/api/mcc/accounts/${mccId}`)
      const deletedCount = response.data?.deleted_data_count || 0
      const mccName = response.data?.mcc_name || record?.mcc_name || 'MCC账号'
      
      if (deletedCount > 0) {
        message.success(`已删除MCC账号"${mccName}"，同时删除了 ${deletedCount} 条关联数据`)
      } else {
        message.success(`已删除MCC账号"${mccName}"`)
      }
      fetchMccAccounts()
    } catch (error) {
      console.error('删除失败:', error)
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  const handleSync = async (mccId) => {
    setSyncLoading({ ...syncLoading, [mccId]: true })
    try {
      // 同步最近7天的数据
      const endDate = new Date()
      endDate.setDate(endDate.getDate() - 1)  // 昨天
      const beginDate = new Date()
      beginDate.setDate(beginDate.getDate() - 7)  // 7天前
      
      const response = await api.post(`/api/mcc/accounts/${mccId}/sync`, {
        begin_date: beginDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0]
      })
      
      if (response.data.async) {
        message.info(response.data.message)
      } else if (response.data.success) {
        message.success(response.data.message || '同步成功')
      } else {
        message.warning(response.data.message || '同步完成，但可能没有数据')
      }
      
      // 延迟刷新，等待后台任务开始
      setTimeout(() => fetchMccAccounts(), 2000)
    } catch (error) {
      console.error('同步失败:', error)
      message.error(error.response?.data?.detail || '同步失败')
    } finally {
      setSyncLoading({ ...syncLoading, [mccId]: false })
    }
  }

  const handleTestConnection = async (mccId) => {
    setTestLoading({ ...testLoading, [mccId]: true })
    try {
      const response = await api.post(`/api/mcc/accounts/${mccId}/test-connection`)
      
      if (response.data.success) {
        message.success(`✓ 连接成功！找到 ${response.data.customers_count} 个客户账号`)
      } else {
        message.error(response.data.message || '连接测试失败')
      }
    } catch (error) {
      console.error('测试连接失败:', error)
      message.error(error.response?.data?.detail || '测试连接失败')
    } finally {
      setTestLoading({ ...testLoading, [mccId]: false })
    }
  }

  const handleSyncHistory = async (values) => {
    if (!historyMcc) return
    
    setHistoryLoading(true)
    try {
      const [beginDate, endDate] = values.dateRange
      
      const response = await api.post(`/api/mcc/accounts/${historyMcc.id}/sync-history`, {
        begin_date: beginDate.format('YYYY-MM-DD'),
        end_date: endDate.format('YYYY-MM-DD'),
        force_refresh: values.force_refresh || false
      })
      
      if (response.data.async) {
        message.info(response.data.message)
        setHistoryModalVisible(false)
      } else {
        message.success('历史数据同步已开始')
      }
    } catch (error) {
      console.error('同步历史数据失败:', error)
      message.error(error.response?.data?.detail || '同步历史数据失败')
    } finally {
      setHistoryLoading(false)
    }
  }

  const handleBatchImport = async (values) => {
    setBatchLoading(true)
    try {
      // 解析CSV或JSON格式的MCC列表
      const lines = values.mccList.trim().split('\n').filter(line => line.trim())
      const mccs = []
      
      for (const line of lines) {
        const parts = line.split(',').map(s => s.trim())
        if (parts.length >= 2) {
          mccs.push({
            mcc_id: parts[0],
            mcc_name: parts[1],
            email: parts[2] || '',
            use_service_account: true
          })
        } else if (parts.length === 1 && parts[0]) {
          // 只有MCC ID的情况
          mccs.push({
            mcc_id: parts[0],
            mcc_name: parts[0],
            use_service_account: true
          })
        }
      }
      
      if (mccs.length === 0) {
        message.warning('没有找到有效的MCC信息')
        return
      }
      
      const response = await api.post('/api/mcc/accounts/batch', { mccs })
      
      const created = response.data.length
      message.success(`成功导入 ${created} 个MCC账号`)
      
      setBatchModalVisible(false)
      batchForm.resetFields()
      fetchMccAccounts()
    } catch (error) {
      console.error('批量导入失败:', error)
      message.error(error.response?.data?.detail || '批量导入失败')
    } finally {
      setBatchLoading(false)
    }
  }

  const handleUploadServiceAccount = async (values) => {
    setSaLoading(true)
    try {
      const response = await api.post('/api/mcc/service-account', {
        json_content: values.json_content,
        is_base64: false
      })
      
      if (response.data.success) {
        message.success(`服务账号配置成功！邮箱: ${response.data.service_account_email}`)
        setSaModalVisible(false)
        saForm.resetFields()
        fetchServiceAccountStatus()
      }
    } catch (error) {
      console.error('上传服务账号失败:', error)
      message.error(error.response?.data?.detail || '上传失败')
    } finally {
      setSaLoading(false)
    }
  }

  const handleSyncAll = async () => {
    try {
      const response = await api.post('/api/mcc/sync-all', {})
      
      if (response.data.async) {
        message.info(response.data.message)
      } else {
        message.success('批量同步已开始')
      }
      
      setTimeout(() => fetchMccAccounts(), 3000)
    } catch (error) {
      console.error('批量同步失败:', error)
      message.error(error.response?.data?.detail || '批量同步失败')
    }
  }

  const fetchSyncStatus = async () => {
    try {
      const response = await api.get('/api/mcc/sync-status')
      setSyncStatusData(response.data.data || [])
      setSyncStatusVisible(true)
    } catch (error) {
      console.error('获取同步状态失败:', error)
      message.error('获取同步状态失败')
    }
  }

  const getSyncStatusTag = (status) => {
    const statusMap = {
      'success': { color: 'green', text: '成功', icon: <CheckCircleOutlined /> },
      'failed': { color: 'red', text: '失败', icon: <WarningOutlined /> },
      'warning': { color: 'orange', text: '警告', icon: <InfoCircleOutlined /> },
      'pending': { color: 'blue', text: '等待中', icon: <ClockCircleOutlined /> }
    }
    const config = statusMap[status] || { color: 'default', text: status || '未同步' }
    return <Tag color={config.color} icon={config.icon}>{config.text}</Tag>
  }

  const columns = [
    {
      title: 'MCC ID',
      dataIndex: 'mcc_id',
      key: 'mcc_id',
      width: 140,
    },
    {
      title: 'MCC名称',
      dataIndex: 'mcc_name',
      key: 'mcc_name',
      ellipsis: true,
    },
    // 管理员可见：归属员工列
    isManager && {
      title: '归属员工',
      dataIndex: 'owner_username',
      key: 'owner_username',
      width: 100,
      render: (val) => <Tag color="cyan">{val || '未知'}</Tag>
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 80,
      render: (val) => <Tag color={val ? 'green' : 'red'}>{val ? '激活' : '停用'}</Tag>
    },
    {
      title: '认证模式',
      key: 'auth_mode',
      width: 100,
      render: (_, record) => (
        <Tag color={record.use_service_account !== false ? 'blue' : 'purple'}>
          {record.use_service_account !== false ? '服务账号' : 'OAuth'}
        </Tag>
      )
    },
    {
      title: '同步状态',
      key: 'sync_status',
      width: 120,
      render: (_, record) => (
        <Tooltip title={record.last_sync_message || '暂无同步记录'}>
          {getSyncStatusTag(record.last_sync_status)}
        </Tooltip>
      )
    },
    {
      title: '客户/系列',
      key: 'counts',
      width: 100,
      render: (_, record) => (
        <span>
          {record.total_customers || 0} / {record.total_campaigns || 0}
        </span>
      )
    },
    {
      title: '数据条数',
      dataIndex: 'data_count',
      key: 'data_count',
      width: 80,
    },
    {
      title: '最后同步',
      key: 'last_sync',
      width: 120,
      render: (_, record) => (
        record.last_sync_at ? (
          <Tooltip title={record.last_sync_at}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {dayjs.utc(record.last_sync_at).local().format('YYYY-MM-DD')}
            </Text>
          </Tooltip>
        ) : <Text type="secondary">-</Text>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_, record) => (
        <Space size="small" wrap>
          <Tooltip title="测试连接">
            <Button
              type="link"
              size="small"
              icon={<ApiOutlined />}
              onClick={() => handleTestConnection(record.id)}
              loading={testLoading[record.id]}
            />
          </Tooltip>
          <Tooltip title="同步昨日数据">
            <Button
              type="link"
              size="small"
              icon={<SyncOutlined />}
              onClick={() => handleSync(record.id)}
              loading={syncLoading[record.id]}
            />
          </Tooltip>
          <Tooltip title="同步历史数据">
            <Button
              type="link"
              size="small"
              icon={<HistoryOutlined />}
              onClick={() => {
                setHistoryMcc(record)
                setHistoryModalVisible(true)
              }}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
          <Popconfirm
            title={
              <div>
                <div>确定要删除这个MCC账号吗？</div>
                {record.data_count > 0 && (
                  <div style={{ fontSize: 12, color: '#ff4d4f', marginTop: 4 }}>
                    ⚠️ 将同时删除 {record.data_count} 条关联数据
                  </div>
                )}
              </div>
            }
            onConfirm={() => handleDelete(record.id, record)}
            okText="确定删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Tooltip title="删除">
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <div>
      {/* 服务账号状态提示 */}
      {serviceAccountStatus && !serviceAccountStatus.configured && (
        <Alert
          message="服务账号未配置"
          description={
            <span>
              请先配置全局服务账号，才能使用服务账号模式同步数据。
              <Button type="link" onClick={() => setSaModalVisible(true)}>
                点击配置
              </Button>
            </span>
          }
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 头部操作栏 */}
      <Card style={{ marginBottom: 16 }}>
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              <h2 style={{ margin: 0 }}>MCC账号管理</h2>
              {serviceAccountStatus?.configured && (
                <Tag color="green" icon={<CheckCircleOutlined />}>
                  服务账号已配置
                </Tag>
              )}
            </Space>
          </Col>
          <Col>
            <Space>
              <Button icon={<CloudSyncOutlined />} onClick={handleSyncAll}>
                同步所有MCC
              </Button>
              <Button icon={<InfoCircleOutlined />} onClick={fetchSyncStatus}>
                同步状态
              </Button>
              {isManager && (
                <Button icon={<UploadOutlined />} onClick={() => setSaModalVisible(true)}>
                  配置服务账号
                </Button>
              )}
              <Button icon={<FileTextOutlined />} onClick={() => setBatchModalVisible(true)}>
                批量导入
              </Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
                添加MCC
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* MCC列表 */}
      <Card>
        <Table
          columns={columns.filter(Boolean)}
          dataSource={mccAccounts}
          loading={loading}
          rowKey="id"
          size="middle"
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 个MCC` }}
          locale={{ emptyText: '暂无MCC账号，请点击"添加MCC"或"批量导入"按钮添加' }}
        />
      </Card>

      {/* 添加/编辑MCC模态框 */}
      <Modal
        title={editingMcc ? '编辑MCC账号' : '添加MCC账号'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={500}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="mcc_id"
            label="MCC ID"
            rules={[{ required: !editingMcc, message: '请输入MCC ID' }]}
            help="格式：123-456-7890 或 1234567890"
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

          <Form.Item name="email" label="邮箱（可选）">
            <Input placeholder="关联的邮箱地址（仅用于记录）" />
          </Form.Item>

          <Form.Item
            name="use_service_account"
            label="认证模式"
            valuePropName="checked"
            initialValue={true}
          >
            <Switch 
              checkedChildren="服务账号" 
              unCheckedChildren="OAuth" 
              defaultChecked
            />
          </Form.Item>

          {editingMcc && (
            <Form.Item name="is_active" label="状态" valuePropName="checked">
              <Switch checkedChildren="激活" unCheckedChildren="停用" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 批量导入模态框 */}
      <Modal
        title="批量导入MCC账号"
        open={batchModalVisible}
        onCancel={() => setBatchModalVisible(false)}
        onOk={() => batchForm.submit()}
        confirmLoading={batchLoading}
        width={600}
      >
        <Alert
          message="导入格式说明"
          description={
            <div>
              <p>每行一个MCC，格式：<code>MCC_ID,MCC名称,邮箱(可选)</code></p>
              <p>示例：</p>
              <pre style={{ background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
{`123-456-7890,我的MCC账号1
234-567-8901,我的MCC账号2,test@example.com
345-678-9012,我的MCC账号3`}
              </pre>
            </div>
          }
          type="info"
          style={{ marginBottom: 16 }}
        />
        
        <Form form={batchForm} layout="vertical" onFinish={handleBatchImport}>
          <Form.Item
            name="mccList"
            label="MCC列表"
            rules={[{ required: true, message: '请输入MCC列表' }]}
          >
            <TextArea 
              rows={10} 
              placeholder="每行一个MCC，格式：MCC_ID,MCC名称,邮箱(可选)"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 历史数据同步模态框 */}
      <Modal
        title={`同步历史数据 - ${historyMcc?.mcc_name || ''}`}
        open={historyModalVisible}
        onCancel={() => {
          setHistoryModalVisible(false)
          setHistoryMcc(null)
        }}
        footer={null}
        width={500}
      >
        <Form layout="vertical" onFinish={handleSyncHistory}>
          <Form.Item
            name="dateRange"
            label="日期范围"
            rules={[{ required: true, message: '请选择日期范围' }]}
          >
            <RangePicker style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="force_refresh"
            label="强制刷新"
            valuePropName="checked"
            help="如果勾选，将重新同步已存在的数据"
          >
            <Switch />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={historyLoading} block>
              开始同步
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* 服务账号配置模态框 */}
      <Modal
        title="配置全局服务账号"
        open={saModalVisible}
        onCancel={() => setSaModalVisible(false)}
        footer={null}
        width={700}
      >
        <Alert
          message="服务账号配置说明"
          description={
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>在 Google Cloud Console 创建服务账号</li>
              <li>下载 JSON 密钥文件</li>
              <li>将 JSON 内容粘贴到下方</li>
              <li>在每个 MCC 账号中添加服务账号邮箱为用户</li>
            </ol>
          }
          type="info"
          style={{ marginBottom: 16 }}
        />

        {serviceAccountStatus?.configured && (
          <Descriptions bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label="配置来源" span={3}>
              {serviceAccountStatus.source === 'file' ? '文件' : 
               serviceAccountStatus.source === 'environment_base64' ? '环境变量' : '默认文件'}
            </Descriptions.Item>
            <Descriptions.Item label="服务账号邮箱" span={3}>
              {serviceAccountStatus.service_account_email || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="项目ID" span={3}>
              {serviceAccountStatus.project_id || '-'}
            </Descriptions.Item>
          </Descriptions>
        )}

        <Form form={saForm} layout="vertical" onFinish={handleUploadServiceAccount}>
          <Form.Item
            name="json_content"
            label="服务账号 JSON 密钥"
            rules={[{ required: true, message: '请粘贴JSON密钥内容' }]}
          >
            <TextArea 
              rows={12}
              placeholder='粘贴服务账号 JSON 密钥内容，格式如：
{
  "type": "service_account",
  "project_id": "your-project-id",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...",
  "client_email": "xxx@your-project.iam.gserviceaccount.com",
  ...
}'
            />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saLoading} block>
              保存服务账号配置
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* 同步状态模态框 */}
      <Modal
        title="MCC同步状态"
        open={syncStatusVisible}
        onCancel={() => setSyncStatusVisible(false)}
        footer={null}
        width={800}
      >
        <Table
          dataSource={syncStatusData}
          rowKey="id"
          size="small"
          pagination={false}
          columns={[
            { title: 'MCC ID', dataIndex: 'mcc_id', width: 120 },
            { title: 'MCC名称', dataIndex: 'mcc_name', ellipsis: true },
            { 
              title: '状态', 
              dataIndex: 'last_sync_status',
              width: 80,
              render: (val) => getSyncStatusTag(val)
            },
            { 
              title: '最后同步', 
              dataIndex: 'last_sync_at',
              width: 120,
              render: (val) => val ? dayjs.utc(val).local().format('YYYY-MM-DD HH:mm:ss') : '-'
            },
            { 
              title: '同步日期', 
              dataIndex: 'last_sync_date',
              width: 100,
            },
            {
              title: '客户/系列',
              width: 80,
              render: (_, r) => `${r.total_customers || 0}/${r.total_campaigns || 0}`
            },
            { 
              title: '消息', 
              dataIndex: 'last_sync_message',
              ellipsis: true,
            },
          ]}
        />
      </Modal>
    </div>
  )
}
