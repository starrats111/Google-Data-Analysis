/**
 * 露出文章列表
 */
import React, { useState, useEffect } from 'react'
import { 
  Card, Table, Button, Space, Tag, Input, Select, 
  Popconfirm, message, Typography 
} from 'antd'
import { 
  PlusOutlined, EditOutlined, DeleteOutlined, 
  SendOutlined, EyeOutlined, SearchOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getArticles, deleteArticle, submitArticle } from '../../services/luchuApi'
import dayjs from 'dayjs'

const { Title } = Typography

const statusConfig = {
  draft: { color: 'default', text: '草稿' },
  pending: { color: 'orange', text: '审核中' },
  approved: { color: 'cyan', text: '已通过' },
  rejected: { color: 'red', text: '已驳回' },
  ready: { color: 'blue', text: '待发布' },
  published: { color: 'green', text: '已发布' }
}

const LuchuArticles = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [articles, setArticles] = useState([])
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  const [filters, setFilters] = useState({ status: null, search: '' })

  useEffect(() => {
    loadArticles()
  }, [pagination.current, filters.status])

  const loadArticles = async () => {
    setLoading(true)
    try {
      const params = {
        page: pagination.current,
        page_size: pagination.pageSize,
        ...(filters.status && { status: filters.status })
      }
      
      const response = await getArticles(params)
      setArticles(response.data)
      setPagination(prev => ({ ...prev, total: response.data.length }))
    } catch (error) {
      console.error('加载文章失败:', error)
      message.error('加载文章失败')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id) => {
    try {
      await deleteArticle(id)
      message.success('删除成功')
      loadArticles()
    } catch (error) {
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  const handleSubmit = async (id) => {
    try {
      await submitArticle(id)
      message.success('已提交审核')
      loadArticles()
    } catch (error) {
      message.error(error.response?.data?.detail || '提交失败')
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
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => {
        const config = statusConfig[status] || { color: 'default', text: status }
        return <Tag color={config.color}>{config.text}</Tag>
      }
    },
    {
      title: '网站',
      dataIndex: 'website_name',
      key: 'website_name',
      width: 120
    },
    {
      title: '计划日期',
      dataIndex: 'publish_date',
      key: 'publish_date',
      width: 110,
      render: (date) => date || '-'
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (date) => date ? dayjs(date).format('YYYY-MM-DD HH:mm') : '-'
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space size="small">
          <Button 
            size="small" 
            icon={<EyeOutlined />}
            onClick={() => navigate(`/luchu/articles/${record.id}`)}
          />
          
          {record.status === 'draft' && (
            <>
              <Button 
                size="small" 
                icon={<EditOutlined />}
                onClick={() => navigate(`/luchu/articles/${record.id}/edit`)}
              />
              <Button 
                size="small" 
                type="primary"
                icon={<SendOutlined />}
                onClick={() => handleSubmit(record.id)}
              >
                提交
              </Button>
            </>
          )}
          
          {record.status === 'rejected' && (
            <Button 
              size="small" 
              icon={<EditOutlined />}
              onClick={() => navigate(`/luchu/articles/${record.id}/edit`)}
            >
              修改
            </Button>
          )}
          
          {['draft', 'rejected'].includes(record.status) && (
            <Popconfirm
              title="确定删除?"
              onConfirm={() => handleDelete(record.id)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      )
    }
  ]

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={3} style={{ margin: 0 }}>我的文章</Title>
        <Button 
          type="primary" 
          icon={<PlusOutlined />}
          onClick={() => navigate('/luchu/create')}
        >
          创建内容
        </Button>
      </div>

      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Select
            placeholder="状态筛选"
            allowClear
            style={{ width: 120 }}
            value={filters.status}
            onChange={(value) => {
              setFilters(prev => ({ ...prev, status: value }))
              setPagination(prev => ({ ...prev, current: 1 }))
            }}
          >
            {Object.entries(statusConfig).map(([key, config]) => (
              <Select.Option key={key} value={key}>
                {config.text}
              </Select.Option>
            ))}
          </Select>
          
          <Button icon={<SearchOutlined />} onClick={loadArticles}>
            刷新
          </Button>
        </Space>

        <Table
          rowKey="id"
          columns={columns}
          dataSource={articles}
          loading={loading}
          pagination={{
            ...pagination,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 篇`
          }}
          onChange={(pag) => setPagination(pag)}
        />
      </Card>
    </div>
  )
}

export default LuchuArticles

