import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Card, Row, Col, Table, message, Segmented, Tag, Typography, Space, Statistic, Input, Button, Spin, Select, Tooltip } from 'antd'
import { SearchOutlined, RocketOutlined, CalendarOutlined, GlobalOutlined, PictureOutlined, SyncOutlined, ClockCircleOutlined } from '@ant-design/icons'
import { useAuth } from '../store/authStore'
import api from '../services/api'
import ReactECharts from 'echarts-for-react'
import dayjs from 'dayjs'

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
  
  // 截图粘贴状态
  const [keywordImageLoading, setKeywordImageLoading] = useState(false)
  const [pastedImage, setPastedImage] = useState(null)
  
  // 自动刷新状态
  const [lastUpdated, setLastUpdated] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [countdown, setCountdown] = useState(300)
  const autoRefreshTimerRef = useRef(null)
  const countdownTimerRef = useRef(null)
  const loadingRef = useRef(false)

  const fetchManagerData = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
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
      loadingRef.current = false
      setLastUpdated(dayjs())
      setCountdown(300)
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
      setCountdown(300)
    }
  }, [insightRange])

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
      if (!cancelled) doRefresh()
    }
    doFetch()
    return () => { cancelled = true }
  }, [doRefresh])

  // 自动刷新定时器（每5分钟）
  useEffect(() => {
    if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current)
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current)
    
    if (autoRefresh) {
      countdownTimerRef.current = setInterval(() => {
        setCountdown(prev => (prev <= 1 ? 300 : prev - 1))
      }, 1000)
      autoRefreshTimerRef.current = setInterval(() => {
        doRefresh()
      }, 300000)
    }
    
    return () => {
      if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current)
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current)
    }
  }, [autoRefresh, doRefresh])

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>数据总览</h2>
          <Space>
            <Button onClick={doRefresh} loading={loading} icon={<SyncOutlined spin={loading} />} size="small">刷新</Button>
            <Tooltip title={autoRefresh ? '点击关闭自动刷新' : '点击开启自动刷新（每5分钟）'}>
              <Tag 
                color={autoRefresh ? 'processing' : 'default'} 
                style={{ cursor: 'pointer', fontSize: 12 }}
                onClick={() => setAutoRefresh(!autoRefresh)}
              >
                {autoRefresh ? <><SyncOutlined spin /> {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</> : '自动刷新已关闭'}
              </Tag>
            </Tooltip>
            {lastUpdated && (
              <span style={{ color: '#999', fontSize: 12 }}>
                <ClockCircleOutlined style={{ marginRight: 4 }} />
                {lastUpdated.format('HH:mm:ss')}
              </span>
            )}
          </Space>
        </div>
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

  // 处理粘贴截图
  const handlePaste = async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile()
        if (file) {
          e.preventDefault()
          await recognizeImage(file)
          break
        }
      }
    }
  }

  // 识别图片中的关键词
  const recognizeImage = async (file) => {
    setKeywordImageLoading(true)
    setPastedImage(URL.createObjectURL(file))
    
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('prompt', `请仔细分析这张关键词工具截图，提取所有可见的关键词。

要求：
1. 只提取关键词本身，不要搜索量、竞争度等数据
2. 每个关键词用逗号分隔
3. 直接输出关键词列表，不要任何解释

例如输出格式：wireless earbuds, bluetooth headphones, earphones wireless, tws earbuds`)
      
      const res = await api.post('/api/gemini/analyze-image', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      
      if (res.data.success) {
        setKeywords(res.data.analysis)
        message.success('关键词识别成功！')
      } else {
        message.error(res.data.message || '识别失败')
      }
    } catch (error) {
      message.error('识别失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setKeywordImageLoading(false)
    }
  }

  // 清除粘贴的图片
  const clearPastedImage = () => {
    setPastedImage(null)
  }

  // 生成广告词
  const generateAdCopy = async () => {
    if (!productUrl.trim()) {
      message.warning('请输入产品链接URL（必填，用于获取真实折扣和物流信息）')
      return
    }
    if (!keywords.trim()) {
      message.warning('请输入关键词（或上传截图识别）')
      return
    }
    setAdCopyLoading(true)
    try {
      const keywordList = keywords.split(/[,，\s\n]+/).filter(k => k.trim())
      const res = await api.post('/api/gemini/recommend-keywords', {
        keywords: keywordList,
        product_url: productUrl,
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space wrap>
            <Text>欢迎，<b>{user?.username}</b></Text>
            <Tag color="blue">{user?.role === 'manager' ? '经理' : '员工'}</Tag>
          </Space>
          <Space>
            <Button onClick={doRefresh} loading={loading} icon={<SyncOutlined spin={loading} />} size="small">刷新</Button>
            <Tooltip title={autoRefresh ? '点击关闭自动刷新' : '点击开启自动刷新（每5分钟）'}>
              <Tag 
                color={autoRefresh ? 'processing' : 'default'} 
                style={{ cursor: 'pointer', fontSize: 12 }}
                onClick={() => setAutoRefresh(!autoRefresh)}
              >
                {autoRefresh ? <><SyncOutlined spin /> {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</> : '自动刷新已关闭'}
              </Tag>
            </Tooltip>
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
                          borderLeft: '4px solid #1890ff'
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
                          <div style={{ background: '#e6f7ff', padding: '6px 10px', borderRadius: 4, marginTop: 6 }}>
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
                placeholder="产品链接 URL（必填），例如：https://www.tous.com"
                value={productUrl}
                onChange={(e) => setProductUrl(e.target.value)}
                style={{ marginBottom: 8 }}
                prefix={<GlobalOutlined />}
                status={!productUrl.trim() ? 'warning' : ''}
              />
              <div style={{ marginBottom: 8 }}>
                <Text type="secondary">关键词（直接粘贴截图或手动输入）：</Text>
              </div>
              
              {/* 粘贴区域 */}
              <div
                onPaste={handlePaste}
                style={{
                  border: pastedImage ? '2px solid #52c41a' : '2px dashed #d9d9d9',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 12,
                  background: pastedImage ? '#f6ffed' : '#fafafa',
                  cursor: 'pointer',
                  minHeight: 80,
                  position: 'relative'
                }}
                tabIndex={0}
              >
                {keywordImageLoading ? (
                  <div style={{ textAlign: 'center', padding: 20 }}>
                    <Spin />
                    <p style={{ marginTop: 8, color: '#1890ff' }}>AI 正在识别关键词...</p>
                  </div>
                ) : pastedImage ? (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text type="success">✅ 截图已识别</Text>
                      <Button size="small" onClick={clearPastedImage}>清除</Button>
                    </div>
                    <img src={pastedImage} alt="截图" style={{ maxWidth: '100%', maxHeight: 100, borderRadius: 4 }} />
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', color: '#999' }}>
                    <PictureOutlined style={{ fontSize: 24, marginBottom: 8 }} />
                    <p style={{ margin: 0 }}>📋 <b>Ctrl+V 粘贴截图</b></p>
                    <p style={{ margin: 0, fontSize: 12 }}>从 sem.3ue.co 截图后直接粘贴到这里</p>
                  </div>
                )}
              </div>

              <Input.TextArea
                placeholder="关键词会自动填入这里，也可手动输入"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                rows={2}
                style={{ marginBottom: 12 }}
              />
              {adCopyData ? (
                <div style={{ maxHeight: 400, overflow: 'auto' }}>
                  <Row gutter={8} style={{ marginBottom: 12 }}>
                    <Col span={24}>
                      <Text strong>🔗 产品链接：</Text> <a href={adCopyData.product_url} target="_blank" rel="noreferrer">{adCopyData.product_url}</a>
                    </Col>
                  </Row>
                  <Row gutter={8} style={{ marginBottom: 12 }}>
                    <Col span={12}>
                      <Text strong>🎯 关键词：</Text> {adCopyData.keywords?.join(', ')}
                    </Col>
                    <Col span={12}>
                      <Text strong>🌍 {adCopyData.country_name}</Text> · {adCopyData.language} · {adCopyData.currency}
                    </Col>
                  </Row>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8, background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
                    {adCopyData.recommendations}
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 20, color: '#999' }}>
                  <RocketOutlined style={{ fontSize: 32, marginBottom: 8 }} />
                  <p><b>⚠️ 产品链接必填</b></p>
                  <p style={{ fontSize: 12 }}>AI 会从链接中抓取<b>真实的</b>折扣和物流信息</p>
                  <p style={{ fontSize: 12 }}>生成：17条广告标题 · 6条广告描述 · 6条附加链接</p>
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













