import React, { useState, useEffect, useRef } from 'react'
import { Card, Table, DatePicker, Select, Tabs, Space, Statistic, Row, Col, message, Skeleton, Tag, Input } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker
const { Option } = Select

// 数据缓存（5分钟有效）
const dataCache = {
  google: { data: null, timestamp: 0, params: null },
  platform: { data: null, timestamp: 0, params: null },
}
const CACHE_DURATION = 5 * 60 * 1000 // 5分钟

const DataCenter = () => {
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  
  const [activeTab, setActiveTab] = useState('google')
  const [loading, setLoading] = useState(false)
  const [googleData, setGoogleData] = useState([])
  const [platformData, setPlatformData] = useState([])
  const [platformSummary, setPlatformSummary] = useState([])
  const [viewMode, setViewMode] = useState('summary') // summary | detail
  
  // 日期默认为过去7天（到昨天）
  const yesterday = dayjs().subtract(1, 'day')
  const defaultStartDate = yesterday.subtract(6, 'day')
  const [dateRange, setDateRange] = useState([defaultStartDate, yesterday])
  
  // 筛选
  const [statusFilter, setStatusFilter] = useState('ENABLED')
  const [searchText, setSearchText] = useState('')
  
  // 请求取消
  const abortControllerRef = useRef(null)

  useEffect(() => {
    fetchData()
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [activeTab, dateRange, statusFilter, viewMode])

  const getCacheKey = (tab, params) => {
    return JSON.stringify({ tab, ...params })
  }

  const fetchData = async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    const params = {
      start_date: dateRange[0].format('YYYY-MM-DD'),
      end_date: dateRange[1].format('YYYY-MM-DD'),
      status: statusFilter,
      viewMode,
    }

    // 检查缓存
    const cacheKey = getCacheKey(activeTab, params)
    const cache = dataCache[activeTab]
    if (cache.data && cache.params === cacheKey && Date.now() - cache.timestamp < CACHE_DURATION) {
      if (activeTab === 'google') {
        setGoogleData(cache.data)
      } else {
        if (viewMode === 'summary') {
          setPlatformSummary(cache.data)
        } else {
          setPlatformData(cache.data)
        }
      }
      return
    }

    setLoading(true)
    try {
      if (activeTab === 'google') {
        const response = await api.get('/api/google-ads-aggregate/by-campaign', {
          params: {
            start_date: params.start_date,
            end_date: params.end_date,
            status: params.status === 'ALL' ? undefined : params.status,
          },
          signal: abortControllerRef.current.signal,
        })
        const data = response.data || []
        setGoogleData(data)
        dataCache.google = { data, timestamp: Date.now(), params: cacheKey }
      } else {
        if (viewMode === 'summary') {
          const response = await api.get('/api/platform-data/summary', {
            params: {
              start_date: params.start_date,
              end_date: params.end_date,
            },
            signal: abortControllerRef.current.signal,
          })
          const data = response.data || []
          setPlatformSummary(data)
          dataCache.platform = { data, timestamp: Date.now(), params: cacheKey }
        } else {
          const response = await api.get('/api/platform-data', {
            params: {
              start_date: params.start_date,
              end_date: params.end_date,
            },
            signal: abortControllerRef.current.signal,
          })
          const data = response.data || []
          setPlatformData(data)
          dataCache.platform = { data, timestamp: Date.now(), params: cacheKey }
        }
      }
    } catch (error) {
      if (error.name !== 'CanceledError' && error.name !== 'AbortError' && !error.isCanceled) {
        console.error('获取数据失败:', error)
        message.error('获取数据失败')
      }
    } finally {
      setLoading(false)
    }
  }

  // 禁用今天及以后的日期
  const disabledDate = (current) => {
    return current && current >= dayjs().startOf('day')
  }

  // Google Ads 表格列
  const googleColumns = [
    {
      title: '广告系列',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      fixed: 'left',
      width: 250,
      filteredValue: searchText ? [searchText] : null,
      onFilter: (value, record) => {
        return record.campaign_name?.toLowerCase().includes(value.toLowerCase())
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (status) => (
        <Tag color={status === 'ENABLED' ? 'green' : status === 'PAUSED' ? 'orange' : 'red'}>
          {status === 'ENABLED' ? '启用' : status === 'PAUSED' ? '暂停' : status}
        </Tag>
      ),
    },
    {
      title: '费用($)',
      dataIndex: 'cost',
      key: 'cost',
      width: 100,
      sorter: (a, b) => (a.cost || 0) - (b.cost || 0),
      render: (val) => `$${(val || 0).toFixed(2)}`,
    },
    {
      title: '点击',
      dataIndex: 'clicks',
      key: 'clicks',
      width: 80,
      sorter: (a, b) => (a.clicks || 0) - (b.clicks || 0),
    },
    {
      title: '展示',
      dataIndex: 'impressions',
      key: 'impressions',
      width: 100,
      sorter: (a, b) => (a.impressions || 0) - (b.impressions || 0),
    },
    {
      title: 'CPC($)',
      dataIndex: 'cpc',
      key: 'cpc',
      width: 80,
      render: (val) => `$${(val || 0).toFixed(2)}`,
    },
    {
      title: '预算($)',
      dataIndex: 'budget',
      key: 'budget',
      width: 100,
      render: (val) => val ? `$${val.toFixed(2)}` : '-',
    },
    {
      title: 'IS Budget丢失',
      dataIndex: 'is_budget_lost',
      key: 'is_budget_lost',
      width: 120,
      render: (val) => val ? `${(val * 100).toFixed(1)}%` : '-',
    },
    {
      title: 'IS Rank丢失',
      dataIndex: 'is_rank_lost',
      key: 'is_rank_lost',
      width: 120,
      render: (val) => val ? `${(val * 100).toFixed(1)}%` : '-',
    },
  ]

  // 平台数据汇总列
  const platformSummaryColumns = [
    {
      title: '平台',
      dataIndex: 'platform_name',
      key: 'platform_name',
      width: 120,
    },
    {
      title: '账号',
      dataIndex: 'account_name',
      key: 'account_name',
      width: 150,
    },
    {
      title: '总佣金($)',
      dataIndex: 'total_commission',
      key: 'total_commission',
      width: 120,
      sorter: (a, b) => (a.total_commission || 0) - (b.total_commission || 0),
      render: (val) => `$${(val || 0).toFixed(2)}`,
    },
    {
      title: '总订单',
      dataIndex: 'total_orders',
      key: 'total_orders',
      width: 100,
      sorter: (a, b) => (a.total_orders || 0) - (b.total_orders || 0),
    },
    {
      title: '拒付佣金($)',
      dataIndex: 'rejected_commission',
      key: 'rejected_commission',
      width: 120,
      render: (val) => val ? `$${val.toFixed(2)}` : '-',
    },
    {
      title: '净佣金($)',
      key: 'net_commission',
      width: 120,
      render: (_, record) => {
        const net = (record.total_commission || 0) - (record.rejected_commission || 0)
        return `$${net.toFixed(2)}`
      },
    },
  ]

  // 平台数据明细列
  const platformDetailColumns = [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      width: 110,
      sorter: (a, b) => new Date(a.date) - new Date(b.date),
    },
    {
      title: '平台',
      dataIndex: 'platform_name',
      key: 'platform_name',
      width: 100,
    },
    {
      title: '商家ID',
      dataIndex: 'merchant_id',
      key: 'merchant_id',
      width: 100,
    },
    {
      title: '商家名称',
      dataIndex: 'merchant_name',
      key: 'merchant_name',
      width: 150,
    },
    {
      title: '佣金($)',
      dataIndex: 'commission',
      key: 'commission',
      width: 100,
      sorter: (a, b) => (a.commission || 0) - (b.commission || 0),
      render: (val) => `$${(val || 0).toFixed(2)}`,
    },
    {
      title: '订单数',
      dataIndex: 'orders',
      key: 'orders',
      width: 80,
    },
  ]

  // 计算汇总统计
  const googleStats = {
    totalCost: googleData.reduce((sum, item) => sum + (item.cost || 0), 0),
    totalClicks: googleData.reduce((sum, item) => sum + (item.clicks || 0), 0),
    totalImpressions: googleData.reduce((sum, item) => sum + (item.impressions || 0), 0),
    campaignCount: googleData.length,
  }

  const platformStats = {
    totalCommission: (viewMode === 'summary' ? platformSummary : platformData)
      .reduce((sum, item) => sum + (item.total_commission || item.commission || 0), 0),
    totalOrders: (viewMode === 'summary' ? platformSummary : platformData)
      .reduce((sum, item) => sum + (item.total_orders || item.orders || 0), 0),
  }

  const tabItems = [
    {
      key: 'google',
      label: '广告数据',
      children: (
        <div>
          {/* 统计卡片 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic
                  title="总费用"
                  value={googleStats.totalCost}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: '#cf1322' }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic title="总点击" value={googleStats.totalClicks} />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic title="总展示" value={googleStats.totalImpressions} />
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card size="small">
                <Statistic title="广告系列数" value={googleStats.campaignCount} />
              </Card>
            </Col>
          </Row>

          {/* 搜索和筛选 */}
          <Space wrap style={{ marginBottom: 16 }}>
            <Input
              placeholder="搜索广告系列"
              prefix={<SearchOutlined />}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ width: 200 }}
              allowClear
            />
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 120 }}
            >
              <Option value="ALL">全部状态</Option>
              <Option value="ENABLED">已启用</Option>
              <Option value="PAUSED">已暂停</Option>
            </Select>
          </Space>

          {/* 表格 */}
          {loading ? (
            <Skeleton active paragraph={{ rows: 10 }} />
          ) : (
            <Table
              columns={googleColumns}
              dataSource={googleData.filter(item => 
                !searchText || item.campaign_name?.toLowerCase().includes(searchText.toLowerCase())
              )}
              rowKey={(record) => `${record.campaign_id}-${record.date}`}
              scroll={{ x: 1200 }}
              pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
              size="small"
            />
          )}
        </div>
      ),
    },
    {
      key: 'platform',
      label: '平台数据',
      children: (
        <div>
          {/* 统计卡片 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={8}>
              <Card size="small">
                <Statistic
                  title="总佣金"
                  value={platformStats.totalCommission}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: '#3f8600' }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8}>
              <Card size="small">
                <Statistic title="总订单" value={platformStats.totalOrders} />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card size="small">
                <Space>
                  <span>视图模式：</span>
                  <Select
                    value={viewMode}
                    onChange={setViewMode}
                    style={{ width: 100 }}
                    size="small"
                  >
                    <Option value="summary">汇总</Option>
                    <Option value="detail">明细</Option>
                  </Select>
                </Space>
              </Card>
            </Col>
          </Row>

          {/* 表格 */}
          {loading ? (
            <Skeleton active paragraph={{ rows: 10 }} />
          ) : (
            <Table
              columns={viewMode === 'summary' ? platformSummaryColumns : platformDetailColumns}
              dataSource={viewMode === 'summary' ? platformSummary : platformData}
              rowKey={(record, index) => `${record.id || index}`}
              scroll={{ x: 800 }}
              pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
              size="small"
            />
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <Card
        title="数据中心"
        extra={
          <Space wrap>
            <RangePicker
              value={dateRange}
              onChange={setDateRange}
              disabledDate={disabledDate}
              allowClear={false}
              style={{ width: 240 }}
            />
          </Space>
        }
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
        />
      </Card>
    </div>
  )
}

export default DataCenter

