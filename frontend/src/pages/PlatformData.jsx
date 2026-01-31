import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Form, Select, DatePicker, message, Tag, Space, Input, Radio, Statistic, Row, Col } from 'antd'
import { SearchOutlined, DownloadOutlined, EyeOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker

export default function PlatformData() {
  const { user } = useAuth()
  const navigate = useNavigate()
  
  const [loading, setLoading] = useState(false)
  const [detailData, setDetailData] = useState([]) // 明细数据
  const [summaryData, setSummaryData] = useState(null) // 汇总数据
  const [platforms, setPlatforms] = useState([])
  const [form] = Form.useForm()
  const [viewMode, setViewMode] = useState('detail') // 'detail' 或 'summary'
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    fetchPlatforms()
    // 默认查询最近7天的数据
    const endDate = dayjs()
    const beginDate = endDate.subtract(7, 'day')
    form.setFieldsValue({
      dateRange: [beginDate, endDate]
    })
    handleSearch({ dateRange: [beginDate, endDate] })
  }, [])

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms')
      setPlatforms(response.data)
    } catch (error) {
      console.error('获取平台列表失败', error)
    }
  }

  const handleSearch = async (values) => {
    setLoading(true)
    try {
      const params = {}
      
      if (values.platform) {
        params.platform = values.platform
      }
      
      if (values.merchant) {
        params.merchant = values.merchant
      }
      
      if (values.dateRange && values.dateRange.length === 2) {
        params.begin_date = values.dateRange[0].format('YYYY-MM-DD')
        params.end_date = values.dateRange[1].format('YYYY-MM-DD')
      } else {
        message.warning('请选择日期范围')
        setLoading(false)
        return
      }
      
      // 根据视图模式调用不同的API
      if (viewMode === 'summary') {
        const response = await api.get('/api/platform-data/summary', { params })
        setSummaryData(response.data)
        setDetailData([])
        if (response.data) {
          message.success('查询成功')
        } else {
          message.info('未找到数据')
        }
      } else {
        const response = await api.get('/api/platform-data/detail', { params })
        const data = response.data || []
        setDetailData(data)
        setSummaryData(null)
        if (data.length > 0) {
          message.success(`找到 ${data.length} 条记录`)
        } else {
          message.info('未找到数据')
        }
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '查询失败')
      setDetailData([])
      setSummaryData(null)
    } finally {
      setLoading(false)
    }
  }

  const handleViewModeChange = async (e) => {
    const newMode = e.target.value
    setViewMode(newMode)
    // 切换模式时重新查询
    const values = form.getFieldsValue()
    if (values.dateRange && values.dateRange.length === 2) {
      // 使用新的模式重新查询
      await handleSearch(values)
    }
  }

  const handleRejectionClick = (date, platform, merchant) => {
    // 跳转到拒付详情页
    const values = form.getFieldsValue()
    const beginDate = values.dateRange[0].format('YYYY-MM-DD')
    const endDate = values.dateRange[1].format('YYYY-MM-DD')
    
    // 使用URL参数传递筛选条件
    const params = new URLSearchParams({
      start_date: beginDate,
      end_date: endDate
    })
    
    if (platform) {
      params.append('platform', platform)
    }
    
    // 跳转到拒付详情页
    navigate(`/rejections?${params.toString()}`)
  }

  // 明细模式表格列
  const detailColumns = [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      width: 120,
      sorter: (a, b) => dayjs(a.date).unix() - dayjs(b.date).unix(),
      render: (date) => dayjs(date).format('YYYY-MM-DD'),
    },
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 120,
      filters: [...new Set(detailData.map(d => d.platform))].map(name => ({
        text: name,
        value: name,
      })),
      onFilter: (value, record) => record.platform === value,
      render: (val) => <Tag color="blue">{val}</Tag>
    },
    {
      title: '商户',
      dataIndex: 'merchant',
      key: 'merchant',
      width: 150,
      render: (val) => val || '-'
    },
    {
      title: '订单数',
      dataIndex: 'total_orders',
      key: 'total_orders',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.total_orders - b.total_orders,
      render: (val) => (val || 0).toLocaleString()
    },
    {
      title: '交易金额(GMV)',
      dataIndex: 'gmv',
      key: 'gmv',
      width: 150,
      align: 'right',
      sorter: (a, b) => a.gmv - b.gmv,
      render: (val) => `$${(val || 0).toFixed(2)}`
    },
    {
      title: '已确认佣金',
      dataIndex: 'approved_commission',
      key: 'approved_commission',
      width: 150,
      align: 'right',
      sorter: (a, b) => a.approved_commission - b.approved_commission,
      render: (val) => `$${(val || 0).toFixed(2)}`
    },
    {
      title: '拒付佣金',
      dataIndex: 'rejected_commission',
      key: 'rejected_commission',
      width: 150,
      align: 'right',
      sorter: (a, b) => a.rejected_commission - b.rejected_commission,
      render: (val, record) => {
        const amount = val || 0
        if (amount > 0) {
          return (
            <Space>
              <span style={{ color: '#ff4d4f' }}>${amount.toFixed(2)}</span>
              <Button
                type="link"
                size="small"
                icon={<EyeOutlined />}
                onClick={() => handleRejectionClick(record.date, record.platform, record.merchant)}
              >
                查看详情
              </Button>
            </Space>
          )
        }
        return <span>${amount.toFixed(2)}</span>
      }
    },
    {
      title: '拒付率',
      dataIndex: 'rejected_rate',
      key: 'rejected_rate',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.rejected_rate - b.rejected_rate,
      render: (val) => (
        <span style={{ color: val > 0 ? '#ff4d4f' : '#666' }}>
          {(val || 0).toFixed(2)}%
        </span>
      )
    },
    {
      title: '净佣金',
      dataIndex: 'net_commission',
      key: 'net_commission',
      width: 150,
      align: 'right',
      sorter: (a, b) => a.net_commission - b.net_commission,
      render: (val) => (
        <span style={{ color: val >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 'bold' }}>
          ${(val || 0).toFixed(2)}
        </span>
      )
    }
  ]

  // 汇总模式表格列
  const summaryColumns = [
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 120,
      render: (val) => <Tag color="blue">{val}</Tag>
    },
    {
      title: '订单数',
      dataIndex: 'orders',
      key: 'orders',
      width: 100,
      align: 'right',
      render: (val) => (val || 0).toLocaleString()
    },
    {
      title: '交易金额(GMV)',
      dataIndex: 'gmv',
      key: 'gmv',
      width: 150,
      align: 'right',
      render: (val) => `$${(val || 0).toFixed(2)}`
    },
    {
      title: '已确认佣金',
      dataIndex: 'approved_commission',
      key: 'approved_commission',
      width: 150,
      align: 'right',
      render: (val) => `$${(val || 0).toFixed(2)}`
    },
    {
      title: '拒付佣金',
      dataIndex: 'rejected_commission',
      key: 'rejected_commission',
      width: 150,
      align: 'right',
      render: (val) => {
        const amount = val || 0
        if (amount > 0) {
          return (
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => handleRejectionClick(null, null, null)}
            >
              <span style={{ color: '#ff4d4f' }}>${amount.toFixed(2)}</span>
            </Button>
          )
        }
        return <span>${amount.toFixed(2)}</span>
      }
    },
    {
      title: '拒付率',
      dataIndex: 'rejected_rate',
      key: 'rejected_rate',
      width: 100,
      align: 'right',
      render: (val) => (
        <span style={{ color: val > 0 ? '#ff4d4f' : '#666' }}>
          {(val || 0).toFixed(2)}%
        </span>
      )
    },
    {
      title: '净佣金',
      dataIndex: 'net_commission',
      key: 'net_commission',
      width: 150,
      align: 'right',
      render: (val) => (
        <span style={{ color: val >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 'bold' }}>
          ${(val || 0).toFixed(2)}
        </span>
      )
    }
  ]

  // 计算汇总数据（明细模式）
  const totalCommission = detailData.reduce((sum, item) => sum + (item.approved_commission || 0), 0)
  const totalRejectedCommission = detailData.reduce((sum, item) => sum + (item.rejected_commission || 0), 0)
  const totalOrders = detailData.reduce((sum, item) => sum + (item.total_orders || 0), 0)
  const totalGmv = detailData.reduce((sum, item) => sum + (item.gmv || 0), 0)
  const totalNetCommission = totalCommission - totalRejectedCommission
  const totalRejectedRate = totalCommission + totalRejectedCommission > 0 
    ? (totalRejectedCommission / (totalCommission + totalRejectedCommission) * 100) 
    : 0

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>平台每日数据（8平台统一）</h2>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={handleSearch}
        >
          <Form.Item label="视图模式" style={{ marginBottom: 16 }}>
            <Radio.Group value={viewMode} onChange={handleViewModeChange} buttonStyle="solid">
              <Radio.Button value="detail">明细模式</Radio.Button>
              <Radio.Button value="summary">汇总模式</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            name="platform"
            label="平台"
            style={{ marginBottom: 16 }}
          >
            <Select
              placeholder="选择平台"
              style={{ width: 150 }}
              allowClear
            >
              {platforms.map(platform => (
                <Select.Option key={platform.id} value={platform.platform_code}>
                  {platform.platform_name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="merchant"
            label="商户"
            style={{ marginBottom: 16 }}
          >
            <Input
              placeholder="输入商户名称（支持模糊匹配）"
              style={{ width: 200 }}
              allowClear
            />
          </Form.Item>

          <Form.Item
            name="dateRange"
            label="日期范围"
            rules={[{ required: true, message: '请选择日期范围' }]}
            style={{ marginBottom: 16 }}
          >
            <RangePicker
              format="YYYY-MM-DD"
              disabledDate={(current) => current && current > dayjs().endOf('day')}
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SearchOutlined />}
              loading={loading}
            >
              查询
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {/* 汇总模式显示 */}
      {viewMode === 'summary' && summaryData && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{summaryData.date_range_label}</h3>
            </div>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="总订单数"
                  value={summaryData.total_orders}
                  valueStyle={{ color: '#1890ff' }}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="总交易金额(GMV)"
                  value={summaryData.total_gmv}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#1890ff' }}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="已确认佣金"
                  value={summaryData.total_approved_commission}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#52c41a' }}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="拒付佣金"
                  value={summaryData.total_rejected_commission}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#ff4d4f' }}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="拒付率"
                  value={summaryData.total_rejected_rate}
                  suffix="%"
                  precision={2}
                  valueStyle={{ color: summaryData.total_rejected_rate > 0 ? '#ff4d4f' : '#666' }}
                />
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Statistic
                  title="净佣金"
                  value={summaryData.total_net_commission}
                  prefix="$"
                  precision={2}
                  valueStyle={{ 
                    color: summaryData.total_net_commission >= 0 ? '#52c41a' : '#ff4d4f',
                    fontWeight: 'bold'
                  }}
                />
              </Col>
            </Row>
          </Card>

          <Card>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>按平台分组</h3>
            </div>
            <Table
              columns={summaryColumns}
              dataSource={summaryData.platform_breakdown || []}
              loading={loading}
              rowKey="platform"
              pagination={false}
            />
          </Card>
        </>
      )}

      {/* 明细模式显示 */}
      {viewMode === 'detail' && (
        <>
          {detailData.length > 0 && (
            <Card style={{ marginBottom: 16 }}>
              <Space size="large">
                <div>
                  <span style={{ color: '#666' }}>总订单数：</span>
                  <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
                    {totalOrders.toLocaleString()}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#666' }}>总交易金额(GMV)：</span>
                  <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
                    ${totalGmv.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#666' }}>已确认佣金：</span>
                  <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#52c41a' }}>
                    ${totalCommission.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#666' }}>拒付佣金：</span>
                  <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#ff4d4f' }}>
                    ${totalRejectedCommission.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#666' }}>拒付率：</span>
                  <span style={{ fontSize: '18px', fontWeight: 'bold', color: totalRejectedRate > 0 ? '#ff4d4f' : '#666' }}>
                    {totalRejectedRate.toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span style={{ color: '#666' }}>净佣金：</span>
                  <span style={{ fontSize: '18px', fontWeight: 'bold', color: totalNetCommission >= 0 ? '#52c41a' : '#ff4d4f' }}>
                    ${totalNetCommission.toFixed(2)}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#666' }}>记录数：</span>
                  <span style={{ fontSize: '18px', fontWeight: 'bold' }}>
                    {detailData.length}
                  </span>
                </div>
              </Space>
            </Card>
          )}

          <Card>
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>明细数据（按日期+平台+商户）</h3>
              <Input.Search
                placeholder="搜索平台或商户"
                style={{ width: 300 }}
                onSearch={(value) => setSearchText(value)}
                allowClear
              />
            </div>
            <Table
              columns={detailColumns}
              dataSource={detailData.filter(item => 
                !searchText || 
                item.platform?.toLowerCase().includes(searchText.toLowerCase()) ||
                item.merchant?.toLowerCase().includes(searchText.toLowerCase())
              )}
              loading={loading}
              rowKey={(record) => `${record.date}-${record.platform}-${record.merchant || 'null'}`}
              pagination={{
                pageSize: 20,
                showSizeChanger: true,
                showTotal: (total) => `共 ${total} 条记录`,
              }}
              scroll={{ x: 1200 }}
              locale={{
                emptyText: '请选择筛选条件并点击查询'
              }}
            />
          </Card>
        </>
      )}
    </div>
  )
}
