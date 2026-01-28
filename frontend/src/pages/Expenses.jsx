import React, { useEffect, useMemo, useState } from 'react'
import { Card, DatePicker, Select, Space, Table, Statistic, Row, Col, InputNumber, Button, message, Segmented } from 'antd'
import dayjs from 'dayjs'
import api from '../services/api'

const { RangePicker } = DatePicker
const { Option } = Select

function getPresetRange(preset) {
  const today = dayjs()
  if (preset === '过去7天') return [today.subtract(6, 'day'), today]
  if (preset === '本周') return [today.startOf('week'), today.endOf('week')]
  if (preset === '上周') {
    const start = today.subtract(1, 'week').startOf('week')
    return [start, start.endOf('week')]
  }
  if (preset === '本月') return [today.startOf('month'), today.endOf('month')]
  if (preset === '上月') {
    const start = today.subtract(1, 'month').startOf('month')
    return [start, start.endOf('month')]
  }
  return [today.subtract(6, 'day'), today]
}

const Expenses = () => {
  const [preset, setPreset] = useState('过去7天')
  const [range, setRange] = useState(getPresetRange('过去7天'))
  const [summary, setSummary] = useState(null)
  const [daily, setDaily] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedDate, setSelectedDate] = useState(null) // 单日查看（可选）

  useEffect(() => {
    const r = getPresetRange(preset)
    setRange(r)
    setSelectedDate(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset])

  const startDate = useMemo(() => range?.[0]?.format('YYYY-MM-DD'), [range])
  const endDate = useMemo(() => range?.[1]?.format('YYYY-MM-DD'), [range])
  const todayDate = useMemo(() => (selectedDate ? selectedDate.format('YYYY-MM-DD') : endDate), [selectedDate, endDate])

  const fetchAll = async () => {
    if (!startDate || !endDate) return
    setLoading(true)
    try {
      const [sumRes, dailyRes] = await Promise.all([
        api.get('/api/expenses/summary', { params: { start_date: startDate, end_date: endDate, today_date: todayDate } }),
        api.get('/api/expenses/daily', { params: { start_date: startDate, end_date: endDate } }),
      ])
      setSummary(sumRes.data)
      setDaily(dailyRes.data.rows || [])
    } catch (e) {
      message.error(e.response?.data?.detail || '获取费用数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, todayDate])

  const handleSaveRejected = async (platformId, dateStr, value) => {
    try {
      await api.post('/api/expenses/rejected-commission', {
        platform_id: platformId,
        date: dateStr,
        rejected_commission: Number(value || 0),
      })
      message.success('已保存拒付佣金')
      fetchAll()
    } catch (e) {
      message.error(e.response?.data?.detail || '保存失败')
    }
  }

  const platformColumns = [
    { title: '平台', dataIndex: 'platform_name', key: 'platform_name', width: 140 },
    { title: '当天佣金', dataIndex: 'today_commission', key: 'today_commission', align: 'right' },
    { title: '当天广告费用', dataIndex: 'today_ad_cost', key: 'today_ad_cost', align: 'right' },
    { title: '当天拒付佣金', dataIndex: 'today_rejected_commission', key: 'today_rejected_commission', align: 'right' },
    { title: '当天净利润', dataIndex: 'today_net_profit', key: 'today_net_profit', align: 'right' },
    { title: '累计佣金', dataIndex: 'range_commission', key: 'range_commission', align: 'right' },
    { title: '累计广告费用', dataIndex: 'range_ad_cost', key: 'range_ad_cost', align: 'right' },
    { title: '累计拒付佣金', dataIndex: 'range_rejected_commission', key: 'range_rejected_commission', align: 'right' },
    { title: '累计净利润', dataIndex: 'range_net_profit', key: 'range_net_profit', align: 'right' },
  ]

  const dailyColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 110 },
    { title: '平台', dataIndex: 'platform_name', key: 'platform_name', width: 140 },
    { title: '佣金', dataIndex: 'commission', key: 'commission', align: 'right' },
    { title: '广告费用', dataIndex: 'ad_cost', key: 'ad_cost', align: 'right' },
    {
      title: '拒付佣金(手动)',
      dataIndex: 'rejected_commission',
      key: 'rejected_commission',
      align: 'right',
      render: (v, r) => (
        <Space>
          <InputNumber
            value={Number(v || 0)}
            min={0}
            step={0.01}
            style={{ width: 120 }}
            onChange={(val) => {
              // 仅更新展示，不立即提交
              r.__draftRejected = val
            }}
          />
          <Button size="small" onClick={() => handleSaveRejected(r.platform_id, r.date, r.__draftRejected ?? v)}>保存</Button>
        </Space>
      ),
    },
    { title: '净利润', dataIndex: 'net_profit', key: 'net_profit', align: 'right' },
  ]

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Segmented
            options={['本周', '上周', '过去7天', '本月', '上月', '自定义']}
            value={preset}
            onChange={setPreset}
          />
          {preset === '自定义' && (
            <RangePicker value={range} onChange={(v) => setRange(v)} />
          )}
          <DatePicker
            value={selectedDate}
            onChange={setSelectedDate}
            allowClear
            placeholder="选择某一天(可选)"
          />
          <Button onClick={fetchAll} loading={loading}>刷新</Button>
        </Space>
      </Card>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic title="总佣金" value={summary?.totals?.total_commission ?? 0} precision={4} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="总广告费用" value={summary?.totals?.total_ad_cost ?? 0} precision={4} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="净利润(扣拒付)" value={summary?.totals?.net_profit ?? 0} precision={4} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="平均每日收益" value={summary?.totals?.avg_daily_profit ?? 0} precision={4} />
          </Card>
        </Col>
      </Row>

      <Card title={`按平台汇总（当天=${summary?.today_date || '-'}；区间=${summary?.start_date || '-'} ~ ${summary?.end_date || '-'}` } style={{ marginBottom: 16 }}>
        <Table
          rowKey="platform_id"
          dataSource={summary?.platforms || []}
          columns={platformColumns}
          loading={loading}
          pagination={false}
          scroll={{ x: 1200 }}
        />
      </Card>

      <Card title="按天明细（可录入拒付佣金）">
        <Table
          rowKey={(r) => `${r.date}-${r.platform_id}`}
          dataSource={daily}
          columns={dailyColumns}
          loading={loading}
          pagination={{ pageSize: 10, showSizeChanger: true }}
          scroll={{ x: 1000 }}
        />
      </Card>
    </div>
  )
}

export default Expenses


