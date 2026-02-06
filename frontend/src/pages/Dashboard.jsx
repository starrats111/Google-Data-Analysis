import React, { useEffect, useMemo, useState } from 'react'
import { Card, Row, Col, Table, message, Segmented, Tag, Typography, Space, Statistic, Input, Button, Spin, Select } from 'antd'
import { SearchOutlined, RocketOutlined, CalendarOutlined, GlobalOutlined } from '@ant-design/icons'
import { useAuth } from '../store/authStore'
import api from '../services/api'
import ReactECharts from 'echarts-for-react'

const Dashboard = () => {
  const { user } = useAuth()
  const [overviewData, setOverviewData] = useState(null)
  const [employeeData, setEmployeeData] = useState([])
  const [loading, setLoading] = useState(false)
  const [insightRange, setInsightRange] = useState('过去7天')
  const [insights, setInsights] = useState(null)
  
  // 节日日历状态
  const [calendarCountry, setCalendarCountry] = useState('US')
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarData, setCalendarData] = useState(null)
  
  // 广告词生成状态
  const [keywords, setKeywords] = useState('')
  const [productUrl, setProductUrl] = useState('')
  const [adCopyLoading, setAdCopyLoading] = useState(false)
  const [adCopyData, setAdCopyData] = useState(null)
  const [targetCountry, setTargetCountry] = useState('US')

  useEffect(() => {
    // 防止重复请求
    if (loading) return
    
    let cancelled = false
    
    const doFetch = async () => {
      if (!cancelled) {
        if (user?.role === 'manager') {
          await fetchManagerData()
        } else {
          await fetchEmployeeData()
        }
      }
    }
    
    doFetch()
    
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role, insightRange])

  const fetchManagerData = async () => {
    setLoading(true)
    try {
      const [overviewRes, employeesRes] = await Promise.all([
        api.get('/api/dashboard/overview'),
        api.get('/api/dashboard/employees'),
      ])
      setOverviewData(overviewRes.data)
      setEmployeeData(employeesRes.data)
    } catch (error) {
      message.error('获取数据失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchEmployeeData = async () => {
    setLoading(true)
    try {
      const insightRes = await api.get('/api/dashboard/employee-insights', { params: { range: insightRange === '过去15天' ? '15d' : insightRange === '本月' ? 'month' : '7d' } })
      setOverviewData(null)
      setInsights(insightRes.data)
    } catch (error) {
      message.error('获取数据失败')
    } finally {
      setLoading(false)
    }
  }

  if (user?.role === 'manager') {
    const columns = [
      { title: '员工编号', dataIndex: 'employee_id', key: 'employee_id' },
      { title: '用户名', dataIndex: 'username', key: 'username' },
      { title: 'MCC数', dataIndex: 'mcc_count', key: 'mcc_count', align: 'right' },
      { title: '近7天广告系列数', dataIndex: 'campaigns_7d', key: 'campaigns_7d', align: 'right' },
      { title: '近7天费用', dataIndex: 'cost_7d', key: 'cost_7d', align: 'right', render: (v) => Number(v || 0).toFixed(2) },
      { title: '近7天佣金', dataIndex: 'commission_7d', key: 'commission_7d', align: 'right', render: (v) => Number(v || 0).toFixed(2) },
      { title: '近7天订单', dataIndex: 'orders_7d', key: 'orders_7d', align: 'right' },
      { title: '最后同步时间', dataIndex: 'last_google_sync_at', key: 'last_google_sync_at' },
    ]

    return (
      <div>
        <h2>数据总览</h2>
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic title="总员工数" value={overviewData?.total_employees || 0} />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic title="活跃员工(近7天)" value={overviewData?.active_employees_7d || 0} />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic title="近7天广告费用" value={overviewData?.cost_7d || 0} precision={2} />
            </Card>
          </Col>
          <Col span={6}>
            <Card bordered={false}>
              <Statistic title="近7天总佣金" value={overviewData?.commission_7d || 0} precision={2} />
            </Card>
          </Col>
        </Row>

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

  // 生成广告词
  const generateAdCopy = async () => {
    if (!keywords.trim()) {
      message.warning('请输入关键词')
      return
    }
    setAdCopyLoading(true)
    try {
      const keywordList = keywords.split(/[,，\s]+/).filter(k => k.trim())
      const res = await api.post('/api/gemini/recommend-keywords', {
        keywords: keywordList,
        product_url: productUrl || null,
        target_country: targetCountry
      })
      if (res.data.success) {
        setAdCopyData(res.data)
      } else {
        message.error(res.data.message || '生成失败')
      }
    } catch (error) {
      message.error('生成失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setAdCopyLoading(false)
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

  const trend = insights?.trend || []
  const commissionOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: { type: 'category', data: trend.map(t => t.date) },
    yAxis: { type: 'value' },
    series: [{ type: 'line', data: trend.map(t => Number(t.commission || 0)), smooth: true, name: '佣金' }],
  }), [trend])

  const costOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    grid: { left: 40, right: 20, top: 20, bottom: 30 },
    xAxis: { type: 'category', data: trend.map(t => t.date) },
    yAxis: { type: 'value' },
    series: [{ type: 'line', data: trend.map(t => Number(t.cost || 0)), smooth: true, name: '费用' }],
  }), [trend])

  return (
    <div>
      <h2>我的数据总览</h2>

      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Text>欢迎，<b>{user?.username}</b></Text>
          <Tag color="blue">{user?.role === 'manager' ? '经理' : '员工'}</Tag>
        </Space>
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

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Card title="佣金走向">
            <ReactECharts option={commissionOption} style={{ height: 260 }} />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="费用走向">
            <ReactECharts option={costOption} style={{ height: 260 }} />
          </Card>
        </Col>
      </Row>

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
                <div style={{ maxHeight: 400, overflow: 'auto' }}>
                  <Paragraph>
                    <Text strong>📅 {calendarData.current_month} ~ {calendarData.next_month}</Text>
                  </Paragraph>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }}>
                    {calendarData.calendar}
                  </div>
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
            title={<span><RocketOutlined style={{ marginRight: 8 }} />AI 广告词生成</span>}
            extra={
              <Space>
                <Select
                  value={targetCountry}
                  onChange={setTargetCountry}
                  options={countryOptions}
                  style={{ width: 120 }}
                  placeholder="目标国家"
                />
                <Button 
                  type="primary" 
                  icon={<RocketOutlined />} 
                  onClick={generateAdCopy}
                  loading={adCopyLoading}
                >
                  生成
                </Button>
              </Space>
            }
          >
            <Spin spinning={adCopyLoading}>
              <Input
                placeholder="产品链接 URL（可选），例如：https://www.example.com"
                value={productUrl}
                onChange={(e) => setProductUrl(e.target.value)}
                style={{ marginBottom: 8 }}
                prefix={<GlobalOutlined />}
              />
              <Input.TextArea
                placeholder="输入关键词（用逗号或空格分隔），例如：wireless earbuds, bluetooth headphones"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                rows={2}
                style={{ marginBottom: 16 }}
              />
              {adCopyData ? (
                <div style={{ maxHeight: 400, overflow: 'auto' }}>
                  <Row gutter={8} style={{ marginBottom: 12 }}>
                    <Col span={12}>
                      <Text strong>🎯 关键词：</Text> {adCopyData.keywords?.join(', ')}
                    </Col>
                    <Col span={12}>
                      <Text strong>🌍 {adCopyData.country_name}</Text> · {adCopyData.language} · {adCopyData.currency}
                    </Col>
                  </Row>
                  <Paragraph>
                    <Text type="secondary">🚚 {adCopyData.shipping_info}</Text>
                  </Paragraph>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8, background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
                    {adCopyData.recommendations}
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>
                  <RocketOutlined style={{ fontSize: 32, marginBottom: 8 }} />
                  <p>输入产品链接和关键词，AI 将生成：</p>
                  <p style={{ fontSize: 12 }}>17条广告标题 · 6条广告描述 · 6条附加链接</p>
                  <p style={{ fontSize: 12 }}>自动适配该国语言、物流、折扣信息</p>
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













