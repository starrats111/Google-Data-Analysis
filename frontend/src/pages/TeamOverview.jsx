import React, { useState, useEffect } from 'react'
import { 
  Card, Table, Tag, Statistic, Row, Col, Progress, Typography, Spin, Empty, Space, Select, DatePicker, Button, message, Dropdown
} from 'antd'
import { 
  TeamOutlined, UserOutlined, TrophyOutlined, DollarOutlined, ReloadOutlined, SyncOutlined, CloudSyncOutlined, DownOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

const TeamOverview = () => {
  const { permissions } = useAuth()
  const teamInfo = permissions?.team
  
  // 数据状态
  const [teamStats, setTeamStats] = useState([])
  const [memberRanking, setMemberRanking] = useState([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [dateRange, setDateRange] = useState([
    dayjs().subtract(7, 'day'),
    dayjs()
  ])

  // 加载数据
  const loadData = async () => {
    setLoading(true)
    try {
      const params = {}
      if (dateRange && dateRange[0] && dateRange[1]) {
        params.start_date = dateRange[0].format('YYYY-MM-DD')
        params.end_date = dateRange[1].format('YYYY-MM-DD')
      }
      
      const [statsRes, rankingRes] = await Promise.all([
        api.get('/api/team/stats/teams', { params }),
        api.get('/api/team/stats/ranking', { params: { ...params, limit: 20 } })
      ])
      setTeamStats(statsRes.data)
      setMemberRanking(rankingRes.data)
    } catch (error) {
      console.error('加载数据失败:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [dateRange])

  // 同步团队数据
  const handleSync = async (syncType = 'all') => {
    setSyncing(true)
    message.loading({ content: '正在启动数据同步...', key: 'sync', duration: 0 })
    
    try {
      const response = await api.post('/api/team/sync-team-data', null, {
        params: { sync_type: syncType }
      })
      
      if (response.data.background) {
        message.success({
          content: `${response.data.message}`,
          key: 'sync',
          duration: 5
        })
      } else {
        message.success({
          content: response.data.message,
          key: 'sync'
        })
      }
      
      // 延迟刷新数据
      setTimeout(() => loadData(), 2000)
      
    } catch (error) {
      console.error('同步失败:', error)
      message.error({
        content: `同步失败: ${error.response?.data?.detail || error.message}`,
        key: 'sync'
      })
    } finally {
      setSyncing(false)
    }
  }

  // 同步菜单项
  const syncMenuItems = [
    { key: 'all', label: '同步全部数据', icon: <CloudSyncOutlined /> },
    { key: 'platform', label: '仅同步平台数据', icon: <SyncOutlined /> },
    { key: 'google', label: '仅同步广告数据', icon: <SyncOutlined /> }
  ]

  // 获取当前组的统计
  const currentTeamStats = teamStats.length > 0 ? teamStats[0] : null

  return (
    <div>
      <Title level={3}>
        <TeamOutlined style={{ marginRight: 12 }} />
        {teamInfo?.name || '小组'}总览
      </Title>

      {/* 筛选栏 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space>
          <Text>日期范围：</Text>
          <RangePicker 
            value={dateRange}
            onChange={setDateRange}
            allowClear={false}
          />
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
          <Dropdown
            menu={{
              items: syncMenuItems,
              onClick: ({ key }) => handleSync(key)
            }}
            disabled={syncing}
          >
            <Button type="primary" icon={<CloudSyncOutlined />} loading={syncing}>
              同步最新数据 <DownOutlined />
            </Button>
          </Dropdown>
        </Space>
      </Card>

      <Spin spinning={loading}>
        {/* 小组统计卡片 */}
        {currentTeamStats && (
          <Card 
            style={{ 
              marginBottom: 24,
              borderLeft: `4px solid ${currentTeamStats.avg_roi >= 0 ? '#52c41a' : '#ff4d4f'}`
            }}
          >
            <Row gutter={24}>
              <Col xs={24} sm={12} md={6}>
                <Statistic 
                  title="小组成员" 
                  value={currentTeamStats.member_count} 
                  suffix="人"
                  prefix={<TeamOutlined />}
                />
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Statistic 
                  title="总费用" 
                  value={currentTeamStats.total_cost} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#cf1322' }}
                />
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Statistic 
                  title="总佣金" 
                  value={currentTeamStats.total_commission} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#3f8600' }}
                />
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Statistic 
                  title="总利润" 
                  value={currentTeamStats.total_profit} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: currentTeamStats.total_profit >= 0 ? '#3f8600' : '#cf1322' }}
                />
              </Col>
            </Row>
            <div style={{ marginTop: 16 }}>
              <Text type="secondary">平均 ROI</Text>
              <Progress 
                percent={Math.min(Math.abs(currentTeamStats.avg_roi), 100)} 
                status={currentTeamStats.avg_roi >= 0 ? 'success' : 'exception'}
                format={() => `${currentTeamStats.avg_roi}%`}
                strokeWidth={12}
              />
            </div>
          </Card>
        )}

        {/* 成员排行榜 */}
        <Card 
          title={<><TrophyOutlined style={{ marginRight: 8, color: '#faad14' }} />组员排行榜 (按ROI)</>}
        >
          {memberRanking.length > 0 ? (
            <Table
              dataSource={memberRanking}
              rowKey="user_id"
              pagination={false}
              columns={[
                {
                  title: '排名',
                  key: 'rank',
                  width: 80,
                  render: (_, __, index) => {
                    if (index === 0) return <Tag color="gold">🥇 1</Tag>
                    if (index === 1) return <Tag color="default">🥈 2</Tag>
                    if (index === 2) return <Tag color="orange">🥉 3</Tag>
                    return <Tag>{index + 1}</Tag>
                  }
                },
                {
                  title: '组员',
                  dataIndex: 'username',
                  key: 'username',
                  render: (text, record) => (
                    <Space>
                      <UserOutlined />
                      <Text strong>{record.display_name || text}</Text>
                    </Space>
                  )
                },
                {
                  title: '费用',
                  dataIndex: 'cost',
                  key: 'cost',
                  align: 'right',
                  render: (v) => <Text type="danger">${v.toFixed(2)}</Text>
                },
                {
                  title: '佣金',
                  dataIndex: 'commission',
                  key: 'commission',
                  align: 'right',
                  render: (v) => <Text type="success">${v.toFixed(2)}</Text>
                },
                {
                  title: '利润',
                  dataIndex: 'profit',
                  key: 'profit',
                  align: 'right',
                  render: (v) => (
                    <Text style={{ color: v >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>
                      {v >= 0 ? '+' : ''}${v.toFixed(2)}
                    </Text>
                  )
                },
                {
                  title: 'ROI',
                  dataIndex: 'roi',
                  key: 'roi',
                  align: 'right',
                  render: (v) => (
                    <Tag color={v >= 20 ? 'success' : v >= 0 ? 'processing' : 'error'} style={{ fontSize: 14 }}>
                      {v >= 0 ? '+' : ''}{v.toFixed(1)}%
                    </Tag>
                  )
                }
              ]}
            />
          ) : (
            <Empty description="暂无数据" />
          )}
        </Card>
      </Spin>
    </div>
  )
}

export default TeamOverview

