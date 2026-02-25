import React, { useState, useEffect, useRef } from 'react'
import { Card, Table, DatePicker, Select, Tabs, Space, Statistic, Row, Col, message, Skeleton, Tag, Input, Modal, Spin, Button } from 'antd'
import { SearchOutlined, DollarOutlined, ReloadOutlined } from '@ant-design/icons'
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

const parseCampaignSeq = (name) => {
  const parts = (name || '').split('-')
  return parseInt(parts[0]) || 0
}

const parseCampaignDate = (name) => {
  const parts = (name || '').split('-')
  const datePart = parts[4] || '0000'
  return parseInt(datePart) || 0
}

// D5+U4 修复：IS Budget/Rank 格式化函数，>90% 时显示 ">90%"，并用颜色突出显示
const formatIsLost = (value) => {
  if (value === null || value === undefined) return '-'
  if (value === 0) return '-'
  if (value > 0.9) return '>90%'
  return `${(value * 100).toFixed(1)}%`
}

// U4: IS 丢失数据带颜色渲染（严重红色、警告橙色、正常绿色）
const renderIsLost = (value) => {
  if (value === null || value === undefined || value === 0) {
    return <span style={{ color: '#999' }}>-</span>
  }
  
  let color = '#52c41a' // 绿色：低丢失
  let bg = '#f6ffed'
  let text = `${(value * 100).toFixed(1)}%`
  
  if (value > 0.9) {
    color = '#f5222d' // 红色：严重丢失
    bg = '#fff1f0'
    text = '>90%'
  } else if (value > 0.5) {
    color = '#fa8c16' // 橙色：中等丢失
    bg = '#fff7e6'
  } else if (value > 0.2) {
    color = '#faad14' // 黄色：轻微丢失
    bg = '#fffbe6'
  }
  
  return (
    <span style={{ 
      color, 
      backgroundColor: bg, 
      padding: '2px 6px', 
      borderRadius: 4, 
      fontWeight: value > 0.5 ? 'bold' : 'normal',
      fontSize: 12
    }}>
      {text}
    </span>
  )
}

