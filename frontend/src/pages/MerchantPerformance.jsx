import React, { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { Card, Table, Row, Col, Statistic, DatePicker, Select, Space, Button, message, Spin, Typography } from 'antd'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const ReactECharts = lazy(() => import('echarts-for-react'))
const { RangePicker } = DatePicker
const { Option } = Select

const MerchantPerformance = () => {
  const { user, permissions } = useAuth()
  const role = permissions?.role || user?.role || 'member'
  const isEmployee = role === 'member' || role === 'employee'

  const [loading, setLoading] = useState(false)
  const [ranking, setRanking] = useState([])
  const [detailRows, setDetailRows] = useState([])
  const [users, setUsers] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [filters, setFilters] = useState({
    dateRange: [dayjs().subtract(29, 'day'), dayjs()],
    userId: undefined,
    platform: undefined,
  })

  useEffect(() => {
    fetchMeta()
    fetchData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchMeta = async () => {
    try {
      const requests = [api.get('/api/merchants/stats')]
      if (!isEmployee) {
        requests.push(api.get('/api/team/users'))
      }
      const results = await Promise.all(requests)
      setPlatforms(Object.keys(results[0].data?.by_platform || {}))
      if (!isEmployee && results[1]) {
        setUsers(results[1].data || [])
      }
    } catch (error) {
      console.error('获取绩效筛选信息失败', error)
    }
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      const [start, end] = filters.dateRange || []
      const baseParams = {
        start_date: start ? start.format('YYYY-MM-DD') : undefined,
        end_date: end ? end.format('YYYY-MM-DD') : undefined,
      }

      const detailParams = {
        ...baseParams,
        user_id: filters.userId,
        platform: filters.platform,
      }

      const [rankingResp, detailResp] = await Promise.all([
        role === 'member' || role === 'employee'
          ? Promise.resolve({ data: [] })
          : api.get('/api/merchant-performance/ranking', { params: baseParams }),
        api.get('/api/merchant-performance', { params: detailParams }),
      ])

      setRanking(rankingResp.data || [])
      setDetailRows(detailResp.data || [])
    } catch (error) {
      message.error(error.response?.data?.detail || '获取绩效数据失败')
    } finally {
      setLoading(false)
    }
  }

  const summary = useMemo(() => {
    const merchantSet = new Set(detailRows.map((r) => r.merchant_id))
    const activeMerchantSet = new Set(detailRows.filter((r) => (r.orders || 0) > 0).map((r) => r.merchant_id))
    const totalCommission = detailRows.reduce((acc, row) => acc + Number(row.commission || 0), 0)
    return {
      totalMerchants: merchantSet.size,
      assignedMerchants: merchantSet.size,
      activeMerchants: activeMerchantSet.size,
      totalCommission,
    }
  }, [detailRows])

  const trendOption = useMemo(() => {
    const dateMap = {}
    detailRows.forEach((row) => {
      const key = row.platform || 'Unknown'
      dateMap[key] = (dateMap[key] || 0) + Number(row.commission || 0)
    })
    const x = Object.keys(dateMap)
    const y = x.map((k) => Number(dateMap[k].toFixed(2)))

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: x },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'bar',
          name: '佣金',
          data: y,
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        },
      ],
      grid: { left: 32, right: 12, top: 24, bottom: 28 },
    }
  }, [detailRows])

  const pieOption = useMemo(() => {
    const source = (ranking.length ? ranking : [])
      .map((r) => ({ name: r.display_name || r.username || `用户${r.user_id}`, value: Number(r.commission || 0) }))
      .filter((r) => r.value > 0)

    return {
      tooltip: { trigger: 'item' },
      legend: { orient: 'vertical', right: 0, top: 'middle' },
      series: [
        {
          name: '佣金占比',
          type: 'pie',
          radius: ['38%', '68%'],
          center: ['35%', '50%'],
          data: source,
          label: { formatter: '{b}: {d}%' },
        },
      ],
    }
  }, [ranking])

  const rankingColumns = [
    {
      title: '员工',
      key: 'name',
      render: (_, row) => row.display_name || row.username || '-',
      width: 130,
      fixed: 'left',
    },
    {
      title: '负责商家数',
      dataIndex: 'merchant_count',
      key: 'merchant_count',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.merchant_count || 0) - (b.merchant_count || 0),
    },
    {
      title: '订单数',
      dataIndex: 'orders',
      key: 'orders',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.orders || 0) - (b.orders || 0),
    },
    {
      title: 'GMV',
      dataIndex: 'gmv',
      key: 'gmv',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.gmv || 0) - (b.gmv || 0),
      render: (v) => `$${Number(v || 0).toFixed(2)}`,
    },
    {
      title: '佣金',
      dataIndex: 'commission',
      key: 'commission',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.commission || 0) - (b.commission || 0),
      render: (v) => `$${Number(v || 0).toFixed(2)}`,
    },
    {
      title: '目标',
      dataIndex: 'total_target',
      key: 'total_target',
      width: 120,
      align: 'right',
      render: (v) => (v ? `$${Number(v).toFixed(2)}` : '-'),
    },
    {
      title: '目标完成率',
      dataIndex: 'completion_rate',
      key: 'completion_rate',
      width: 130,
      align: 'right',
      render: (v) => (v !== null && v !== undefined ? `${Number(v).toFixed(1)}%` : '-'),
    },
  ]

  const detailColumns = [
    !isEmployee && {
      title: '员工',
      key: 'user',
      width: 120,
      fixed: 'left',
      render: (_, row) => row.display_name || row.username || '-',
    },
    {
      title: '商家',
      dataIndex: 'merchant_name',
      key: 'merchant_name',
      width: 180,
      fixed: 'left',
      render: (v, row) => (
        <Space direction="vertical" size={0}>
          <span>{v || '-'}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.platform || '-'} / {row.mid || '-'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '订单数',
      dataIndex: 'orders',
      key: 'orders',
      width: 100,
      align: 'right',
      sorter: (a, b) => (a.orders || 0) - (b.orders || 0),
    },
    {
      title: 'GMV',
      dataIndex: 'gmv',
      key: 'gmv',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.gmv || 0) - (b.gmv || 0),
      render: (v) => `$${Number(v || 0).toFixed(2)}`,
    },
    {
      title: '佣金',
      dataIndex: 'commission',
      key: 'commission',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.commission || 0) - (b.commission || 0),
      render: (v) => `$${Number(v || 0).toFixed(2)}`,
    },
    {
      title: '月目标佣金',
      dataIndex: 'monthly_target',
      key: 'monthly_target',
      width: 140,
      align: 'right',
      render: (v) => (v ? `$${Number(v).toFixed(2)}` : '-'),
    },
  ].filter(Boolean)

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <RangePicker
            value={filters.dateRange}
            onChange={(vals) => setFilters((s) => ({ ...s, dateRange: vals || [] }))}
            allowClear={false}
          />

          {!isEmployee && (
            <Select
              allowClear
              placeholder="员工"
              style={{ width: 180 }}
              value={filters.userId}
              onChange={(v) => setFilters((s) => ({ ...s, userId: v }))}
            >
              {users.map((u) => (
                <Option key={u.id} value={u.id}>{u.display_name || u.username}</Option>
              ))}
            </Select>
          )}

          <Select
            allowClear
            placeholder="平台"
            style={{ width: 140 }}
            value={filters.platform}
            onChange={(v) => setFilters((s) => ({ ...s, platform: v }))}
          >
            {platforms.map((p) => (
              <Option key={p} value={p}>{p}</Option>
            ))}
          </Select>

          <Button type="primary" onClick={fetchData}>查询</Button>
        </Space>
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title={isEmployee ? '我的商家数' : '总商家数'} value={summary.totalMerchants} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title={isEmployee ? '已分配给我' : '已分配商家'} value={summary.assignedMerchants} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title={isEmployee ? '我的活跃商家' : '活跃商家'} value={summary.activeMerchants} valueStyle={{ color: '#13c2c2' }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card>
            <Statistic title={isEmployee ? '我的佣金' : '总佣金'} value={summary.totalCommission} precision={2} prefix="$" valueStyle={{ color: '#3f8600' }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={isEmployee ? 24 : 12}>
          <Card title="平台佣金分布" style={{ minHeight: 360 }}>
            <Suspense fallback={<Spin />}>
              <ReactECharts option={trendOption} style={{ height: 300 }} lazyUpdate notMerge />
            </Suspense>
          </Card>
        </Col>
        {!isEmployee && (
          <Col xs={24} lg={12}>
            <Card title="员工佣金占比" style={{ minHeight: 360 }}>
              <Suspense fallback={<Spin />}>
                <ReactECharts option={pieOption} style={{ height: 300 }} lazyUpdate notMerge />
              </Suspense>
            </Card>
          </Col>
        )}
      </Row>

      {!(role === 'member' || role === 'employee') && (
        <Card title="员工绩效排名" style={{ marginBottom: 16 }}>
          <Table
            rowKey={(row) => row.user_id}
            loading={loading}
            columns={rankingColumns}
            dataSource={ranking}
            scroll={{ x: 900 }}
            pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 人` }}
          />
        </Card>
      )}

      <Card title={isEmployee ? '我的商家绩效' : '商家绩效明细'}>
        <Table
          rowKey={(row) => `${row.user_id}-${row.merchant_id}`}
          loading={loading}
          columns={detailColumns}
          dataSource={detailRows}
          scroll={{ x: 920 }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>
    </div>
  )
}

export default MerchantPerformance
