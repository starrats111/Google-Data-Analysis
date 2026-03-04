import React, { useEffect, useMemo, useState, useCallback, useRef, lazy, Suspense } from 'react'
import { Card, Row, Col, Table, message, Segmented, Tag, Typography, Space, Statistic, Input, Button, Spin, Select } from 'antd'
import { SearchOutlined, RocketOutlined, CalendarOutlined, GlobalOutlined, SyncOutlined, ClockCircleOutlined, ShopOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/authStore'
import api from '../services/api'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

// 懒加载ECharts组件，减少初始加载时间
const ReactECharts = lazy(() => import('echarts-for-react'))

// 启用时区插件
dayjs.extend(utc)
dayjs.extend(timezone)
// 设置默认时区为中国时区
dayjs.tz.setDefault('Asia/Shanghai')

const Dashboard = () => {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [overviewData, setOverviewData] = useState(null)
  const [employeeData, setEmployeeData] = useState([])
  const [trendData, setTrendData] = useState([])
  const [loading, setLoading] = useState(false)
  const [insightRange, setInsightRange] = useState('本月')
  const [insights, setInsights] = useState(null)
  
  // 节日日历状态
  const [calendarCountry, setCalendarCountry] = useState('US')
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarData, setCalendarData] = useState(null)
  
  // 商家待完成状态
  const [myAssignments, setMyAssignments] = useState([])
  const [myAssignmentsLoading, setMyAssignmentsLoading] = useState(false)
  
  // 刷新状态
  const [lastUpdated, setLastUpdated] = useState(null)
  const loadingRef = useRef(false)

  const fetchManagerData = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const [overviewRes, employeesRes, trendRes] = await Promise.all([
        api.get('/api/dashboard/overview'),
        api.get('/api/dashboard/employees'),
        api.get('/api/dashboard/trend'),
      ])
      setOverviewData(overviewRes.data)
      setEmployeeData(employeesRes.data)
      setTrendData(trendRes.data?.trend || [])
    } catch (error) {
      message.error('获取数据失败')
    } finally {
      setLoading(false)
      loadingRef.current = false
      setLastUpdated(dayjs())
    }
  }, [])

  const fetchEmployeeData = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setLoading(true)
    try {
      const insightRes = await api.get('/api/dashboard/employee-insights', { params: { range: insightRange === '过去15天' ? '15d' : insightRange === '本月' ? 'month' : '7d' } })
      setOverviewData(null)
      setInsights(insightRes.data)
    } catch (error) {
      message.error('获取数据失败')
    } finally {
      setLoading(false)
      loadingRef.current = false
      setLastUpdated(dayjs())
    }
  }, [insightRange])

  const fetchMyAssignments = useCallback(async () => {
    setMyAssignmentsLoading(true)
    try {
      const res = await api.get('/api/merchant-assignments', { params: { status: 'active', page: 1, page_size: 10 } })
      setMyAssignments(res.data?.items || [])
    } catch (_) {
      setMyAssignments([])
    } finally {
      setMyAssignmentsLoading(false)
    }
  }, [])

  const doRefresh = useCallback(() => {
    if (user?.role === 'manager') {
      fetchManagerData()
    } else {
      fetchEmployeeData()
    }
  }, [user?.role, fetchManagerData, fetchEmployeeData])

  useEffect(() => {
    let cancelled = false
    const doFetch = async () => {
      if (!cancelled) {
        doRefresh()
        fetchMyAssignments()
      }
    }
    doFetch()
    return () => { cancelled = true }
  }, [doRefresh, fetchMyAssignments])

  // 经理视角的费用佣金走向图配置
  const managerTrendOption = useMemo(() => ({
    tooltip: { 
      trigger: 'axis',
      formatter: (params) => {
        let result = `${params[0].axisValue}<br/>`
        params.forEach(p => {
          result += `${p.marker} ${p.seriesName}: ${Number(p.value || 0).toFixed(2)}<br/>`
        })
        return result
      }
    },
    legend: { data: ['费用', '佣金'], top: 0 },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: trendData.map(t => t.date) },
    yAxis: { type: 'value' },
    series: [
      { 
        name: '费用', 
        type: 'line', 
        data: trendData.map(t => t.cost), 
        smooth: true,
        lineStyle: { color: '#cf1322', width: 2 },
        itemStyle: { color: '#cf1322' },
        areaStyle: { color: 'rgba(207, 19, 34, 0.1)' }
      },
      { 
        name: '佣金', 
        type: 'line', 
        data: trendData.map(t => t.commission), 
        smooth: true,
        lineStyle: { color: '#3f8600', width: 2 },
        itemStyle: { color: '#3f8600' },
        areaStyle: { color: 'rgba(63, 134, 0, 0.1)' }
      }
    ],
  }), [trendData])

  const trend = insights?.trend || []
  
  const employeeTrendOption = useMemo(() => ({
    tooltip: { 
      trigger: 'axis',
      formatter: (params) => {
        let result = `${params[0].axisValue}<br/>`
        params.forEach(p => {
          result += `${p.marker} ${p.seriesName}: ${Number(p.value || 0).toFixed(2)}<br/>`
        })
        return result
      }
    },
    legend: { data: ['费用', '佣金'], top: 0 },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: trend.map(t => t.date) },
    yAxis: { type: 'value' },
    series: [
      { 
        name: '费用', 
        type: 'line', 
        data: trend.map(t => Number(t.cost || 0)), 
        smooth: true,
        lineStyle: { color: '#cf1322', width: 2 },
        itemStyle: { color: '#cf1322' },
        areaStyle: { color: 'rgba(207, 19, 34, 0.1)' }
      },
      { 
        name: '佣金', 
        type: 'line', 
        data: trend.map(t => Number(t.commission || 0)), 
        smooth: true,
        lineStyle: { color: '#3f8600', width: 2 },
        itemStyle: { color: '#3f8600' },
        areaStyle: { color: 'rgba(63, 134, 0, 0.1)' }
      }
    ],
  }), [trend])

  if (user?.role === 'manager') {
    const columns = [
      { title: '员工编号', dataIndex: 'employee_id', key: 'employee_id', width: 80, sorter: (a, b) => (a.employee_id || 0) - (b.employee_id || 0) },
      { title: '用户名', dataIndex: 'username', key: 'username', width: 80 },
      { title: 'MCC数', dataIndex: 'mcc_count', key: 'mcc_count', align: 'right', width: 70, sorter: (a, b) => (a.mcc_count || 0) - (b.mcc_count || 0) },
      { title: '本月费用', dataIndex: 'cost_month', key: 'cost_month', align: 'right', width: 100, sorter: (a, b) => (a.cost_month || 0) - (b.cost_month || 0), render: (v) => <span style={{ color: '#cf1322' }}>{Number(v || 0).toFixed(2)}</span> },
      { title: '本月佣金', dataIndex: 'commission_month', key: 'commission_month', align: 'right', width: 100, sorter: (a, b) => (a.commission_month || 0) - (b.commission_month || 0), render: (v) => <span style={{ color: '#3f8600' }}>{Number(v || 0).toFixed(2)}</span> },
      { title: '本月订单', dataIndex: 'orders_month', key: 'orders_month', align: 'right', width: 80, sorter: (a, b) => (a.orders_month || 0) - (b.orders_month || 0) },
      { title: '最后同步', dataIndex: 'last_google_sync_at', key: 'last_google_sync_at', width: 140, sorter: (a, b) => new Date(a.last_google_sync_at || 0) - new Date(b.last_google_sync_at || 0), render: (v) => v ? dayjs.utc(v).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm') : '-' },
    ]

    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>数据总览</h2>
          <Space>
            <Button onClick={doRefresh} loading={loading} icon={<SyncOutlined spin={loading} />} size="small">刷新</Button>
            {lastUpdated && (
              <span style={{ color: '#999', fontSize: 12 }}>
                <ClockCircleOutlined style={{ marginRight: 4 }} />
                {lastUpdated.format('HH:mm:ss')}
              </span>
            )}
          </Space>
        </div>
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic title="总员工数" value={overviewData?.total_employees || 0} />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic 
                title="本月广告费用" 
                value={overviewData?.cost_month || 0} 
                precision={2}
                valueStyle={{ color: '#cf1322' }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic 
                title="本月总佣金" 
                value={overviewData?.commission_month || 0} 
                precision={2}
                valueStyle={{ color: '#3f8600' }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic 
                title="本月ROI" 
                value={overviewData?.roi_month || 0} 
                precision={2}
                suffix="%"
                valueStyle={{ color: (overviewData?.roi_month || 0) >= 0 ? '#3f8600' : '#cf1322' }}
              />
            </Card>
          </Col>
        </Row>

        <Card title="本月费用佣金走向" style={{ marginBottom: 16 }}>
          <Suspense fallback={<div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>}>
            <ReactECharts option={managerTrendOption} style={{ height: 300 }} lazyUpdate={true} notMerge={true} />
          </Suspense>
        </Card>

        <Card title="员工数据总览">
          <Table
            columns={columns}
            dataSource={employeeData}
            loading={loading}
            rowKey="employee_id"
          />
        </Card>
      </div>
    )
  }

  const { Text, Paragraph } = Typography

  // 获取节日日历
  const fetchCalendar = async () => {
    if (!calendarCountry) {
      message.warning('请输入国家代码')
      return
    }
    setCalendarLoading(true)
    try {
      const res = await api.get(`/api/gemini/marketing-calendar/${calendarCountry.toUpperCase()}`)
      if (res.data.success) {
        setCalendarData(res.data)
      } else {
        message.error(res.data.message || '获取日历失败')
      }
    } catch (error) {
      message.error('获取日历失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setCalendarLoading(false)
    }
  }

  // 国家选项
  const countryOptions = [
    { value: 'US', label: '🇺🇸 美国 (US)' },
    { value: 'UK', label: '🇬🇧 英国 (UK)' },
    { value: 'DE', label: '🇩🇪 德国 (DE)' },
    { value: 'FR', label: '🇫🇷 法国 (FR)' },
    { value: 'ES', label: '🇪🇸 西班牙 (ES)' },
    { value: 'IT', label: '🇮🇹 意大利 (IT)' },
    { value: 'AU', label: '🇦🇺 澳大利亚 (AU)' },
    { value: 'CA', label: '🇨🇦 加拿大 (CA)' },
    { value: 'JP', label: '🇯🇵 日本 (JP)' },
    { value: 'KR', label: '🇰🇷 韩国 (KR)' },
  ]

  return (
    <div>
      <h2>我的数据总览</h2>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space wrap>
            <Text>欢迎，<b>{user?.username}</b></Text>
            <Tag color="blue">{user?.role === 'manager' ? '经理' : '员工'}</Tag>
          </Space>
          <Space>
            <Button onClick={doRefresh} loading={loading} icon={<SyncOutlined spin={loading} />} size="small">刷新</Button>
            {lastUpdated && (
              <span style={{ color: '#999', fontSize: 12 }}>
                <ClockCircleOutlined style={{ marginRight: 4 }} />
                {lastUpdated.format('HH:mm:ss')}
              </span>
            )}
          </Space>
        </div>
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">区间选择：</Text>
          <Segmented
            style={{ marginLeft: 8 }}
            options={['过去7天', '过去15天', '本月']}
            value={insightRange}
            onChange={(v) => setInsightRange(v)}
          />
        </div>
      </Card>

      <Card title="费用佣金走向" style={{ marginBottom: 16 }}>
        <Suspense fallback={<div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>}>
          <ReactECharts option={employeeTrendOption} style={{ height: 300 }} lazyUpdate={true} notMerge={true} />
        </Suspense>
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card bordered={false}>
            <Statistic title="区间总佣金" value={insights?.summary?.total_commission || 0} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card bordered={false}>
            <Statistic title="区间总费用" value={insights?.summary?.total_cost || 0} precision={2} />
          </Card>
        </Col>
        <Col span={8}>
          <Card bordered={false}>
            <Statistic title="区间ROI" value={insights?.summary?.roi ?? 0} precision={4} />
          </Card>
        </Col>
      </Row>

      <Row gutter={16}>
        <Col span={12}>
          <Card 
            title={<span><CalendarOutlined style={{ marginRight: 8 }} />营销节日日历</span>}
            extra={
              <Space>
                <Select
                  value={calendarCountry}
                  onChange={setCalendarCountry}
                  options={countryOptions}
                  style={{ width: 150 }}
                  placeholder="选择国家"
                />
                <Button 
                  type="primary" 
                  icon={<SearchOutlined />} 
                  onClick={fetchCalendar}
                  loading={calendarLoading}
                >
                  查询
                </Button>
              </Space>
            }
          >
            <Spin spinning={calendarLoading}>
              {calendarData ? (
                <div style={{ maxHeight: 420, overflow: 'auto' }}>
                  {calendarData.holidays && calendarData.holidays.length > 0 ? (
                    <div>
                      <div style={{ marginBottom: 12 }}>
                        <Text type="secondary">📅 {calendarData.country_name} · 未来节日（{calendarData.holidays.length}个）</Text>
                      </div>
                      {calendarData.holidays.map((holiday, idx) => (
                        <div key={idx} style={{ 
                          padding: 12, 
                          marginBottom: 12, 
                          background: '#fafafa', 
                          borderRadius: 8,
                          borderLeft: '4px solid #4DA6FF'
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                            <div>
                              <Text strong style={{ fontSize: 15 }}>{holiday.name_cn}</Text>
                              <Text type="secondary" style={{ marginLeft: 8 }}>({holiday.name_en})</Text>
                            </div>
                            <Tag color="blue">{holiday.date}</Tag>
                          </div>
                          <div style={{ marginBottom: 6 }}>
                            <Text type="warning">{holiday.importance}</Text>
                            <Text style={{ marginLeft: 8 }}>{holiday.meaning}</Text>
                          </div>
                          <div style={{ marginBottom: 6 }}>
                            <Text type="secondary">适用品类：</Text>
                            {holiday.categories?.map((cat, i) => (
                              <Tag key={i} style={{ marginBottom: 4 }}>{cat}</Tag>
                            ))}
                          </div>
                          {holiday.brands && holiday.brands.length > 0 && (
                            <div style={{ marginBottom: 6 }}>
                              <Text type="secondary">适用品牌：</Text>
                              {holiday.brands.map((brand, i) => (
                                <Tag key={i} color="green" style={{ marginBottom: 4 }}>{brand}</Tag>
                              ))}
                            </div>
                          )}
                          <div style={{ background: '#EBF5FF', padding: '6px 10px', borderRadius: 4, marginTop: 6 }}>
                            <Text style={{ fontSize: 12 }}>💡 {holiday.tips}</Text>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : calendarData.calendar ? (
                    // 备用：如果JSON解析失败，显示原始文本
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }}>
                      {calendarData.calendar}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                      <Text>暂无未来节日数据</Text>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                  <GlobalOutlined style={{ fontSize: 48, marginBottom: 16 }} />
                  <p>选择国家并点击查询，获取该国家的营销节日日历</p>
                  <p style={{ fontSize: 12 }}>支持：US, UK, DE, FR, ES, IT, AU, CA, JP, KR</p>
                </div>
              )}
            </Spin>
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title={<span><ShopOutlined style={{ marginRight: 8 }} />商家待完成</span>}
            extra={
              <Button type="link" onClick={() => navigate('/merchant-management')}>
                查看全部
              </Button>
            }
          >
            <Spin spinning={myAssignmentsLoading}>
              {myAssignments.length > 0 ? (
                <div style={{ maxHeight: 460, overflow: 'auto' }}>
                  {myAssignments.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 12px',
                        marginBottom: 8,
                        background: '#fafafa',
                        borderRadius: 8,
                        border: '1px solid #f0f0f0',
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                          {item.merchant?.merchant_name || '-'}
                        </div>
                        <Space size={8}>
                          <Tag color="blue">{item.merchant?.platform || '-'}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            MID: {item.merchant?.merchant_id || '待补'}
                          </Text>
                          <Tag color={item.priority === 'high' ? 'red' : item.priority === 'low' ? 'default' : 'blue'}>
                            {item.priority || 'normal'}
                          </Tag>
                        </Space>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {item.monthly_target ? (
                          <div style={{ fontSize: 13, color: '#389e0d', fontWeight: 600 }}>
                            ${Number(item.monthly_target).toFixed(0)}
                          </div>
                        ) : null}
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {item.assigned_at ? new Date(item.assigned_at).toLocaleDateString('zh-CN') : ''}
                        </Text>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                  <ShopOutlined style={{ fontSize: 48, marginBottom: 16 }} />
                  <p>暂无分配的商家任务</p>
                  <p style={{ fontSize: 12 }}>经理分配商家后将在此显示</p>
                </div>
              )}
            </Spin>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default Dashboard













