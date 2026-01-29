import React, { useState, useEffect } from 'react'
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  message,
  Popconfirm,
  Space,
  Upload,
  Tag,
  Row,
  Col,
  DatePicker,
} from 'antd'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  UploadOutlined,
  SearchOutlined,
  ReloadOutlined,
  InboxOutlined,
} from '@ant-design/icons'
import api from '../services/api'

const { Dragger } = Upload

const { Option } = Select
const { Search } = Input

const AdCampaigns = () => {
  const [campaigns, setCampaigns] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [importModalVisible, setImportModalVisible] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importLoading, setImportLoading] = useState(false)
  const [editingCampaign, setEditingCampaign] = useState(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState([])
  const [form] = Form.useForm()
  const [importForm] = Form.useForm()

  // 搜索和筛选状态
  const [searchMerchantId, setSearchMerchantId] = useState('')
  const [searchCampaignName, setSearchCampaignName] = useState('')
  const [filterPlatformId, setFilterPlatformId] = useState(null)
  const [filterStatus, setFilterStatus] = useState(null)
  const [metricsDate, setMetricsDate] = useState(null) // 查看某一天的每日指标（可选）

  useEffect(() => {
    fetchPlatforms()
    fetchAccounts()
    fetchCampaigns()
  }, [])

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms')
      setPlatforms(response.data)
    } catch (error) {
      message.error('获取平台列表失败')
    }
  }

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/api/affiliate/accounts')
      setAccounts(response.data)
    } catch (error) {
      message.error('获取账号列表失败')
    }
  }

  const fetchCampaigns = async () => {
    setLoading(true)
    try {
      const params = {}
      if (searchMerchantId) params.merchant_id = searchMerchantId
      if (searchCampaignName) params.campaign_name = searchCampaignName
      if (filterPlatformId) params.platform_id = filterPlatformId
      if (filterStatus) params.status = filterStatus
      if (metricsDate) params.metrics_date = metricsDate.format('YYYY-MM-DD')

      const response = await api.get('/api/ad-campaigns', { params })
      setCampaigns(response.data)
    } catch (error) {
      message.error('获取广告系列列表失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = () => {
    setEditingCampaign(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (record) => {
    setEditingCampaign(record)
    form.setFieldsValue(record)
    setModalVisible(true)
  }

  const handleDelete = async (id) => {
    try {
      await api.delete(`/api/ad-campaigns/${id}`)
      message.success('删除成功')
      fetchCampaigns()
    } catch (error) {
      message.error('删除失败')
    }
  }

  const handleSubmit = async (values) => {
    try {
      if (editingCampaign) {
        await api.put(`/api/ad-campaigns/${editingCampaign.id}`, values)
        message.success('更新成功')
      } else {
        await api.post('/api/ad-campaigns', values)
        message.success('创建成功')
      }
      setModalVisible(false)
      form.resetFields()
      fetchCampaigns()
    } catch (error) {
      message.error(editingCampaign ? '更新失败' : '创建失败')
    }
  }

  const handleBatchUpdateStatus = async (status) => {
    if (selectedRowKeys.length === 0) {
      message.warning('请先选择要操作的广告系列')
      return
    }

    try {
      await api.post('/api/ad-campaigns/batch-update', {
        campaign_ids: selectedRowKeys,
        status: status,
      })
      message.success(`成功${status === '启用' ? '启用' : '暂停'} ${selectedRowKeys.length} 个广告系列`)
      setSelectedRowKeys([])
      fetchCampaigns()
    } catch (error) {
      message.error('批量操作失败')
    }
  }

  const handleImport = async (values) => {
    if (!importFile) {
      message.warning('请先选择要上传的文件')
      return
    }

    setImportLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', importFile)
      formData.append('affiliate_account_id', values.affiliate_account_id)
      formData.append('platform_id', values.platform_id)

      const response = await api.post('/api/ad-campaigns/import', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      })

      message.success(`导入成功：${response.data.imported} 条，跳过：${response.data.skipped} 条`)
      setImportModalVisible(false)
      setImportFile(null)
      importForm.resetFields()
      fetchCampaigns()
    } catch (error) {
      message.error('导入失败：' + (error.response?.data?.detail || error.message))
    } finally {
      setImportLoading(false)
    }
  }

  const uploadProps = {
    name: 'file',
    multiple: false,
    accept: '.xlsx,.xls',
    beforeUpload: (file) => {
      setImportFile(file)
      return false // 阻止自动上传
    },
    onRemove: () => {
      setImportFile(null)
    },
    fileList: importFile ? [importFile] : [],
  }

  const columns = [
    {
      title: 'CID账号',
      dataIndex: 'cid_account',
      key: 'cid_account',
      width: 150,
    },
    {
      title: '网址',
      dataIndex: 'url',
      key: 'url',
      width: 200,
      ellipsis: true,
    },
    {
      title: '商家ID',
      dataIndex: 'merchant_id',
      key: 'merchant_id',
      width: 120,
    },
    {
      title: '国家',
      dataIndex: 'country',
      key: 'country',
      width: 80,
    },
    {
      title: '广告系列',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      width: 250,
      ellipsis: true,
    },
    {
      title: '广告时间',
      dataIndex: 'ad_time',
      key: 'ad_time',
      width: 120,
    },
    {
      title: '关键词',
      dataIndex: 'keywords',
      key: 'keywords',
      width: 200,
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === '启用' ? 'green' : 'red'}>{status}</Tag>
      ),
    },
    ...(metricsDate
      ? [
          { title: '当日订单', dataIndex: 'daily_orders', key: 'daily_orders', align: 'right', width: 110 },
          { title: '当日预算', dataIndex: 'daily_budget', key: 'daily_budget', align: 'right', width: 110 },
          { title: '当日CPC', dataIndex: 'daily_cpc', key: 'daily_cpc', align: 'right', width: 110 },
          { title: '当日花费', dataIndex: 'daily_cost', key: 'daily_cost', align: 'right', width: 110 },
          { title: '当日佣金', dataIndex: 'daily_commission', key: 'daily_commission', align: 'right', width: 110 },
          { title: 'L7D出单天数(自动)', dataIndex: 'daily_past_seven_days_order_days', key: 'daily_past_seven_days_order_days', align: 'right', width: 160 },
          { title: '当前Max CPC(自动)', dataIndex: 'daily_current_max_cpc', key: 'daily_current_max_cpc', align: 'right', width: 160 },
        ]
      : []),
    {
      title: '操作',
      key: 'action',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确定要删除这个广告系列吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Button
              type="link"
              size="small"
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

  const rowSelection = {
    selectedRowKeys,
    onChange: setSelectedRowKeys,
  }

  return (
    <div>
      <Card>
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Search
              placeholder="搜索商家ID"
              allowClear
              value={searchMerchantId}
              onChange={(e) => setSearchMerchantId(e.target.value)}
              onSearch={fetchCampaigns}
              style={{ width: '100%' }}
            />
          </Col>
          <Col span={6}>
            <Search
              placeholder="搜索广告系列"
              allowClear
              value={searchCampaignName}
              onChange={(e) => setSearchCampaignName(e.target.value)}
              onSearch={fetchCampaigns}
              style={{ width: '100%' }}
            />
          </Col>
          <Col span={4}>
            <Select
              placeholder="筛选平台"
              allowClear
              value={filterPlatformId}
              onChange={(value) => {
                setFilterPlatformId(value)
                fetchCampaigns()
              }}
              style={{ width: '100%' }}
            >
              {platforms.map((platform) => (
                <Option key={platform.id} value={platform.id}>
                  {platform.platform_name}
                </Option>
              ))}
            </Select>
          </Col>
          <Col span={4}>
            <Select
              placeholder="筛选状态"
              allowClear
              value={filterStatus}
              onChange={(value) => {
                setFilterStatus(value)
                fetchCampaigns()
              }}
              style={{ width: '100%' }}
            >
              <Option value="启用">启用</Option>
              <Option value="暂停">暂停</Option>
            </Select>
          </Col>
          <Col span={4}>
            <Button
              icon={<ReloadOutlined />}
              onClick={fetchCampaigns}
            >
              刷新
            </Button>
          </Col>
        </Row>
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <DatePicker
              value={metricsDate}
              onChange={(v) => {
                setMetricsDate(v)
                // 切换日期后立即刷新列表
                setTimeout(fetchCampaigns, 0)
              }}
              allowClear
              style={{ width: '100%' }}
              placeholder="选择某一天查看每日指标(可选)"
            />
          </Col>
        </Row>

        <Space style={{ marginBottom: 16 }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreate}
          >
            新建广告系列
          </Button>
          <Button
            icon={<UploadOutlined />}
            onClick={() => setImportModalVisible(true)}
          >
            导入Excel
          </Button>
          {selectedRowKeys.length > 0 && (
            <>
              <Button
                onClick={() => handleBatchUpdateStatus('启用')}
              >
                批量启用 ({selectedRowKeys.length})
              </Button>
              <Button
                onClick={() => handleBatchUpdateStatus('暂停')}
              >
                批量暂停 ({selectedRowKeys.length})
              </Button>
            </>
          )}
        </Space>

        <Table
          rowSelection={rowSelection}
          columns={columns}
          dataSource={campaigns}
          rowKey="id"
          loading={loading}
          scroll={{ x: metricsDate ? 2300 : 1500 }}
          pagination={{
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
          }}
        />
      </Card>

      {/* 创建/编辑模态框 */}
      <Modal
        title={editingCampaign ? '编辑广告系列' : '新建广告系列'}
        open={modalVisible}
        onCancel={() => {
          setModalVisible(false)
          form.resetFields()
        }}
        onOk={() => form.submit()}
        width={800}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
        >
          <Form.Item
            name="affiliate_account_id"
            label="联盟账号"
            rules={[{ required: true, message: '请选择联盟账号' }]}
          >
            <Select placeholder="选择联盟账号">
              {accounts.map((account) => (
                <Option key={account.id} value={account.id}>
                  {account.account_name} ({account.platform?.platform_name})
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            name="platform_id"
            label="平台"
            rules={[{ required: true, message: '请选择平台' }]}
          >
            <Select placeholder="选择平台">
              {platforms.map((platform) => (
                <Option key={platform.id} value={platform.id}>
                  {platform.platform_name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            name="cid_account"
            label="CID账号"
          >
            <Input placeholder="CID账号" />
          </Form.Item>
          <Form.Item
            name="url"
            label="网址"
          >
            <Input placeholder="网址" />
          </Form.Item>
          <Form.Item
            name="merchant_id"
            label="商家ID"
            rules={[{ required: true, message: '请输入商家ID' }]}
          >
            <Input placeholder="商家ID" />
          </Form.Item>
          <Form.Item
            name="country"
            label="国家"
          >
            <Input placeholder="国家代码，如：DE, US" />
          </Form.Item>
          <Form.Item
            name="campaign_name"
            label="广告系列"
            rules={[{ required: true, message: '请输入广告系列名称' }]}
          >
            <Input placeholder="广告系列名称" />
          </Form.Item>
          <Form.Item
            name="ad_time"
            label="广告时间"
          >
            <Input placeholder="广告时间，如：1月26日" />
          </Form.Item>
          <Form.Item
            name="keywords"
            label="关键词"
          >
            <Input.TextArea placeholder="关键词" rows={3} />
          </Form.Item>
          <Form.Item
            name="status"
            label="状态"
            initialValue="启用"
          >
            <Select>
              <Option value="启用">启用</Option>
              <Option value="暂停">暂停</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 导入模态框 */}
      <Modal
        title="导入广告系列"
        open={importModalVisible}
        onCancel={() => {
          setImportModalVisible(false)
          setImportFile(null)
          importForm.resetFields()
        }}
        onOk={() => importForm.submit()}
        confirmLoading={importLoading}
      >
        <Form
          form={importForm}
          layout="vertical"
          onFinish={handleImport}
        >
          <Form.Item
            name="affiliate_account_id"
            label="联盟账号"
            rules={[{ required: true, message: '请选择联盟账号' }]}
          >
            <Select placeholder="选择联盟账号">
              {accounts.map((account) => (
                <Option key={account.id} value={account.id}>
                  {account.account_name} ({account.platform?.platform_name})
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            name="platform_id"
            label="平台"
            rules={[{ required: true, message: '请选择平台' }]}
          >
            <Select placeholder="选择平台">
              {platforms.map((platform) => (
                <Option key={platform.id} value={platform.id}>
                  {platform.platform_name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="上传Excel文件"
            required
            help="支持 .xlsx 和 .xls 格式，文件需包含'商家ID'和'广告系列'列"
          >
            <Dragger {...uploadProps}>
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此区域上传</p>
              <p className="ant-upload-hint">
                支持单个文件上传，仅支持 Excel 格式
              </p>
            </Dragger>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default AdCampaigns

