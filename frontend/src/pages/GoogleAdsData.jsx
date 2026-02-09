import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Card, Button, Form, Select, DatePicker, message, Space, Radio, Row, Col, Table, Input, Statistic } from 'antd'
import { SearchOutlined, DownloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker

export default function GoogleAdsData() {
  const { user } = useAuth()
  
  const [loading, setLoading] = useState(false)
  const [summaryData, setSummaryData] = useState(null) // 聚合数据
  const [campaignData, setCampaignData] = useState([]) // 按广告系列分组的数据
  const [detailData, setDetailData] = useState([]) // 详细数据
  const [mccAccounts, setMccAccounts] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [form] = Form.useForm()
  const [dateRangeType, setDateRangeType] = useState('past7days') // 时间范围类型
  const [searchText, setSearchText] = useState('')
  // 按需求：仅按广告系列视图（移除视图模式切换）

  useEffect(() => {
    fetchMccAccounts()
    fetchPlatforms()
    // 默认查询过去7天
    handleDateRangeChange('past7days')
  }, [])

  // 处理时间范围类型变化
  const handleDateRangeChange = (type) => {
    setDateRangeType(type)
    let beginDate, endDate
    
    const today = dayjs()
    switch(type) {
      case 'today':
        beginDate = today
        endDate = today
        break
      case 'yesterday':
        beginDate = today.subtract(1, 'day')
        endDate = today.subtract(1, 'day')
        break
      case 'past7days':
        beginDate = today.subtract(7, 'day')
        endDate = today
        break
      case 'thisWeek':
        beginDate = today.startOf('week')
        endDate = today
        break
      case 'thisMonth':
        beginDate = today.startOf('month')
        endDate = today
        break
      case 'custom':
        // 自定义时不清空日期选择器
        return
      default:
        beginDate = today.subtract(7, 'day')
        endDate = today
    }
    
    form.setFieldsValue({
      dateRange: [beginDate, endDate]
    })
    
    // 自动触发查询（除了自定义）
    if (type !== 'custom') {
      // 延迟一下确保表单值已更新
      setTimeout(() => {
        form.submit()
      }, 100)
    }
  }

  const fetchMccAccounts = async () => {
    try {
      const response = await api.get('/api/mcc/accounts')
      setMccAccounts(response.data)
    } catch (error) {
      console.error('获取MCC账号列表失败', error)
    }
  }

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms')
      setPlatforms(response.data)
    } catch (error) {
      console.error('获取平台列表失败', error)
    }
  }

  // 使用ref存储请求取消函数，防止重复请求
  const abortControllerRef = useRef(null)
  
  const handleSearch = useCallback(async (values) => {
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    // 防止重复请求
    if (loading) return
    
    // 创建新的AbortController
    abortControllerRef.current = new AbortController()
    
    setLoading(true)
    try {
      const params = {
        date_range_type: dateRangeType
      }
      
      if (values.mcc_id) {
        params.mcc_id = values.mcc_id
      }
      
      if (values.platform_code) {
        params.platform_code = values.platform_code
      }
      
      // 如果是自定义日期范围，需要提供begin_date和end_date
      if (dateRangeType === 'custom') {
        if (values.dateRange && values.dateRange.length === 2) {
          params.begin_date = values.dateRange[0].format('YYYY-MM-DD')
          params.end_date = values.dateRange[1].format('YYYY-MM-DD')
        } else {
          message.warning('请选择日期范围')
          setLoading(false)
          return
        }
      }
      
      if (values.status) {
        params.status = values.status
      }

      if (values.merchant_id) {
        params.merchant_id = String(values.merchant_id).trim()
      }

      // 固定：按广告系列分组的数据
      const campaignResponse = await api.get('/api/google-ads-aggregate/by-campaign', { 
        params,
        signal: abortControllerRef.current.signal
      })
      const campaigns = campaignResponse.data.campaigns || []
      // 广告优先展示已启用(ENABLED)，其次暂停(PAUSED)，最后未知/其它
      const statusRank = (s) => {
        const v = (s || '').toUpperCase()
        if (v === 'ENABLED') return 0
        if (v === 'PAUSED') return 1
        if (v === 'REMOVED') return 3
        return 2
      }
      campaigns.sort((a, b) => {
        const ra = statusRank(a.status_code || a.status)
        const rb = statusRank(b.status_code || b.status)
        if (ra !== rb) return ra - rb
        // 同状态下按花费降序
        return (Number(b.cost || 0) - Number(a.cost || 0))
      })
      setCampaignData(campaigns)
      setSummaryData(null)
      setDetailData([])
      
      if (campaigns.length > 0) {
        message.success(`查询成功：找到 ${campaigns.length} 个广告系列`)
      } else {
        message.info('未找到数据')
      }
    } catch (error) {
      // 忽略取消的请求
      if (error.isCanceled || error.name === 'CanceledError' || error.name === 'AbortError') {
        return
      }
      if (import.meta.env.DEV) {
        console.error('查询失败:', error)
      }
      message.error(error.response?.data?.detail || '查询失败')
      setSummaryData(null)
      setCampaignData([])
      setDetailData([])
    } finally {
      setLoading(false)
      abortControllerRef.current = null
    }
  }, [dateRangeType, loading])


  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>Google Ads数据</h2>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSearch}
        >
          <Row gutter={16}>
            <Col span={24} style={{ marginBottom: 16 }}>
              <Form.Item label="时间范围">
                <Radio.Group 
                  value={dateRangeType} 
                  onChange={(e) => handleDateRangeChange(e.target.value)}
                  buttonStyle="solid"
                >
                  <Radio.Button value="today">今天</Radio.Button>
                  <Radio.Button value="yesterday">昨天</Radio.Button>
                  <Radio.Button value="past7days">过去七天</Radio.Button>
                  <Radio.Button value="thisWeek">本周</Radio.Button>
                  <Radio.Button value="thisMonth">本月</Radio.Button>
                  <Radio.Button value="custom">自定义</Radio.Button>
                </Radio.Group>
              </Form.Item>
            </Col>

            {dateRangeType === 'custom' && (
              <Col span={24} style={{ marginBottom: 16 }}>
                <Form.Item
                  name="dateRange"
                  label="选择日期范围"
                  rules={[{ required: true, message: '请选择日期范围' }]}
                >
                  <RangePicker
                    format="YYYY-MM-DD"
                    style={{ width: '100%' }}
                    disabledDate={(current) => current && current > dayjs().endOf('day')}
                  />
                </Form.Item>
              </Col>
            )}

            <Col span={12}>
              <Form.Item
                name="mcc_id"
                label="MCC账号（可选）"
              >
                <Select
                  placeholder="选择MCC账号"
                  allowClear
                >
                  {mccAccounts.map(mcc => (
                    <Select.Option key={mcc.id} value={mcc.id}>
                      {mcc.mcc_name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item
                name="platform_code"
                label="平台（可选）"
              >
                <Select
                  placeholder="选择平台"
                  allowClear
                >
                  {platforms.map(platform => (
                    <Select.Option key={platform.id} value={platform.platform_code}>
                      {platform.platform_name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item name="status" label="状态" initialValue="ENABLED">
                <Select placeholder="选择状态">
                  <Select.Option value="ENABLED">已启用</Select.Option>
                  <Select.Option value="PAUSED">已暂停</Select.Option>
                  <Select.Option value="REMOVED">已移除</Select.Option>
                  <Select.Option value="UNKNOWN">未知</Select.Option>
                  <Select.Option value="ALL">全部</Select.Option>
                </Select>
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item name="merchant_id" label="商家ID（可选）">
                <Input placeholder="例如：240088（广告系列名最后一段）" allowClear />
              </Form.Item>
            </Col>

            <Col span={24}>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<SearchOutlined />}
                  loading={loading}
                  size="large"
                  block
                >
                  查询
                </Button>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* 按广告系列分组的数据 */}
      {campaignData.length > 0 && (
        <>
          {/* 汇总统计 */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{campaignData[0]?.date_range || ''}</h3>
            </div>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={8}>
                <Statistic
                  title="总展示"
                  value={campaignData.reduce((sum, item) => sum + (item.impressions || 0), 0)}
                  valueStyle={{ color: '#1890ff' }}
                />
              </Col>
              <Col xs={12} sm={8} md={8}>
                <Statistic
                  title="总点击"
                  value={campaignData.reduce((sum, item) => sum + (item.clicks || 0), 0)}
                  valueStyle={{ color: '#1890ff' }}
                />
              </Col>
              <Col xs={12} sm={8} md={8}>
                <Statistic
                  title="总费用"
                  value={campaignData.reduce((sum, item) => sum + (item.cost || 0), 0)}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#1890ff' }}
                />
              </Col>
            </Row>
          </Card>

          <Card style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #e8e8e8' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 500 }}>
                广告系列数据
              </h3>
              <div style={{ fontSize: '12px', color: '#999', marginTop: '4px' }}>
                {campaignData[0]?.date_range || ''}
              </div>
            </div>
            
            <Table
            dataSource={campaignData}
            pagination={{ 
              pageSize: 50,
              showSizeChanger: true,
              showQuickJumper: true,
              showTotal: (total) => `共 ${total} 条`,
              defaultPageSize: 50,
              pageSizeOptions: ['20', '50', '100', '200'],
            }}
            rowKey="campaign_id"
            scroll={{ x: 1200, y: 600 }}
            virtual={campaignData.length > 200}
            columns={[
              {
                title: '状态',
                dataIndex: 'status',
                key: 'status',
                width: 120,
                fixed: 'left',
                render: (status) => {
                  const statusColors = {
                    '已启用': '#52c41a',
                    '已暂停': '#faad14',
                    '已移除': '#ff4d4f',
                    '未知': '#999'
                  }
                  return <span style={{ color: statusColors[status] || '#999' }}>{status || '未知'}</span>
                }
              },
              {
                title: '平台',
                dataIndex: 'platform_name',
                key: 'platform_name',
                width: 100,
                fixed: 'left',
                render: (text) => text || '-'
              },
              {
                title: '商家ID',
                dataIndex: 'merchant_id',
                key: 'merchant_id',
                width: 120,
                render: (v) => v || '-'
              },
              {
                title: '广告系列',
                dataIndex: 'campaign_name',
                key: 'campaign_name',
                width: 200,
                fixed: 'left',
                render: (text) => <strong>{text}</strong>
              },
              {
                title: '预算',
                dataIndex: 'budget',
                key: 'budget',
                width: 120,
                align: 'right',
                render: (val) => `$${(val || 0).toFixed(2)}`
              },
              {
                title: '费用',
                dataIndex: 'cost',
                key: 'cost',
                width: 120,
                align: 'right',
                render: (val) => `$${(val || 0).toFixed(2)}`
              },
              {
                title: '展示次数',
                dataIndex: 'impressions',
                key: 'impressions',
                width: 120,
                align: 'right',
                render: (val) => (val || 0).toLocaleString()
              },
              {
                title: '点击次数',
                dataIndex: 'clicks',
                key: 'clicks',
                width: 120,
                align: 'right',
                render: (val) => (val || 0).toLocaleString()
              },
              {
                title: 'CPC',
                dataIndex: 'cpc',
                key: 'cpc',
                width: 100,
                align: 'right',
                render: (val) => `$${(val || 0).toFixed(4)}`
              },
              {
                title: 'CTR',
                dataIndex: 'ctr',
                key: 'ctr',
                width: 100,
                align: 'right',
                render: (val) => `${(val || 0).toFixed(2)}%`
              },
              {
                title: 'IS Budget丢失',
                dataIndex: 'is_budget_lost',
                key: 'is_budget_lost',
                width: 130,
                align: 'right',
                render: (val) => `${(val || 0).toFixed(2)}%`
              },
              {
                title: 'IS Rank丢失',
                dataIndex: 'is_rank_lost',
                key: 'is_rank_lost',
                width: 130,
                align: 'right',
                render: (val) => `${(val || 0).toFixed(2)}%`
              }
            ]}
          />
        </Card>
        </>
      )}

      {/* 时间范围级别汇总（一行）- 完全对齐Google Ads */}
      {false && summaryData && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #e8e8e8' }}>
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 500 }}>
              {summaryData.date_range_label || '汇总数据'}
            </h3>
            <div style={{ fontSize: '12px', color: '#999', marginTop: '4px' }}>
              {summaryData.begin_date} ~ {summaryData.end_date}
            </div>
          </div>
          
          {/* 一行汇总表格 - 和Google Ads一样 */}
          <Table
            dataSource={[summaryData]}
            pagination={false}
            rowKey="date_range_type"
            columns={[
              {
                title: '时间范围',
                dataIndex: 'date_range_label',
                key: 'date_range_label',
                width: 150,
                render: (text) => <strong>{text}</strong>
              },
              {
                title: 'Google Ads成本',
                dataIndex: 'google_ads_cost',
                key: 'google_ads_cost',
                width: 150,
                align: 'right',
                render: (val) => `$${(val || 0).toFixed(2)}`
              },
              {
                title: '佣金（已确认）',
                dataIndex: 'affiliate_commission',
                key: 'affiliate_commission',
                width: 150,
                align: 'right',
                render: (val) => `$${(val || 0).toFixed(2)}`
              },
              {
                title: '拒付佣金',
                dataIndex: 'affiliate_rejected_commission',
                key: 'affiliate_rejected_commission',
                width: 150,
                align: 'right',
                render: (val) => (
                  <span style={{ color: val > 0 ? '#ff4d4f' : '#666' }}>
                    ${(val || 0).toFixed(2)}
                  </span>
                )
              },
              {
                title: '净佣金',
                dataIndex: 'net_commission',
                key: 'net_commission',
                width: 150,
                align: 'right',
                render: (val) => `$${(val || 0).toFixed(2)}`
              },
              {
                title: 'ROI',
                dataIndex: 'roi',
                key: 'roi',
                width: 120,
                align: 'right',
                render: (val) => (
                  <span style={{ 
                    color: val > 0 ? '#52c41a' : val < 0 ? '#ff4d4f' : '#666',
                    fontWeight: 'bold'
                  }}>
                    {val ? `${val.toFixed(2)}%` : '0.00%'}
                  </span>
                )
              },
              {
                title: '订单数',
                dataIndex: 'affiliate_orders',
                key: 'affiliate_orders',
                width: 120,
                align: 'right',
                render: (val) => (val || 0).toLocaleString()
              },
              {
                title: '点击次数',
                dataIndex: 'google_ads_clicks',
                key: 'google_ads_clicks',
                width: 120,
                align: 'right',
                render: (val) => (val || 0).toLocaleString()
              },
              {
                title: '展示次数',
                dataIndex: 'google_ads_impressions',
                key: 'google_ads_impressions',
                width: 120,
                align: 'right',
                render: (val) => (val || 0).toLocaleString()
              },
              {
                title: '平均CPC',
                dataIndex: 'google_ads_cpc',
                key: 'google_ads_cpc',
                width: 120,
                align: 'right',
                render: (val) => `$${(val || 0).toFixed(4)}`
              }
            ]}
          />
          
          <div style={{ marginTop: 16, padding: '12px', backgroundColor: '#f5f5f5', borderRadius: '4px', fontSize: '12px', color: '#666' }}>
            <strong>说明：</strong>此数据完全对齐Google Ads的统计口径，使用时间范围级别的聚合结果（不是逐日加总），确保与Google Ads UI完全一致。
          </div>
        </Card>
      )}

      {/* 不再显示每日明细 - 如需日级分析，请使用明细页 */}

      {!summaryData && !campaignData.length && !loading && (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            请选择时间范围并点击查询
          </div>
        </Card>
      )}
    </div>
  )
}


