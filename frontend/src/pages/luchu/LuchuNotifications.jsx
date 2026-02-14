/**
 * 露出通知列表
 */
import React, { useState, useEffect } from 'react'
import { 
  Card, List, Button, Space, Badge, Switch, 
  message, Typography, Empty
} from 'antd'
import { 
  CheckCircleOutlined, CloseCircleOutlined, 
  SendOutlined, BellOutlined, WarningOutlined,
  CheckOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { 
  getNotifications, 
  markAsRead, 
  markAllAsRead 
} from '../../services/luchuApi'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

const { Title, Text } = Typography

const getNotificationIcon = (type) => {
  switch (type) {
    case 'review_approved':
      return <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 24 }} />
    case 'review_rejected':
      return <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 24 }} />
    case 'publish_success':
      return <SendOutlined style={{ color: '#4DA6FF', fontSize: 24 }} />
    case 'image_alert':
      return <WarningOutlined style={{ color: '#faad14', fontSize: 24 }} />
    default:
      return <BellOutlined style={{ color: '#666', fontSize: 24 }} />
  }
}

const LuchuNotifications = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20 })

  useEffect(() => {
    loadNotifications()
  }, [pagination.current, unreadOnly])

  const loadNotifications = async () => {
    setLoading(true)
    try {
      const params = {
        page: pagination.current,
        page_size: pagination.pageSize,
        unread_only: unreadOnly
      }
      
      const response = await getNotifications(params)
      setNotifications(response.data)
    } catch (error) {
      console.error('加载通知失败:', error)
      message.error('加载通知失败')
    } finally {
      setLoading(false)
    }
  }

  const handleMarkRead = async (id) => {
    try {
      await markAsRead(id)
      setNotifications(prev => 
        prev.map(n => n.id === id ? { ...n, is_read: true } : n)
      )
    } catch (error) {
      message.error('操作失败')
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await markAllAsRead()
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
      message.success('已全部标记为已读')
    } catch (error) {
      message.error('操作失败')
    }
  }

  const handleClick = (item) => {
    // 先标记已读
    if (!item.is_read) {
      handleMarkRead(item.id)
    }
    
    // 跳转到相关页面
    if (item.related_type === 'article' && item.related_id) {
      navigate(`/luchu/articles/${item.related_id}`)
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={3} style={{ margin: 0 }}>通知中心</Title>
        <Space>
          <Switch
            checkedChildren="未读"
            unCheckedChildren="全部"
            checked={unreadOnly}
            onChange={setUnreadOnly}
          />
          <Button 
            icon={<CheckOutlined />}
            onClick={handleMarkAllRead}
          >
            全部已读
          </Button>
        </Space>
      </div>

      <Card>
        {notifications.length === 0 ? (
          <Empty description={unreadOnly ? '没有未读通知' : '暂无通知'} />
        ) : (
          <List
            loading={loading}
            itemLayout="horizontal"
            dataSource={notifications}
            renderItem={(item) => (
              <List.Item
                style={{ 
                  cursor: 'pointer',
                  backgroundColor: item.is_read ? 'transparent' : 'rgba(24, 144, 255, 0.05)',
                  padding: '16px',
                  borderRadius: 4,
                  marginBottom: 8
                }}
                onClick={() => handleClick(item)}
                actions={[
                  !item.is_read && (
                    <Button 
                      size="small" 
                      type="link"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleMarkRead(item.id)
                      }}
                    >
                      标为已读
                    </Button>
                  )
                ].filter(Boolean)}
              >
                <List.Item.Meta
                  avatar={
                    <Badge dot={!item.is_read}>
                      {getNotificationIcon(item.type)}
                    </Badge>
                  }
                  title={
                    <Text strong={!item.is_read}>
                      {item.title}
                    </Text>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      <Text type="secondary">{item.content}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(item.created_at).fromNow()}
                      </Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
            pagination={{
              ...pagination,
              onChange: (page) => setPagination(prev => ({ ...prev, current: page })),
              showSizeChanger: false
            }}
          />
        )}
      </Card>
    </div>
  )
}

export default LuchuNotifications