const DataCenter = () => {
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  
  const [activeTab, setActiveTab] = useState('google')
  const [loading, setLoading] = useState(false)
  const [googleData, setGoogleData] = useState([])
  const [platformData, setPlatformData] = useState([])
  const [platformSummary, setPlatformSummary] = useState([])
  const [accountBreakdown, setAccountBreakdown] = useState([])  // 账号聚合数据（用于筛选器）
  const [viewMode, setViewMode] = useState('summary') // summary | detail
  
  // 日期默认为本月
  const monthStart = dayjs().startOf('month')
  const monthEnd = dayjs().endOf('month')
  const [dateRange, setDateRange] = useState([monthStart, monthEnd])
  
  // 筛选
  const [statusFilter, setStatusFilter] = useState('ENABLED')
  const [searchText, setSearchText] = useState('')
  const [campaignSortMode, setCampaignSortMode] = useState('seq')

  // MCC费用明细Modal
  const [mccModalVisible, setMccModalVisible] = useState(false)
  const [mccCostData, setMccCostData] = useState([])
  const [mccCostLoading, setMccCostLoading] = useState(false)
  
  // 分页状态
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: 20,
  })
  
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
            date_range_type: 'custom',
            begin_date: params.start_date,
            end_date: params.end_date,
            status: params.status,  // 后端支持 ALL 参数，直接传递
          },
          signal: abortControllerRef.current.signal,
        })
        // API 返回的是对象 {campaigns: [...], begin_date, end_date, ...}，取 campaigns 数组
        const responseData = response.data
        const data = Array.isArray(responseData?.campaigns) ? responseData.campaigns : []
        setGoogleData(data)
        dataCache.google = { data, timestamp: Date.now(), params: cacheKey }
      } else {
        if (viewMode === 'summary') {
          const response = await api.get('/api/platform-data/summary', {
            params: {
              begin_date: params.start_date,
              end_date: params.end_date,
            },
            signal: abortControllerRef.current.signal,
          })
          // API 返回的是对象 {merchant_breakdown: [...], platform_breakdown: [...], account_breakdown: [...], total_xxx...}
          const responseData = response.data
          // 优先使用 merchant_breakdown（按商家聚合），否则用 platform_breakdown
          const data = Array.isArray(responseData?.merchant_breakdown) 
            ? responseData.merchant_breakdown 
            : (Array.isArray(responseData?.platform_breakdown) ? responseData.platform_breakdown : [])
          setPlatformSummary(data)
          // 保存账号聚合数据（用于筛选器）
          setAccountBreakdown(Array.isArray(responseData?.account_breakdown) ? responseData.account_breakdown : [])
          dataCache.platform = { data, timestamp: Date.now(), params: cacheKey }
        } else {
          // 明细模式：获取每条交易记录
          const response = await api.get('/api/platform-data/transactions', {
            params: {
              begin_date: params.start_date,
              end_date: params.end_date,
              page: 1,
              page_size: 200,  // 获取更多记录
            },
            signal: abortControllerRef.current.signal,
          })
          // API 返回 {total, page, page_size, pages, transactions: [...]}
          const data = Array.isArray(response.data?.transactions) ? response.data.transactions : []
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

  // 禁用明天及以后的日期（允许选择今天）
  const disabledDate = (current) => {
    return current && current > dayjs().endOf('day')
  }

  // 从 accountBreakdown 生成账号筛选器选项
  const accountFilters = React.useMemo(() => {
    if (!accountBreakdown || accountBreakdown.length === 0) {
      return []
    }
    // 去重并排序
    const labels = [...new Set(accountBreakdown.map(item => item.account_label))].sort()
    return labels.map(label => ({ text: label, value: label }))
  }, [accountBreakdown])

  // 获取MCC费用明细
  const fetchMccCostDetail = async () => {
    setMccCostLoading(true)
    setMccModalVisible(true)
    try {
      const response = await api.get('/api/expenses/mcc-cost-detail', {
        params: {
          begin_date: dateRange[0].format('YYYY-MM-DD'),
          end_date: dateRange[1].format('YYYY-MM-DD'),
        }
      })
      setMccCostData(response.data?.mcc_details || [])
    } catch (error) {
      console.error('获取MCC费用明细失败:', error)
      message.error('获取MCC费用明细失败')
    } finally {
      setMccCostLoading(false)
    }
  }

  // Google Ads 表格列
  const googleColumns = [
    {
      title: (
        <Space size={4}>
          <span>广告系列</span>
          <Select
            size="small"
            value={campaignSortMode}
            onChange={setCampaignSortMode}
            style={{ width: 80 }}
            options={[
              { value: 'seq', label: '按序号' },
              { value: 'date', label: '按日期' },
            ]}
            onClick={(e) => e.stopPropagation()}
          />
        </Space>
      ),
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      fixed: 'left',
      width: 280,
      sorter: (a, b) => {
        if (campaignSortMode === 'date') {
          return parseCampaignDate(a.campaign_name) - parseCampaignDate(b.campaign_name)
        }
        return parseCampaignSeq(a.campaign_name) - parseCampaignSeq(b.campaign_name)
      },
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
      render: (status) => {
        // 后端返回的可能是中文"已启用"/"已暂停"或英文"ENABLED"/"PAUSED"
        const isEnabled = status === 'ENABLED' || status === '已启用'
        const isPaused = status === 'PAUSED' || status === '已暂停'
        return (
          <Tag color={isEnabled ? 'green' : isPaused ? 'orange' : 'red'}>
            {isEnabled ? '已启用' : isPaused ? '已暂停' : status}
          </Tag>
        )
      },
    },
    {
      title: '费用($)',
      dataIndex: 'cost',
      key: 'cost',
      width: 100,
      sorter: (a, b) => (a.cost || 0) - (b.cost || 0),
      render: (val, record) => {
        const color = record.currency === 'CNY' ? '#cf1322' : '#3f8600'
        return <span style={{ color, fontWeight: 500 }}>${(val || 0).toFixed(2)}</span>
      },
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
      render: (val, record) => {
        const color = record.currency === 'CNY' ? '#cf1322' : '#3f8600'
        return <span style={{ color }}>${(val || 0).toFixed(2)}</span>
      },
    },
    {
      title: '预算($)',
      dataIndex: 'budget',
      key: 'budget',
      width: 100,
      render: (val, record) => {
        if (!val) return '-'
        const color = record.currency === 'CNY' ? '#cf1322' : '#3f8600'
        return <span style={{ color }}>${val.toFixed(2)}</span>
      },
    },
    {
      title: 'IS Budget丢失',
      dataIndex: 'is_budget_lost',
      key: 'is_budget_lost',
      width: 120,
      render: (val) => renderIsLost(val),
    },
    {
      title: 'IS Rank丢失',
      dataIndex: 'is_rank_lost',
      key: 'is_rank_lost',
      width: 120,
      render: (val) => renderIsLost(val),
    },
  ]

  // 平台数据汇总列（匹配后端 merchant_breakdown 格式）
  const platformSummaryColumns = [
    {
      title: '账号',
      dataIndex: 'account_label',
      key: 'account_label',
      width: 80,
      filters: accountFilters,
      onFilter: (value, record) => record.account_label === value,
      render: (val, record) => {
        // 平台代码映射颜色
        const platformColors = {
          'cg': '#4DA6FF', 'rw': '#fa8c16', 'lh': '#52c41a', 'pm': '#eb2f96',
          'lb': '#722ed1', 'pb': '#f5222d', 'bsh': '#a0d911', 'cf': '#13c2c2',
        }
        const key = record.platform?.toLowerCase()
        const color = platformColors[key] || '#666'
        return <Tag color={color}>{val || record.platform?.toUpperCase() || '-'}</Tag>
      },
    },
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 80,
      render: (val) => {
        // 平台代码映射（支持新旧两种格式：小写缩写和全称）
        const platformColors = {
          // 新格式（小写缩写）- 数据库统一存储格式
          'cg': { bg: '#EBF5FF', color: '#4DA6FF', name: 'CG' },       // CollabGlow
          'rw': { bg: '#fff7e6', color: '#fa8c16', name: 'RW' },       // Rewardoo
          'lh': { bg: '#f6ffed', color: '#52c41a', name: 'LH' },       // LinkHaitao
          'pm': { bg: '#fff0f6', color: '#eb2f96', name: 'PM' },       // Partnermatic
          'lb': { bg: '#f9f0ff', color: '#722ed1', name: 'LB' },       // Linkbux
          'pb': { bg: '#fff1f0', color: '#f5222d', name: 'PB' },       // PartnerBoost
          'bsh': { bg: '#fcffe6', color: '#a0d911', name: 'BSH' },     // BrandSparkHub
          'cf': { bg: '#e6fffb', color: '#13c2c2', name: 'CF' },       // CreatorFlare
          // 旧格式（全称）- 兼容历史数据
          'linkhaitao': { bg: '#f6ffed', color: '#52c41a', name: 'LH' },
          'partnermatic': { bg: '#fff0f6', color: '#eb2f96', name: 'PM' },
          'linkbux': { bg: '#f9f0ff', color: '#722ed1', name: 'LB' },
          'partnerboost': { bg: '#fff1f0', color: '#f5222d', name: 'PB' },
          'brandsparkhub': { bg: '#fcffe6', color: '#a0d911', name: 'BSH' },
          'creatorflare': { bg: '#e6fffb', color: '#13c2c2', name: 'CF' },
        }
        const key = val?.toLowerCase()
        const style = platformColors[key] || { bg: '#f5f5f5', color: '#666', name: val?.toUpperCase() || '-' }
        return (
          <Tag style={{ backgroundColor: style.bg, color: style.color, border: `1px solid ${style.color}` }}>
            {style.name}
          </Tag>
        )
      },
    },
    {
      title: '商家ID',
      dataIndex: 'mid',
      key: 'mid',
      width: 100,
    },
    {
      title: '商家',
      dataIndex: 'merchant',
      key: 'merchant',
      width: 150,
      ellipsis: true,
    },
    {
      title: '总佣金($)',
      dataIndex: 'total_commission',
      key: 'total_commission',
      width: 120,
      sorter: (a, b) => (a.total_commission || 0) - (b.total_commission || 0),
      render: (val) => <span style={{ color: '#3f8600' }}>${(val || 0).toFixed(2)}</span>,
    },
    {
      title: '订单数',
      dataIndex: 'orders',
      key: 'orders',
      width: 80,
      sorter: (a, b) => (a.orders || 0) - (b.orders || 0),
    },
    {
      title: '拒付佣金($)',
      dataIndex: 'rejected_commission',
      key: 'rejected_commission',
      width: 110,
      sorter: (a, b) => (a.rejected_commission || 0) - (b.rejected_commission || 0),
      render: (val) => {
        const amount = val || 0
        if (amount > 0) {
          return <span style={{ color: '#cf1322', fontWeight: 'bold' }}>${amount.toFixed(2)}</span>
        }
        return <span style={{ color: '#999' }}>$0.00</span>
      },
    },
    {
      title: '净佣金($)',
      key: 'net_commission',
      width: 110,
      render: (_, record) => {
        const net = (record.total_commission || 0) - (record.rejected_commission || 0)
        return <span style={{ fontWeight: 'bold' }}>${net.toFixed(2)}</span>
      },
    },
  ]

  // 平台数据明细列（每条交易记录）
  const platformDetailColumns = [
    {
      title: '交易时间',
      dataIndex: 'transaction_time',
      key: 'transaction_time',
      width: 160,
      sorter: (a, b) => new Date(a.transaction_time) - new Date(b.transaction_time),
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 80,
      render: (val) => {
        // 平台代码映射（支持新旧两种格式：小写缩写和全称）
        const platformColors = {
          // 新格式（小写缩写）- 数据库统一存储格式
          'cg': { bg: '#EBF5FF', color: '#4DA6FF', name: 'CG' },       // CollabGlow
          'rw': { bg: '#fff7e6', color: '#fa8c16', name: 'RW' },       // Rewardoo
          'lh': { bg: '#f6ffed', color: '#52c41a', name: 'LH' },       // LinkHaitao
          'pm': { bg: '#fff0f6', color: '#eb2f96', name: 'PM' },       // Partnermatic
          'lb': { bg: '#f9f0ff', color: '#722ed1', name: 'LB' },       // Linkbux
          'pb': { bg: '#fff1f0', color: '#f5222d', name: 'PB' },       // PartnerBoost
          'bsh': { bg: '#fcffe6', color: '#a0d911', name: 'BSH' },     // BrandSparkHub
          'cf': { bg: '#e6fffb', color: '#13c2c2', name: 'CF' },       // CreatorFlare
          // 旧格式（全称）- 兼容历史数据
          'linkhaitao': { bg: '#f6ffed', color: '#52c41a', name: 'LH' },
          'partnermatic': { bg: '#fff0f6', color: '#eb2f96', name: 'PM' },
          'linkbux': { bg: '#f9f0ff', color: '#722ed1', name: 'LB' },
          'partnerboost': { bg: '#fff1f0', color: '#f5222d', name: 'PB' },
          'brandsparkhub': { bg: '#fcffe6', color: '#a0d911', name: 'BSH' },
          'creatorflare': { bg: '#e6fffb', color: '#13c2c2', name: 'CF' },
        }
        const key = val?.toLowerCase()
        const style = platformColors[key] || { bg: '#f5f5f5', color: '#666', name: val?.toUpperCase() || '-' }
        return (
          <Tag style={{ backgroundColor: style.bg, color: style.color, border: `1px solid ${style.color}` }}>
            {style.name}
          </Tag>
        )
      },
    },
    {
      title: '商家',
      dataIndex: 'merchant',
      key: 'merchant',
      width: 150,
      ellipsis: true,
    },
    {
      title: '交易ID',
      dataIndex: 'transaction_id',
      key: 'transaction_id',
      width: 150,
      ellipsis: true,
    },
    {
      title: '订单金额($)',
      dataIndex: 'order_amount',
      key: 'order_amount',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.order_amount || 0) - (b.order_amount || 0),
      render: (val) => `$${(val || 0).toFixed(2)}`,
    },
    {
      title: '佣金($)',
      dataIndex: 'commission_amount',
      key: 'commission_amount',
      width: 100,
      align: 'right',
      sorter: (a, b) => (a.commission_amount || 0) - (b.commission_amount || 0),
      render: (val) => <span style={{ color: '#3f8600' }}>${(val || 0).toFixed(2)}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (val) => {
        const statusMap = {
          'pending': { color: 'processing', text: '审核中' },
          'approved': { color: 'success', text: '已确认' },
          'rejected': { color: 'error', text: '已拒付' },
        }
        const s = statusMap[val?.toLowerCase()] || { color: 'default', text: val }
        return <Tag color={s.color}>{s.text}</Tag>
      },
    },
  ]

  // 计算汇总统计（确保数据是数组）
  const safeGoogleData = Array.isArray(googleData) ? googleData : []
  const safePlatformData = Array.isArray(viewMode === 'summary' ? platformSummary : platformData) 
    ? (viewMode === 'summary' ? platformSummary : platformData) 
    : []
  
  const googleStats = {
    totalCost: safeGoogleData.reduce((sum, item) => sum + (item.cost || 0), 0),
    totalClicks: safeGoogleData.reduce((sum, item) => sum + (item.clicks || 0), 0),
    totalImpressions: safeGoogleData.reduce((sum, item) => sum + (item.impressions || 0), 0),
    campaignCount: safeGoogleData.length,
  }

  // 根据视图模式使用不同的字段名
  const platformStats = viewMode === 'summary' 
    ? {
        totalCommission: safePlatformData.reduce((sum, item) => sum + (item.total_commission || 0), 0),
        totalOrders: safePlatformData.reduce((sum, item) => sum + (item.orders || 0), 0),
        totalRejected: safePlatformData.reduce((sum, item) => sum + (item.rejected_commission || 0), 0),
      }
    : {
        // 明细模式：使用 commission_amount 字段，按状态计算
        totalCommission: safePlatformData.reduce((sum, item) => sum + (item.commission_amount || 0), 0),
        totalOrders: safePlatformData.length,
        totalRejected: safePlatformData
          .filter(item => item.status === 'rejected')
          .reduce((sum, item) => sum + (item.commission_amount || 0), 0),
      }

  // 计算 ROI (佣金/费用)
  const roi = googleStats.totalCost > 0 
    ? (platformStats.totalCommission / googleStats.totalCost).toFixed(2) 
    : '0.00'

  // 同步状态
  const [syncing, setSyncing] = useState(false)
  
  // 实时同步（从API获取最新数据）
  const handleRefresh = async () => {
    setSyncing(true)
    message.loading({ content: '正在启动数据同步...', key: 'sync', duration: 0 })
    
    try {
      // 根据当前tab调用对应的同步API
      if (activeTab === 'google') {
        const response = await api.post('/api/google-ads-aggregate/sync-realtime')
        if (response.data.background) {
          message.success({ 
            content: `Google Ads 同步已在后台开始，正在同步 ${response.data.total_mccs} 个MCC，请稍后刷新页面`, 
            key: 'sync',
            duration: 5
          })
        } else {
          message.success({ 
            content: `Google Ads同步完成: ${response.data.synced_mccs}/${response.data.total_mccs} 个MCC`, 
            key: 'sync' 
          })
        }
      } else {
        const response = await api.post('/api/platform-data/sync-realtime')
        if (response.data.background) {
          message.success({ 
            content: `平台数据同步已在后台开始，正在同步 ${response.data.total_accounts} 个账号，请稍后刷新页面`, 
            key: 'sync',
            duration: 5
          })
        } else {
          message.success({ 
            content: `平台数据同步完成: ${response.data.synced_accounts}/${response.data.total_accounts} 个账号`, 
            key: 'sync' 
          })
        }
      }
      
      // 清除缓存
      dataCache.google = { data: null, timestamp: 0, params: null }
      dataCache.platform = { data: null, timestamp: 0, params: null }
      // 重新获取数据
      await fetchData()
      
    } catch (error) {
      console.error('同步失败:', error)
      message.error({ content: `同步失败: ${error.response?.data?.detail || error.message}`, key: 'sync' })
    } finally {
      setSyncing(false)
    }
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
              <Card 
                size="small" 
                hoverable 
                onClick={fetchMccCostDetail}
                style={{ cursor: 'pointer' }}
              >
                <Statistic
                  title={
                    <Space>
                      <span>总费用</span>
                      <DollarOutlined style={{ color: '#4DA6FF', fontSize: 12 }} />
                    </Space>
                  }
                  value={googleStats.totalCost}
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: '#cf1322' }}
                />
                <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>点击查看MCC明细</div>
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
              rowKey={(record) => record.campaign_id}
              scroll={{ x: 1200 }}
              pagination={{
                current: pagination.current,
                pageSize: pagination.pageSize,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50', '100'],
                showTotal: (total) => `共 ${total} 条`,
                onChange: (page, pageSize) => {
                  setPagination({ current: page, pageSize })
                },
                onShowSizeChange: (current, size) => {
                  setPagination({ current: 1, pageSize: size })
                },
              }}
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
            <Col xs={12} sm={4}>
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
            <Col xs={12} sm={4}>
              <Card size="small">
                <Statistic 
                  title="拒付佣金" 
                  value={platformStats.totalRejected} 
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: platformStats.totalRejected > 0 ? '#cf1322' : '#999' }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={4}>
              <Card size="small">
                <Statistic 
                  title="净佣金" 
                  value={platformStats.totalCommission - platformStats.totalRejected} 
                  precision={2}
                  prefix="$"
                  valueStyle={{ color: '#4DA6FF', fontWeight: 'bold' }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={4}>
              <Card size="small">
                <Statistic title="总订单" value={platformStats.totalOrders} />
              </Card>
            </Col>
            <Col xs={12} sm={4}>
              <Card size="small">
                <Statistic 
                  title="ROI (佣金/费用)" 
                  value={roi} 
                  valueStyle={{ color: parseFloat(roi) >= 1 ? '#3f8600' : '#cf1322' }}
                />
              </Card>
            </Col>
            <Col xs={12} sm={4}>
              <Card size="small">
                <Space>
                  <span>视图：</span>
                  <Select
                    value={viewMode}
                    onChange={setViewMode}
                    style={{ width: 80 }}
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
              pagination={{
                current: pagination.current,
                pageSize: pagination.pageSize,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50', '100'],
                showTotal: (total) => `共 ${total} 条`,
                onChange: (page, pageSize) => {
                  setPagination({ current: page, pageSize })
                },
                onShowSizeChange: (current, size) => {
                  setPagination({ current: 1, pageSize: size })
                },
              }}
              size="small"
            />
          )}
        </div>
      ),
    },
  ]

  // MCC费用明细表格列
  const mccCostColumns = [
    {
      title: 'MCC账号',
      dataIndex: 'mcc_name',
      key: 'mcc_name',
      width: 200,
    },
    {
      title: 'MCC ID',
      dataIndex: 'mcc_id',
      key: 'mcc_id',
      width: 150,
    },
    {
      title: '货币',
      dataIndex: 'currency',
      key: 'currency',
      width: 80,
      render: (val) => <Tag>{val || 'USD'}</Tag>,
    },
    {
      title: '费用(原币)',
      dataIndex: 'cost_original',
      key: 'cost_original',
      width: 120,
      align: 'right',
      render: (val, record) => {
        const symbol = record.currency === 'CNY' ? '¥' : '$'
        return `${symbol}${(val || 0).toFixed(2)}`
      },
    },
    {
      title: '费用(USD)',
      dataIndex: 'cost_usd',
      key: 'cost_usd',
      width: 120,
      align: 'right',
      render: (val) => <span style={{ color: '#cf1322', fontWeight: 'bold' }}>${(val || 0).toFixed(2)}</span>,
    },
  ]

  return (
    <div>
      <Card
        title="数据中心"
        extra={
          <Space wrap>
            <Button
              type="primary"
              icon={<ReloadOutlined spin={syncing} />}
              onClick={handleRefresh}
              loading={syncing}
            >
              {syncing ? '同步中...' : '同步最新数据'}
            </Button>
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

      {/* MCC费用明细Modal */}
      <Modal
        title={`MCC费用明细 (${dateRange[0]?.format('YYYY-MM-DD')} ~ ${dateRange[1]?.format('YYYY-MM-DD')})`}
        open={mccModalVisible}
        onCancel={() => setMccModalVisible(false)}
        footer={null}
        width={800}
      >
        <Spin spinning={mccCostLoading}>
          <Table
            columns={mccCostColumns}
            dataSource={mccCostData}
            rowKey={(record) => record.mcc_id}
            pagination={false}
            size="small"
            summary={(pageData) => {
              const totalUsd = pageData.reduce((sum, item) => sum + (item.cost_usd || 0), 0)
              return (
                <Table.Summary fixed>
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={4}><strong>总计</strong></Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">
                      <strong style={{ color: '#cf1322' }}>${totalUsd.toFixed(2)}</strong>
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                </Table.Summary>
              )
            }}
          />
        </Spin>
      </Modal>
    </div>
  )
}

export default DataCenter

