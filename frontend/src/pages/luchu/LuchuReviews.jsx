/**
 * 露出审核管理页面
 */
import React, { useState, useEffect } from 'react'
import { 
  Card, Table, Button, Space, Tag, Modal, Input, 
  message, Typography, Empty
} from 'antd'
import { 
  CheckOutlined, CloseOutlined, EyeOutlined, 
  ExclamationCircleOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { 
  getPendingReviews, 
  approveArticle, 
  rejectArticle 
} from '../../services/luchuApi'
import dayjs from 'dayjs'

const { Title, Text } = Typography
const { TextArea } = Input

const LuchuReviews = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [articles, setArticles] = useState([])
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  
  // 驳回弹窗
  const [rejectModalVisible, setRejectModalVisible] = useState(false)
  const [rejectingId, setRejectingId] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    loadReviews()
  }, [pagination.current])

  const loadReviews = async () => {
    setLoading(true)
    try {
      const params = {
        page: pagination.current,
        page_size: pagination.pageSize
      }
      
      const response = await getPendingReviews(params)
      setArticles(response.data)
    } catch (error) {
      if (error.response?.status === 403) {
        message.warning('您没有审核权限')
      } else {
        console.error('加载审核列表失败:', error)
        message.error('加载审核列表失败')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (id) => {
    setActionLoading(true)
    try {
      await approveArticle(id)
      message.success('审核通过')
      loadReviews()
    } catch (error) {
      message.error(error.response?.data?.detail || '操作失败')
    } finally {
      setActionLoading(false)
    }
  }

  const openRejectModal = (id) => {
    setRejectingId(id)
    setRejectReason('')
    setRejectModalVisible(true)
  }

  const handleReject = async () => {
    if (!rejectReason.trim()) {
      message.error('请输入驳回原因')
      return
    }
    
    setActionLoading(true)
    try {
      await rejectArticle(rejectingId, rejectReason)
      message.success('已驳回')
      setRejectModalVisible(false)
      loadReviews()
    } catch (error) {
      message.error(error.response?.data?.detail || '操作失败')
    } finally {
      setActionLoading(false)
    }
  }

  const columns = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text, record) => (
        <a onClick={() => navigate(`/luchu/articles/${record.id}`)}>
          {text}
        </a>
      )
    },
    {
      title: '网站',
      dataIndex: 'website_name',
      key: 'website_name',
      width: 120
    },
    {
      title: '作者',
      dataIndex: 'author_name',
      key: 'author_name',
      width: 100
    },
    {
      title: '计划日期',
      dataIndex: 'publish_date',
      key: 'publish_date',
      width: 110,
      render: (date) => date || '-'
    },
    {
      title: '提交时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (date) => date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_, record) => (
        <Space size="small">
          <Button 
            size="small" 
            icon={<EyeOutlined />}
            onClick={() => navigate(`/luchu/articles/${record.id}`)}
          >
            查看
          </Button>
          <Button 
            size="small" 
            type="primary"
            icon={<CheckOutlined />}
            onClick={() => handleApprove(record.id)}
            loading={actionLoading}
          >
            通过
          </Button>
          <Button 
            size="small" 
            danger
            icon={<CloseOutlined />}
            onClick={() => openRejectModal(record.id)}
          >
            驳回
          </Button>
        </Space>
      )
    }
  ]

  return (
    <div style={{ padding: '24px' }}>
      <Title level={3} style={{ marginBottom: 24 }}>审核管理</Title>

      <Card>
        {articles.length === 0 && !loading ? (
          <Empty description="暂无待审核文章" />
        ) : (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={articles}
            loading={loading}
            pagination={{
              ...pagination,
              showSizeChanger: false,
              showTotal: (total) => `共 ${total} 篇待审核`
            }}
            onChange={(pag) => setPagination(pag)}
          />
        )}
      </Card>

      {/* 驳回弹窗 */}
      <Modal
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />
            驳回文章
          </Space>
        }
        open={rejectModalVisible}
        onCancel={() => setRejectModalVisible(false)}
        onOk={handleReject}
        confirmLoading={actionLoading}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
      >
        <div style={{ marginTop: 16 }}>
          <Text>请输入驳回原因（将通知作者）：</Text>
          <TextArea
            rows={4}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="请详细说明需要修改的内容..."
            style={{ marginTop: 8 }}
          />
        </div>
      </Modal>
    </div>
  )
}

export default LuchuReviews

