import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Card, DatePicker, Select, Space, Table, Statistic, Row, Col, InputNumber, Button, message, Segmented, Collapse, Modal, Popconfirm } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

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
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  const [preset, setPreset] = useState('过去7天')
  const [range, setRange] = useState(getPresetRange('过去7天'))
  const [summary, setSummary] = useState(null)
  const [managerSummary, setManagerSummary] = useState(null) // 经理查看所有员工的数据
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

  // 使用ref存储请求取消函数，防止重复请求
  const abortControllerRef = useRef(null)
  
  const fetchAll = useCallback(async () => {
    if (!startDate || !endDate) return
    // 防止重复请求：如果正在加载，直接返回
    if (loading) return
    
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    // 创建新的AbortController
    abortControllerRef.current = new AbortController()
    
    setLoading(true)
    try {
      if (isManager) {
        // 经理：获取所有员工的汇总数据
        const sumRes = await api.get('/api/expenses/summary', { 
          params: { start_date: startDate, end_date: endDate, today_date: todayDate },
          signal: abortControllerRef.current.signal
        })
        setManagerSummary(sumRes.data)
        setSummary(null)
        // 经理不需要daily明细，因为已经在summary中包含了
        setDaily([])
      } else {
        // 员工：获取自己的数据
        const [sumRes, dailyRes] = await Promise.all([
          api.get('/api/expenses/summary', { 
            params: { start_date: startDate, end_date: endDate, today_date: todayDate },
            signal: abortControllerRef.current.signal
          }),
          api.get('/api/expenses/daily', { 
            params: { start_date: startDate, end_date: endDate },
            signal: abortControllerRef.current.signal
          }),
        ])
        setSummary(sumRes.data)
        setManagerSummary(null)
        setDaily(dailyRes.data.rows || [])
      }
    } catch (e) {
      // 忽略取消的请求
      if (e.name === 'CanceledError' || e.name === 'AbortError') {
        return
      }
      // 如果是网络错误，不要显示错误消息，避免刷屏
      if (e.code === 'ERR_NETWORK' || e.message === 'Network Error') {
        if (import.meta.env.DEV) {
          console.error('网络错误:', e)
        }
        // 不显示错误消息，避免用户看到大量错误提示
      } else {
        message.error(e.response?.data?.detail || '获取费用数据失败')
      }
    } finally {
      setLoading(false)
      abortControllerRef.current = null
    }
  }, [startDate, endDate, todayDate, isManager, loading])

  useEffect(() => {
    // 使用 ref 来防止重复调用
    let cancelled = false
    
    const doFetch = async () => {
      if (!cancelled && startDate && endDate) {
        await fetchAll()
      }
    }
    
    doFetch()
    
    return () => {
      cancelled = true
      // 组件卸载时取消请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [startDate, endDate, todayDate, fetchAll])

  const handleSaveRejected = async (platformId, dateStr, rejectedValue, manualCostValue, manualCommissionValue) => {
    try {
      await api.post('/api/expenses/rejected-commission', {
        platform_id: platformId,
        date: dateStr,
        rejected_commission: Number(rejectedValue || 0),
        manual_cost: manualCostValue !== undefined ? Number(manualCostValue || 0) : undefined,
        manual_commission: manualCommissionValue !== undefined ? Number(manualCommissionValue || 0) : undefined,
      })
      message.success('已保存')
      fetchAll()
    } catch (e) {
      message.error(e.response?.data?.detail || '保存失败')
    }
  }

  const handleCleanDuplicateCosts = async () => {
    Modal.confirm({
      title: '清理重复费用数据',
      content: `确定要清理 ${startDate} ~ ${endDate} 范围内的重复费用数据吗？\n\n此操作将删除手动上传的费用数据（保留Google Ads API同步的费用），操作不可恢复！`,
      okText: '确定清理',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const response = await api.post('/api/expenses/clean-duplicate-costs', {
            start_date: startDate,
            end_date: endDate,
          })
          message.success(response.data.message || '清理成功')
          fetchAll()
        } catch (e) {
          message.error(e.response?.data?.detail || '清理失败')
        }
      },
    })
  }

  const platformColumns = [
    { title: '平台', dataIndex: 'platform_name', key: 'platform_name', width: 140 },
    { title: '累计佣金(总)', dataIndex: 'range_commission', key: 'range_commission', align: 'right' },
    { title: '累计已付佣金', dataIndex: 'range_paid_commission', key: 'range_paid_commission', align: 'right' },
    { title: '累计广告费用', dataIndex: 'range_ad_cost', key: 'range_ad_cost', align: 'right' },
    { title: '累计拒付佣金', dataIndex: 'range_rejected_commission', key: 'range_rejected_commission', align: 'right' },
    { title: '累计净利润', dataIndex: 'range_net_profit', key: 'range_net_profit', align: 'right' },
  ]

  const dailyColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 110 },
    { title: '平台', dataIndex: 'platform_name', key: 'platform_name', width: 140 },
    { 
      title: '佣金(可手动)',
      dataIndex: 'commission',
      key: 'commission',
      align: 'right',
      render: (v, r) => (
        <Space>
          <InputNumber
            value={Number(v || 0)}
            min={0}
            step={0.01}
            style={{ width: 120 }}
            onChange={(val) => {
              r.__draftCommission = val
            }}
          />
          <Button size="small" onClick={() => handleSaveRejected(r.platform_id, r.date, r.__draftRejected ?? r.rejected_commission ?? 0, r.__draftCost ?? r.ad_cost, r.__draftCommission ?? v)}>保存</Button>
        </Space>
      ),
    },
    { 
      title: '广告费用(可手动)',
      dataIndex: 'ad_cost',
      key: 'ad_cost',
      align: 'right',
      render: (v, r) => (
        <Space>
          <InputNumber
            value={Number(v || 0)}
            min={0}
            step={0.01}
            style={{ width: 120 }}
            onChange={(val) => {
              r.__draftCost = val
            }}
          />
          <Button size="small" onClick={() => handleSaveRejected(r.platform_id, r.date, r.__draftRejected ?? r.rejected_commission ?? 0, r.__draftCost ?? r.ad_cost, undefined)}>保存</Button>
        </Space>
      ),
    },
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
              r.__draftRejected = val
            }}
          />
          <Button size="small" onClick={() => handleSaveRejected(r.platform_id, r.date, r.__draftRejected ?? v, r.__draftCost ?? r.ad_cost)}>保存</Button>
        </Space>
      ),
    },
    { title: '净利润', dataIndex: 'net_profit', key: 'net_profit', align: 'right', render: (v) => (v || 0).toFixed(4) },
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
          {!isManager && (
            <Popconfirm
              title="清理重复费用数据"
              description={`确定要清理 ${startDate} ~ ${endDate} 范围内的重复费用数据吗？此操作将删除Google Ads API同步的费用数据（保留手动上传的费用），操作不可恢复！`}
              onConfirm={handleCleanDuplicateCosts}
              okText="确定清理"
              okType="danger"
              cancelText="取消"
            >
              <Button danger icon={<DeleteOutlined />} loading={loading}>
                清理重复费用
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Card>

      {/* 总计统计 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic 
              title="总佣金" 
              value={isManager ? (managerSummary?.totals?.total_commission ?? 0) : (summary?.totals?.total_commission ?? 0)} 
              precision={4} 
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card 
            style={{ cursor: 'pointer' }}
            onClick={() => {
              // 跳转到费用详情页
              window.open(`/expense-cost-detail?start_date=${startDate}&end_date=${endDate}`, '_blank')
            }}
          >
            <Statistic 
              title="总广告费用" 
              value={isManager ? (managerSummary?.totals?.total_ad_cost ?? 0) : (summary?.totals?.total_ad_cost ?? 0)} 
              precision={4} 
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic 
              title="净利润(扣拒付)" 
              value={isManager ? (managerSummary?.totals?.net_profit ?? 0) : (summary?.totals?.net_profit ?? 0)} 
              precision={4} 
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic 
              title="平均每日收益" 
              value={isManager ? (managerSummary?.totals?.avg_daily_profit ?? 0) : (summary?.totals?.avg_daily_profit ?? 0)} 
              precision={4} 
            />
          </Card>
        </Col>
      </Row>

      {isManager ? (
        // 经理：显示所有员工汇总 + 按员工汇总 + 按员工+平台明细
        <>
          {/* 按员工汇总 */}
          <Card title={`按员工汇总（区间=${managerSummary?.start_date || '-'} ~ ${managerSummary?.end_date || '-'}）`} style={{ marginBottom: 16 }}>
            <Table
              rowKey="user_id"
              dataSource={managerSummary?.users || []}
              columns={[
                { title: '员工', dataIndex: 'username', key: 'username', width: 120 },
                { title: '总佣金', dataIndex: 'total_commission', key: 'total_commission', align: 'right', render: (v) => Number(v || 0).toFixed(4) },
                { title: '总广告费用', dataIndex: 'total_ad_cost', key: 'total_ad_cost', align: 'right', render: (v) => Number(v || 0).toFixed(4) },
                { title: '总拒付佣金', dataIndex: 'total_rejected_commission', key: 'total_rejected_commission', align: 'right', render: (v) => Number(v || 0).toFixed(4) },
                { title: '净利润', dataIndex: 'net_profit', key: 'net_profit', align: 'right', render: (v) => Number(v || 0).toFixed(4) },
              ]}
              loading={loading}
              pagination={false}
              scroll={{ x: 800 }}
            />
          </Card>

          {/* 按员工+平台明细 */}
          <Card title="按员工+平台明细">
            <Collapse
              items={managerSummary?.users?.map(user => ({
                key: user.user_id.toString(),
                label: (
                  <Space>
                    <strong>{user.username}</strong>
                    <span>总佣金: {Number(user.total_commission || 0).toFixed(4)}</span>
                    <span>总费用: {Number(user.total_ad_cost || 0).toFixed(4)}</span>
                    <span>净利润: {Number(user.net_profit || 0).toFixed(4)}</span>
                  </Space>
                ),
                children: (
                  <Table
                    rowKey="platform_id"
                    dataSource={user.platforms || []}
                    columns={platformColumns}
                    pagination={false}
                    scroll={{ x: 1200 }}
                  />
                ),
              })) || []}
              defaultActiveKey={managerSummary?.users?.map(u => u.user_id.toString()) || []}
            />
          </Card>
        </>
      ) : (
        // 员工：显示自己的数据
        <>
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
              pagination={{ 
                pageSize: 10, 
                showSizeChanger: true,
                showQuickJumper: true,
                showTotal: (total) => `共 ${total} 条`,
                defaultPageSize: 10,
                pageSizeOptions: ['10', '20', '50', '100'],
              }}
              scroll={{ x: 1000 }}
            />
          </Card>
        </>
      )}
    </div>
  )
}

export default Expenses


