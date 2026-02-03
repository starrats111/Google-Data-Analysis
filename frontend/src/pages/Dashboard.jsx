import React, { useEffect, useMemo, useState } from 'react'
import { Card, Row, Col, Table, message, Segmented, Tag, Typography, Space, Statistic } from 'antd'
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

  const { Text } = Typography

  const campaignColumns = [
    { title: '广告系列名', dataIndex: 'campaign_name', key: 'campaign_name', ellipsis: true },
    { title: '佣金', dataIndex: 'commission', key: 'commission', align: 'right', render: (v) => Number(v || 0).toFixed(2) },
    { title: '费用', dataIndex: 'cost', key: 'cost', align: 'right', render: (v) => Number(v || 0).toFixed(2) },
    { title: '订单', dataIndex: 'orders', key: 'orders', align: 'right', render: (v) => Number(v || 0).toFixed(0) },
    { title: 'ROI', dataIndex: 'roi', key: 'roi', align: 'right', render: (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2)) },
    {
      title: 'AI点评',
      dataIndex: 'ai_commentary',
      key: 'ai_commentary',
      render: (v) => <Text type="secondary">{v || '-'}</Text>,
    },
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
          <Card title="数据最好的广告系列 Top3（按 ROI）" extra={<Text type="secondary">{insights?.start_date} ~ {insights?.end_date}</Text>}>
            <Table
              columns={campaignColumns}
              dataSource={insights?.top3 || []}
              rowKey="campaign_id"
              loading={loading}
              pagination={false}
              size="small"
              scroll={{ x: 900 }}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="数据最差的广告系列 Bottom3（按 ROI）" extra={<Text type="secondary">{insights?.start_date} ~ {insights?.end_date}</Text>}>
            <Table
              columns={campaignColumns}
              dataSource={insights?.bottom3 || []}
              rowKey="campaign_id"
              loading={loading}
              pagination={false}
              size="small"
              scroll={{ x: 900 }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default Dashboard













