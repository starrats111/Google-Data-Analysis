/**
 * 露出功能仪表盘
 */
import React, { useState, useEffect } from 'react'
import { 
  Card, Row, Col, Statistic, List, Button, Badge, Tag, 
  Empty, Spin, message, Typography 
} from 'antd'
import { 
  FileTextOutlined, 
  CheckCircleOutlined, 
  ClockCircleOutlined,
  SendOutlined,
  BellOutlined,
  WarningOutlined,
  PlusOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { 
  getDashboardStats, 
  getNotifications, 
  getPublishTrend 
} from '../../services/luchuApi'

const { Title, Text } = Typography

const LuchuDashboard = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({
    my_articles: 0,
    pending_review: 0,
    ready_to_publish: 0,
    total_published: 0,
    unread_notifications: 0,
    image_alerts: 0
  })
  const [notifications, setNotifications] = useState([])
  const [trend, setTrend] = useState([])

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [statsRes, notifRes, trendRes] = await Promise.all([
        getDashboardStats(),
        getNotifications({ page: 1, page_size: 5 }),
        getPublishTrend()
      ])
      
      setStats(statsRes.data)
      setNotifications(notifRes.data)
      setTrend(trendRes.data)
    } catch (error) {
      console.error('加载数据失败:', error)
      message.error('加载数据失败')
    } finally {
      setLoading(false)
    }
  }

  const getNotificationIcon = (type) => {
    switch (type) {
      case 'review_approved':
        return <CheckCircleOutlined style={{ color: '#52c41a' }} />
      case 'review_rejected':
        return <WarningOutlined style={{ color: '#ff4d4f' }} />
      case 'publish_success':
        return <SendOutlined style={{ color: '#4DA6FF' }} />
      default:
        return <BellOutlined />
    }
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={3} style={{ margin: 0 }}>露出管理</Title>
        <Button 
          type="primary" 
          icon={<PlusOutlined />}
          onClick={() => navigate('/luchu/create')}
        >
          创建内容
        </Button>
      </div>

      {/* 统计卡片 */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => navigate('/luchu/articles')}>
            <Statistic
              title="我的文章"
              value={stats.my_articles}
              prefix={<FileTextOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => navigate('/luchu/reviews')}>
            <Statistic
              title="待审核"
              value={stats.pending_review}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ color: stats.pending_review > 0 ? '#faad14' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => navigate('/luchu/publish')}>
            <Statistic
              title="待发布"
              value={stats.ready_to_publish}
              prefix={<SendOutlined />}
              valueStyle={{ color: stats.ready_to_publish > 0 ? '#4DA6FF' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="已发布"
              value={stats.total_published}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card hoverable onClick={() => navigate('/luchu/notifications')}>
            <Statistic
              title="未读通知"
              value={stats.unread_notifications}
              prefix={<BellOutlined />}
              valueStyle={{ color: stats.unread_notifications > 0 ? '#ff4d4f' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card>
            <Statistic
              title="图片告警"
              value={stats.image_alerts}
              prefix={<WarningOutlined />}
              valueStyle={{ color: stats.image_alerts > 0 ? '#ff4d4f' : undefined }}
            />
          </Card>
        </Col>
      </Row>

      {/* 快捷操作 */}
      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} md={12}>
          <Card 
            title={
              <span>
                <BellOutlined style={{ marginRight: 8 }} />
                最新通知
                {stats.unread_notifications > 0 && (
                  <Badge count={stats.unread_notifications} style={{ marginLeft: 8 }} />
                )}
              </span>
            }
            extra={
              <Button type="link" onClick={() => navigate('/luchu/notifications')}>
                查看全部
              </Button>
            }
          >
            {notifications.length === 0 ? (
              <Empty description="暂无通知" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <List
                size="small"
                dataSource={notifications}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta
                      avatar={getNotificationIcon(item.type)}
                      title={
                        <span>
                          {!item.is_read && <Badge status="processing" />}
                          {item.title}
                        </span>
                      }
                      description={
                        <Text type="secondary" ellipsis>
                          {item.content}
                        </Text>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        
        <Col xs={24} md={12}>
          <Card title="快捷操作">
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Button 
                  block 
                  icon={<PlusOutlined />} 
                  onClick={() => navigate('/luchu/create')}
                >
                  创建内容
                </Button>
              </Col>
              <Col span={12}>
                <Button 
                  block 
                  icon={<FileTextOutlined />}
                  onClick={() => navigate('/luchu/articles')}
                >
                  我的文章
                </Button>
              </Col>
              <Col span={12}>
                <Button 
                  block 
                  icon={<ClockCircleOutlined />}
                  onClick={() => navigate('/luchu/reviews')}
                >
                  待审核
                </Button>
              </Col>
              <Col span={12}>
                <Button 
                  block 
                  icon={<SendOutlined />}
                  onClick={() => navigate('/luchu/publish')}
                >
                  待发布
                </Button>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      {/* 发布趋势 */}
      <Card title="本月发布趋势" style={{ marginTop: 24 }}>
        {trend.length === 0 ? (
          <Empty description="本月暂无发布" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {trend.map((item) => (
              <Tag key={item.date} color="blue">
                {item.date}: {item.count} 篇
              </Tag>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

export default LuchuDashboard

