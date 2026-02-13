/**
 * 露出发布管理页面
 */
import React, { useState, useEffect } from 'react'
import { 
  Card, Table, Button, Space, Tag, Modal, Input, 
  message, Typography, Empty, Result, Spin
} from 'antd'
import { 
  SendOutlined, EyeOutlined, CheckCircleOutlined,
  ExportOutlined, LoadingOutlined
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getReadyToPublish, publishArticle } from '../../services/luchuApi'
import dayjs from 'dayjs'

const { Title, Text, Link } = Typography

const LuchuPublish = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [articles, setArticles] = useState([])
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })
  
  // 发布中状态
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState(null)
  const [publishModalVisible, setPublishModalVisible] = useState(false)

  useEffect(() => {
    loadArticles()
  }, [pagination.current])

  const loadArticles = async () => {
    setLoading(true)
    try {
      const params = {
        page: pagination.current,
        page_size: pagination.pageSize
      }
      
      const response = await getReadyToPublish(params)
      setArticles(response.data)
    } catch (error) {
      console.error('加载待发布列表失败:', error)
      message.error('加载待发布列表失败')
    } finally {
      setLoading(false)
    }
  }

  const handlePublish = async (id, title) => {
    setPublishing(true)
    setPublishResult(null)
    setPublishModalVisible(true)
    
    try {
      const response = await publishArticle(id)
      
      if (response.data.success) {
        setPublishResult({
          success: true,
          title: title,
          commit_sha: response.data.commit_sha,
          article_url: response.data.article_url
        })
        loadArticles()
      } else {
        setPublishResult({
          success: false,
          title: title,
          error: response.data.error
        })
      }
    } catch (error) {
      setPublishResult({
        success: false,
        title: title,
        error: error.response?.data?.detail || error.message || '发布失败'
      })
    } finally {
      setPublishing(false)
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
      title: '审核时间',
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
          >
            预览
          </Button>
          <Button 
            size="small" 
            type="primary"
            icon={<SendOutlined />}
            onClick={() => handlePublish(record.id, record.title)}
          >
            发布
          </Button>
        </Space>
      )
    }
  ]

  return (
    <div style={{ padding: '24px' }}>
      <Title level={3} style={{ marginBottom: 24 }}>发布管理</Title>

      <Card>
        {articles.length === 0 && !loading ? (
          <Empty description="暂无待发布文章" />
        ) : (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={articles}
            loading={loading}
            pagination={{
              ...pagination,
              showSizeChanger: false,
              showTotal: (total) => `共 ${total} 篇待发布`
            }}
            onChange={(pag) => setPagination(pag)}
          />
        )}
      </Card>

      {/* 发布结果弹窗 */}
      <Modal
        title="发布文章"
        open={publishModalVisible}
        onCancel={() => !publishing && setPublishModalVisible(false)}
        footer={publishing ? null : (
          <Button type="primary" onClick={() => setPublishModalVisible(false)}>
            关闭
          </Button>
        )}
        closable={!publishing}
        maskClosable={!publishing}
      >
        {publishing ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 48 }} spin />} />
            <div style={{ marginTop: 24 }}>
              <Text>正在发布到 GitHub...</Text>
            </div>
          </div>
        ) : publishResult ? (
          publishResult.success ? (
            <Result
              status="success"
              title="发布成功"
              subTitle={publishResult.title}
              extra={[
                publishResult.article_url && (
                  <Button 
                    key="view" 
                    type="primary" 
                    icon={<ExportOutlined />}
                    onClick={() => window.open(publishResult.article_url, '_blank')}
                  >
                    查看文章
                  </Button>
                ),
                <Button key="close" onClick={() => setPublishModalVisible(false)}>
                  关闭
                </Button>
              ]}
            >
              {publishResult.commit_sha && (
                <div>
                  <Text type="secondary">
                    Commit: {publishResult.commit_sha.substring(0, 7)}
                  </Text>
                </div>
              )}
            </Result>
          ) : (
            <Result
              status="error"
              title="发布失败"
              subTitle={publishResult.title}
              extra={[
                <Button key="retry" type="primary" onClick={() => setPublishModalVisible(false)}>
                  关闭
                </Button>
              ]}
            >
              <div>
                <Text type="danger">{publishResult.error}</Text>
              </div>
            </Result>
          )
        ) : null}
      </Modal>
    </div>
  )
}

export default LuchuPublish

