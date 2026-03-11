import React, { useState, useEffect } from 'react'
import { Card, Table, Tag, Typography, Spin, Alert, Button, Space } from 'antd'
import { ExperimentOutlined, SyncOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'

export default function TestDashboard() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState([])

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
    { title: '数据日期', width: 110, render: (_, r) => r.ad_data?.date || '-' },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={4}>
        <ExperimentOutlined /> 测试商家看板
      </Typography.Title>
      <Alert
        type="info"
        message="测试看板只展示广告侧数据（花费/点击/展示/转化），平台佣金在主数据中心查看"
        style={{ marginBottom: 16 }}
        showIcon
      />
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Button onClick={fetchData} icon={<SyncOutlined />}>刷新</Button>
          <Button type="primary" onClick={() => navigate('/merchants')}>去领取商家</Button>
        </Space>
        <Spin spinning={loading}>
          <Table
            dataSource={data}
            columns={columns}
            rowKey="assignment_id"
            size="small"
            pagination={false}
          />
        </Spin>
      </Card>
    </div>
  )
}
