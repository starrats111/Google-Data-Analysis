import React, { useState, useEffect, useCallback } from 'react'
import { Card, Table, Tag, Button, Space, Modal, Input, message, Badge, Typography, Tooltip, Empty } from 'antd'
import { MessageOutlined, CheckCircleOutlined, ClockCircleOutlined, SendOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { TextArea } = Input
const { Text, Paragraph } = Typography

const FEEDBACK_TYPE_COLORS = {
  '数据误差': 'orange',
  '功能体验': 'blue',
  '功能异常': 'red',
  '功能建议': 'green',
  '其他': 'default',
}

export default function FeedbackManage() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState([])
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [filterRead, setFilterRead] = useState(undefined)

  const [replyModalOpen, setReplyModalOpen] = useState(false)
  const [currentFeedback, setCurrentFeedback] = useState(null)
  const [replies, setReplies] = useState([])
  const [repliesLoading, setRepliesLoading] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)

  const fetchFeedback = useCallback(async (page = 1, pageSize = 20) => {
    setLoading(true)
    try {
      const params = { page, page_size: pageSize }
      if (filterRead !== undefined) params.is_read = filterRead
      const res = await api.get('/api/feedback', { params })
      setData(res.data.items || [])
      setPagination({ current: res.data.page, pageSize: res.data.page_size, total: res.data.total })
    } catch (err) {
      message.error('加载反馈列表失败')
    } finally {
      setLoading(false)
    }
  }, [filterRead])

  useEffect(() => {
    fetchFeedback()
  }, [fetchFeedback])

  const openReplyModal = async (record) => {
    setCurrentFeedback(record)
    setReplyModalOpen(true)
    setReplyText('')
    setRepliesLoading(true)
    try {
      const res = await api.get(`/api/feedback/${record.id}/replies`)
      setReplies(res.data.replies || [])
    } catch {
      setReplies([])
    } finally {
      setRepliesLoading(false)
    }
  }

  const handleReply = async () => {
    if (!replyText.trim()) return
    setReplying(true)
    try {
      await api.post(`/api/feedback/${currentFeedback.id}/reply`, { content: replyText.trim() })
      message.success('回复已发送')
      setReplyText('')
      const res = await api.get(`/api/feedback/${currentFeedback.id}/replies`)
      setReplies(res.data.replies || [])
      fetchFeedback(pagination.current, pagination.pageSize)
    } catch (err) {
      message.error(`回复失败: ${err.response?.data?.detail || err.message}`)
    } finally {
      setReplying(false)
    }
  }

  const extractType = (title) => {
    if (!title) return '其他'
    const parts = title.split('｜')
    return parts.length >= 2 ? parts[1] : '其他'
  }

  const handleMarkRead = async (id) => {
    try {
      await api.patch(`/api/feedback/${id}/mark-read`)
      message.success('已标记为已处理')
      fetchFeedback(pagination.current, pagination.pageSize)
    } catch (err) {
      message.error(err.response?.data?.detail || '操作失败')
    }
  }

  const handleMarkUnread = async (id) => {
    try {
      await api.patch(`/api/feedback/${id}/mark-unread`)
      message.success('已标记为待处理')
      fetchFeedback(pagination.current, pagination.pageSize)
    } catch (err) {
      message.error(err.response?.data?.detail || '操作失败')
    }
  }

  const isFeedbackManager = user?.username === 'wj07' || user?.role === 'manager'

  const columns = [
    {
      title: '状态',
      dataIndex: 'is_read',
      width: 90,
      align: 'center',
      render: (read) => read
        ? <Tag icon={<CheckCircleOutlined />} color="success">已处理</Tag>
        : <Tag icon={<ClockCircleOutlined />} color="warning">待处理</Tag>,
    },
    {
      title: '类型',
      key: 'type',
      width: 90,
      align: 'center',
      render: (_, r) => {
        const t = extractType(r.title)
        return <Tag color={FEEDBACK_TYPE_COLORS[t] || 'default'}>{t}</Tag>
      },
    },
    {
      title: '提交人',
      dataIndex: 'sender_name',
      width: 90,
      align: 'center',
    },
    {
      title: '反馈内容',
      dataIndex: 'title',
      ellipsis: true,
      render: (title, record) => (
        <Space direction="vertical" size={0}>
          <Text strong ellipsis={{ tooltip: title }}>{title || '-'}</Text>
          {record.reply_count > 0 && <Text type="secondary" style={{ fontSize: 12 }}>{record.reply_count} 条回复</Text>}
        </Space>
      ),
    },
    {
      title: '提交时间',
      dataIndex: 'created_at',
      width: 160,
      align: 'center',
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      align: 'center',
      render: (_, record) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<MessageOutlined />} onClick={() => openReplyModal(record)}>
            查看
          </Button>
          {isFeedbackManager && (
            record.is_read ? (
              <Button type="link" size="small" onClick={() => handleMarkUnread(record.id)} style={{ color: '#faad14' }}>
                撤回处理
              </Button>
            ) : (
              <Button type="link" size="small" onClick={() => handleMarkRead(record.id)} style={{ color: '#52c41a' }}>
                <CheckCircleOutlined /> 确认处理
              </Button>
            )
          )}
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="反馈管理"
      extra={
        <Space>
          <Button.Group>
            <Button type={filterRead === undefined ? 'primary' : 'default'} onClick={() => setFilterRead(undefined)}>全部</Button>
            <Button type={filterRead === false ? 'primary' : 'default'} onClick={() => setFilterRead(false)}>待处理</Button>
            <Button type={filterRead === true ? 'primary' : 'default'} onClick={() => setFilterRead(true)}>已处理</Button>
          </Button.Group>
          <Button icon={<ReloadOutlined />} onClick={() => fetchFeedback(pagination.current, pagination.pageSize)}>刷新</Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        pagination={{
          ...pagination,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条反馈`,
          onChange: (p, ps) => fetchFeedback(p, ps),
        }}
      />

      <Modal
        title={currentFeedback?.title || '反馈详情'}
        open={replyModalOpen}
        onCancel={() => setReplyModalOpen(false)}
        footer={null}
        width={640}
        destroyOnClose
      >
        {currentFeedback && (
          <div>
            <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
              <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{currentFeedback.content}</Paragraph>
              <div style={{ marginTop: 8, textAlign: 'right' }}>
                <Text type="secondary">{currentFeedback.sender_name} · {currentFeedback.created_at ? dayjs(currentFeedback.created_at).format('YYYY-MM-DD HH:mm') : ''}</Text>
              </div>
            </Card>

            {repliesLoading ? (
              <div style={{ textAlign: 'center', padding: 20 }}><Text type="secondary">加载回复中...</Text></div>
            ) : replies.length > 0 ? (
              <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 16 }}>
                {replies.map((r) => {
                  const isMe = r.sender_id === user?.id
                  return (
                    <div
                      key={r.id}
                      style={{
                        display: 'flex',
                        justifyContent: isMe ? 'flex-end' : 'flex-start',
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          maxWidth: '75%',
                          padding: '8px 12px',
                          borderRadius: 8,
                          background: isMe ? '#e6f7ff' : '#f5f5f5',
                          border: `1px solid ${isMe ? '#91d5ff' : '#e8e8e8'}`,
                        }}
                      >
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                          {r.sender_name} · {r.created_at ? dayjs(r.created_at).format('MM-DD HH:mm') : ''}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap' }}>{r.content}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <Empty description="暂无回复" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '12px 0' }} />
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <TextArea
                rows={2}
                placeholder="输入回复内容..."
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onPressEnter={(e) => { if (e.ctrlKey) handleReply() }}
                style={{ flex: 1 }}
              />
              <Button
                type="primary"
                icon={<SendOutlined />}
                loading={replying}
                onClick={handleReply}
                disabled={!replyText.trim()}
                style={{ alignSelf: 'flex-end' }}
              >
                发送
              </Button>
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: '#999' }}>Ctrl + Enter 快捷发送</div>
          </div>
        )}
      </Modal>
    </Card>
  )
}
