import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Card, DatePicker, Select, Space, Table, Statistic, Row, Col, Button, message, Segmented, Collapse, Modal, Tag, Tooltip } from 'antd'
import { SyncOutlined, ClockCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker
const { Option } = Select

// 数据是每天凌晨4点定时同步的，所以只有到昨天的数据
function getPresetRange(preset) {
  const yesterday = dayjs().subtract(1, 'day')
  if (preset === '过去7天') return [yesterday.subtract(6, 'day'), yesterday]
  if (preset === '本周') return [dayjs().startOf('week'), yesterday]
  if (preset === '上周') {
    const start = dayjs().subtract(1, 'week').startOf('week')
    return [start, start.endOf('week')]
  }
  if (preset === '本月') return [dayjs().startOf('month'), yesterday]
  if (preset === '上月') {
    const start = dayjs().subtract(1, 'month').startOf('month')
    return [start, start.endOf('month')]
  }
  return [yesterday.subtract(6, 'day'), yesterday]
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
  const [mccModalVisible, setMccModalVisible] = useState(false)
  const [mccCostLoading, setMccCostLoading] = useState(false)
  const [mccCostData, setMccCostData] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [countdown, setCountdown] = useState(300) // 5分钟=300秒
  const autoRefreshRef = useRef(null)
  const countdownRef = useRef(null)

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
  const loadingRef = useRef(false)
  
  const fetchAll = useCallback(async () => {
    if (!startDate || !endDate) return
    // 防止重复请求：如果正在加载，直接返回（用 ref 避免把 loading 放进依赖导致 effect 反复触发）
    if (loadingRef.current) return
    
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    // 创建新的AbortController
    const controller = new AbortController()
    abortControllerRef.current = controller
    
    loadingRef.current = true
    setLoading(true)
    try {
      if (isManager) {
        // 经理：获取所有员工的汇总数据
        const sumRes = await api.get('/api/expenses/summary', { 
          params: { start_date: startDate, end_date: endDate, today_date: todayDate },
          signal: controller.signal
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
            signal: controller.signal
          }),
          api.get('/api/expenses/daily', { 
            params: { start_date: startDate, end_date: endDate },
            signal: controller.signal
          }),
        ])
        setSummary(sumRes.data)
        setManagerSummary(null)
        setDaily(dailyRes.data.rows || [])
      }
    } catch (e) {
      // 忽略取消的请求
      if (e.isCanceled || e.name === 'CanceledError' || e.name === 'AbortError') {
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
      loadingRef.current = false
      setLastUpdated(dayjs())
      setCountdown(300) // 重置倒计时
      // 仅清理由本次请求创建的 controller，避免并发/竞态导致把新请求的 controller 清掉
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null
      }
    }
  }, [startDate, endDate, todayDate, isManager])

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

  // 自动刷新定时器（每5分钟）
  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    if (countdownRef.current) clearInterval(countdownRef.current)
    
    if (autoRefresh) {
      // 倒计时每秒更新
      countdownRef.current = setInterval(() => {
        setCountdown(prev => (prev <= 1 ? 300 : prev - 1))
      }, 1000)
      // 每5分钟自动刷新
      autoRefreshRef.current = setInterval(() => {
        fetchAll()
      }, 300000) // 5分钟
    }
    
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [autoRefresh, fetchAll])

  const handleShowMccCostDetail = async () => {
    if (!startDate || !endDate) {
      message.warning('请先选择时间范围')
      return
    }
    setMccModalVisible(true)
    setMccCostLoading(true)
    try {
      const res = await api.get('/api/expenses/cost-detail', {
        params: {
          start_date: startDate,
          end_date: endDate,
        },
      })
      setMccCostData(res.data || null)
    } catch (e) {
      message.error(e.response?.data?.detail || '获取MCC费用明细失败')
    } finally {
      setMccCostLoading(false)
    }
  }

  const platformColumns = [
    { title: '平台', dataIndex: 'platform_name', key: 'platform_name', width: 140 },
    { title: '累计佣金(总)', dataIndex: 'range_commission', key: 'range_commission', align: 'right' },
    { title: '累计已付佣金', dataIndex: 'range_paid_commission', key: 'range_paid_commission', align: 'right' },
    { title: '累计广告费用', dataIndex: 'range_ad_cost', key: 'range_ad_cost', align: 'right' },
    { title: '累计拒付佣金', dataIndex: 'range_rejected_commission', key: 'range_rejected_commission', align: 'right' },
    { title: '累计净利润', dataIndex: 'range_net_profit', key: 'range_net_profit', align: 'right' },
  ]

  const todayStr = dayjs().format('YYYY-MM-DD')
  const dailyColumns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 150, render: (v) => (
      <span>{v} {v === todayStr && <Tag color="processing" style={{ fontSize: 10, marginLeft: 4 }}><SyncOutlined spin /> 更新中</Tag>}</span>
    )},
    { title: '平台', dataIndex: 'platform_name', key: 'platform_name', width: 140 },
    { title: '佣金', dataIndex: 'commission', key: 'commission', align: 'right', render: (v) => Number(v || 0).toFixed(4) },
    { title: '广告费用', dataIndex: 'ad_cost', key: 'ad_cost', align: 'right', render: (v) => Number(v || 0).toFixed(4) },
    { title: '拒付佣金', dataIndex: 'rejected_commission', key: 'rejected_commission', align: 'right', render: (v) => Number(v || 0).toFixed(4) },
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
          <Button onClick={fetchAll} loading={loading} icon={<SyncOutlined spin={loading} />}>刷新</Button>
          <Tooltip title={autoRefresh ? '点击关闭自动刷新' : '点击开启自动刷新（每5分钟）'}>
            <Tag 
              color={autoRefresh ? 'processing' : 'default'} 
              style={{ cursor: 'pointer', fontSize: 12 }}
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? <><SyncOutlined spin /> 自动刷新 {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</> : '自动刷新已关闭'}
            </Tag>
          </Tooltip>
          {lastUpdated && (
            <span style={{ color: '#999', fontSize: 12 }}>
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              最后更新: {lastUpdated.format('HH:mm:ss')}
            </span>
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
            onClick={handleShowMccCostDetail}
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
              // 默认不全部展开：员工/平台多时一次性渲染大量 Table 会明显卡顿
              defaultActiveKey={[]}
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

          <Card title="按天明细">
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

      {/* MCC费用明细弹窗 */}
      <Modal
        open={mccModalVisible}
        title="MCC 费用明细（按账号）"
        onCancel={() => setMccModalVisible(false)}
        footer={null}
        width={800}
      >
        <Table
          rowKey="mcc_id"
          loading={mccCostLoading}
          dataSource={mccCostData?.mcc_breakdown || []}
          pagination={false}
          columns={[
            { title: 'MCC名称', dataIndex: 'mcc_name', key: 'mcc_name' },
            { title: '邮箱', dataIndex: 'email', key: 'email' },
            { title: 'API费用', dataIndex: 'api_cost', key: 'api_cost', align: 'right', render: (v) => Number(v || 0).toFixed(2) },
            { title: '手动费用', dataIndex: 'manual_cost', key: 'manual_cost', align: 'right', render: (v) => Number(v || 0).toFixed(2) },
            { title: '总费用', dataIndex: 'total_cost', key: 'total_cost', align: 'right', render: (v) => Number(v || 0).toFixed(2) },
          ]}
          summary={() => {
            const mccTotal = (mccCostData?.mcc_breakdown || []).reduce((sum, m) => sum + (m.total_cost || 0), 0)
            const unmatchedCost = mccCostData?.unmatched_cost || 0
            const grandTotal = mccTotal + unmatchedCost
            return (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={4}><strong>MCC费用小计</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right"><strong>{mccTotal.toFixed(2)}</strong></Table.Summary.Cell>
                </Table.Summary.Row>
                {unmatchedCost > 0 && (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={4}><span style={{ color: '#999' }}>未匹配平台费用（广告系列名未能识别平台）</span></Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right"><span style={{ color: '#999' }}>{unmatchedCost.toFixed(2)}</span></Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
                <Table.Summary.Row style={{ background: '#fafafa' }}>
                  <Table.Summary.Cell index={0} colSpan={4}><strong>总广告费用</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right"><strong style={{ color: '#1890ff' }}>{grandTotal.toFixed(2)}</strong></Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            )
          }}
        />
      </Modal>
    </div>
  )
}

export default Expenses


