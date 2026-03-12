import React, { useState, useEffect } from 'react'
import { Card, Table, Tag, Typography, Spin, Alert, Button, Space, Input, Divider, Row, Col, Statistic, message } from 'antd'
import { ExperimentOutlined, SyncOutlined, RobotOutlined, SendOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import ReactMarkdown from 'react-markdown'

const { TextArea } = Input

export default function TestDashboard() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState([])

  // AI 分析
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResult, setAiResult] = useState(null)
  const [aiQuestion, setAiQuestion] = useState('')

  const fetchData = async () => {
    setLoading(true)
    try {
      const res = await api.get('/api/ad-creation/test-dashboard')
      setData(res.data.items || [])
    } catch (err) {
      console.error(err)
    } finally { setLoading(false) }
  }

  useEffect(() => { fetchData() }, [])

  // 汇总指标
  const totalCost = data.reduce((s, r) => s + (r.ad_data?.cost || 0), 0)
  const totalClicks = data.reduce((s, r) => s + (r.ad_data?.clicks || 0), 0)
  const totalImpressions = data.reduce((s, r) => s + (r.ad_data?.impressions || 0), 0)
  const totalConversions = data.reduce((s, r) => s + (r.ad_data?.conversions || 0), 0)
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0
  const avgCpc = totalClicks > 0 ? (totalCost / totalClicks) : 0

  // AI 分析
  const handleAiAnalysis = async (question) => {
    if (data.length === 0) { message.warning('没有数据可分析'); return }
    setAiLoading(true)
    setAiResult(null)
    try {
      const res = await api.post('/api/ad-creation/ai-analysis', {
        items: data,
        question: question || aiQuestion || '',
      })
      setAiResult(res.data)
    } catch (err) {
      message.error(err?.response?.data?.detail || 'AI 分析失败')
    } finally { setAiLoading(false) }
  }

  const columns = [
    { title: '商家', dataIndex: 'merchant_name', width: 200 },
    { title: 'Campaign ID', dataIndex: 'campaign_id', width: 150, render: v => v || '-' },
    { title: 'CID', dataIndex: 'customer_id', width: 130 },
    { title: '日预算', dataIndex: 'daily_budget', width: 90, render: v => `$${v}` },
    { title: '国家', dataIndex: 'target_country', width: 70 },
    {
      title: '状态', width: 100,
      render: (_, r) => r.sync_pending
        ? <Tag icon={<SyncOutlined spin />} color="processing">同步中</Tag>
        : r.ad_data?.status
          ? <Tag color={r.ad_data.status === '已启用' ? 'green' : 'default'}>{r.ad_data.status}</Tag>
          : <Tag>未创建</Tag>
    },
    { title: '花费', width: 90, render: (_, r) => r.ad_data ? `$${r.ad_data.cost.toFixed(2)}` : '-' },
    { title: '点击', width: 70, render: (_, r) => r.ad_data?.clicks ?? '-' },
    { title: '展示', width: 80, render: (_, r) => r.ad_data?.impressions ?? '-' },
    { title: '转化', width: 70, render: (_, r) => r.ad_data ? r.ad_data.conversions.toFixed(1) : '-' },
    {
      title: 'CTR', width: 80,
      render: (_, r) => {
        if (!r.ad_data || !r.ad_data.impressions) return '-'
        return `${(r.ad_data.clicks / r.ad_data.impressions * 100).toFixed(2)}%`
      }
    },
    {
      title: 'CPC', width: 80,
      render: (_, r) => {
        if (!r.ad_data || !r.ad_data.clicks) return '-'
        return `$${(r.ad_data.cost / r.ad_data.clicks).toFixed(2)}`
      }
    },
    { title: '数据日期', width: 110, render: (_, r) => r.ad_data?.date || '-' },
  ]

  const quickQuestions = [
    '哪些广告表现最好？值得加大投入吗？',
    '哪些广告应该暂停或优化？',
    '预算分配是否合理？如何调整？',
    '整体 ROI 如何？有哪些改进空间？',
  ]

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={4}>
        <ExperimentOutlined /> 测试商家看板
      </Typography.Title>

      {/* 汇总指标 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Card size="small"><Statistic title="测试商家" value={data.length} suffix="个" /></Card>
        </Col>
        <Col span={4}>
          <Card size="small"><Statistic title="总花费" value={totalCost} precision={2} prefix="$" valueStyle={{ color: '#cf1322' }} /></Card>
        </Col>
        <Col span={4}>
          <Card size="small"><Statistic title="总点击" value={totalClicks} /></Card>
        </Col>
        <Col span={4}>
          <Card size="small"><Statistic title="总展示" value={totalImpressions} /></Card>
        </Col>
        <Col span={4}>
          <Card size="small"><Statistic title="平均 CTR" value={avgCtr} precision={2} suffix="%" /></Card>
        </Col>
        <Col span={4}>
          <Card size="small"><Statistic title="平均 CPC" value={avgCpc} precision={2} prefix="$" /></Card>
        </Col>
      </Row>

      {/* 数据表格 */}
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Button onClick={fetchData} icon={<SyncOutlined />}>刷新</Button>
          <Button type="primary" onClick={() => navigate('/merchant-management')}>去领取商家</Button>
          <Button
            icon={<RobotOutlined />}
            style={{ background: '#722ed1', borderColor: '#722ed1', color: '#fff' }}
            onClick={() => handleAiAnalysis()}
            loading={aiLoading}
          >
            AI 智能分析 (Claude Opus)
          </Button>
        </Space>
        <Spin spinning={loading}>
          <Table
            dataSource={data}
            columns={columns}
            rowKey="assignment_id"
            size="small"
            pagination={false}
            scroll={{ x: 1400 }}
          />
        </Spin>
      </Card>

      {/* AI 分析区域 */}
      <Card
        title={<><RobotOutlined style={{ color: '#722ed1' }} /> AI 广告分析 <Tag color="purple">Claude Opus</Tag></>}
        style={{ marginTop: 16 }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {/* 快捷问题 */}
          <div>
            <Typography.Text type="secondary" style={{ marginRight: 8 }}>快捷提问：</Typography.Text>
            {quickQuestions.map((q, i) => (
              <Button
                key={i}
                size="small"
                style={{ marginRight: 8, marginBottom: 4 }}
                onClick={() => { setAiQuestion(q); handleAiAnalysis(q) }}
                disabled={aiLoading}
              >
                {q}
              </Button>
            ))}
          </div>

          {/* 自定义问题 */}
          <Space.Compact style={{ width: '100%' }}>
            <TextArea
              placeholder="输入你的问题，例如：这些广告的转化率如何？应该如何优化出价？"
              value={aiQuestion}
              onChange={e => setAiQuestion(e.target.value)}
              autoSize={{ minRows: 1, maxRows: 3 }}
              style={{ flex: 1 }}
              onPressEnter={e => { if (!e.shiftKey) { e.preventDefault(); handleAiAnalysis() } }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => handleAiAnalysis()}
              loading={aiLoading}
              style={{ height: 'auto' }}
            >
              发送
            </Button>
          </Space.Compact>

          {/* AI 结果 */}
          {aiLoading && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin tip="Claude Opus 正在分析广告数据..." />
            </div>
          )}
          {aiResult && (
            <Card
              size="small"
              style={{ background: '#f9f0ff', border: '1px solid #d3adf7' }}
              title={
                <Space>
                  <ThunderboltOutlined style={{ color: '#722ed1' }} />
                  <span>分析结果</span>
                  <Tag color="purple" style={{ fontSize: 10 }}>{aiResult.model}</Tag>
                  <Tag>{aiResult.items_analyzed} 个广告</Tag>
                </Space>
              }
            >
              <div style={{ lineHeight: 1.8 }}>
                <ReactMarkdown>{aiResult.analysis}</ReactMarkdown>
              </div>
            </Card>
          )}
        </Space>
      </Card>
    </div>
  )
}
