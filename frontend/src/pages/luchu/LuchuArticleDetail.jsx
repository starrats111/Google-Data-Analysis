/**
 * 露出文章详情
 */
import React, { useState, useEffect } from 'react'
import { 
  Card, Row, Col, Button, Space, Tag, Descriptions, 
  Spin, message, Typography, Image, List, Divider,
  Timeline, Modal, Input, Popconfirm
} from 'antd'
import { 
  EditOutlined, SendOutlined, CheckOutlined, 
  RollbackOutlined, HistoryOutlined, EyeOutlined,
  ArrowLeftOutlined
} from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import { 
  getArticle, 
  submitArticle, 
  getArticleVersions,
  restoreVersion,
  selfCheckArticle,
  getProxyImageUrl
} from '../../services/luchuApi'
import dayjs from 'dayjs'

const { Title, Paragraph, Text } = Typography

const statusConfig = {
  draft: { color: 'default', text: '草稿' },
  pending: { color: 'orange', text: '审核中' },
  approved: { color: 'cyan', text: '已通过' },
  rejected: { color: 'red', text: '已驳回' },
  ready: { color: 'blue', text: '待发布' },
  published: { color: 'green', text: '已发布' }
}

const LuchuArticleDetail = () => {
  const { id } = useParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [article, setArticle] = useState(null)
  const [versions, setVersions] = useState([])
  const [showVersions, setShowVersions] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  
  // 当前用户信息（简化，实际应从 store 获取）
  const currentUser = JSON.parse(localStorage.getItem('user') || '{}')
  const canSelfCheck = ['wj02', 'wj07'].includes(currentUser.username) || currentUser.role === 'manager'

  useEffect(() => {
    loadArticle()
  }, [id])

  const loadArticle = async () => {
    setLoading(true)
    try {
      const response = await getArticle(id)
      setArticle(response.data)
    } catch (error) {
      console.error('加载文章失败:', error)
      message.error('加载文章失败')
    } finally {
      setLoading(false)
    }
  }

  const loadVersions = async () => {
    try {
      const response = await getArticleVersions(id)
      setVersions(response.data)
      setShowVersions(true)
    } catch (error) {
      message.error('加载版本历史失败')
    }
  }

  const handleSubmit = async () => {
    setActionLoading(true)
    try {
      await submitArticle(id)
      message.success('已提交审核')
      loadArticle()
    } catch (error) {
      message.error(error.response?.data?.detail || '提交失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleSelfCheck = async () => {
    setActionLoading(true)
    try {
      await selfCheckArticle(id)
      message.success('自检通过，文章已进入待发布状态')
      loadArticle()
    } catch (error) {
      message.error(error.response?.data?.detail || '自检失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleRestore = async (versionNumber) => {
    setActionLoading(true)
    try {
      await restoreVersion(id, versionNumber)
      message.success(`已恢复到版本 ${versionNumber}`)
      setShowVersions(false)
      loadArticle()
    } catch (error) {
      message.error(error.response?.data?.detail || '恢复失败')
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (!article) {
    return null
  }

  const config = statusConfig[article.status] || { color: 'default', text: article.status }
  const images = article.images || {}
  const products = article.products || []

  return (
    <div style={{ padding: '24px' }}>
      <Button 
        icon={<ArrowLeftOutlined />} 
        onClick={() => navigate('/luchu/articles')}
        style={{ marginBottom: 16 }}
      >
        返回列表
      </Button>

      <Row gutter={24}>
        {/* 左侧：文章内容 */}
        <Col xs={24} lg={16}>
          <Card>
            <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <Title level={3} style={{ marginBottom: 8 }}>{article.title}</Title>
                <Space>
                  <Tag color={config.color}>{config.text}</Tag>
                  <Text type="secondary">版本 {article.version}</Text>
                  {article.publish_date && (
                    <Text type="secondary">计划发布：{article.publish_date}</Text>
                  )}
                </Space>
              </div>
              
              <Space>
                <Button icon={<HistoryOutlined />} onClick={loadVersions}>
                  版本历史
                </Button>
                
                {article.status === 'draft' && (
                  <>
                    <Button 
                      icon={<EditOutlined />}
                      onClick={() => navigate(`/luchu/articles/${id}/edit`)}
                    >
                      编辑
                    </Button>
                    
                    {canSelfCheck ? (
                      <Button 
                        type="primary"
                        icon={<CheckOutlined />}
                        onClick={handleSelfCheck}
                        loading={actionLoading}
                      >
                        自检通过
                      </Button>
                    ) : (
                      <Button 
                        type="primary"
                        icon={<SendOutlined />}
                        onClick={handleSubmit}
                        loading={actionLoading}
                      >
                        提交审核
                      </Button>
                    )}
                  </>
                )}
                
                {article.status === 'rejected' && (
                  <Button 
                    type="primary"
                    icon={<EditOutlined />}
                    onClick={() => navigate(`/luchu/articles/${id}/edit`)}
                  >
                    修改后重新提交
                  </Button>
                )}
                
                {article.status === 'ready' && (
                  <Button 
                    type="primary"
                    icon={<SendOutlined />}
                    onClick={() => navigate('/luchu/publish')}
                  >
                    去发布
                  </Button>
                )}
              </Space>
            </div>

            {/* 主图 */}
            {images.hero && (
              <div style={{ marginBottom: 24 }}>
                <Image
                  src={getProxyImageUrl(images.hero.url)}
                  alt={images.hero.alt}
                  style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'cover' }}
                  fallback="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZjBmMGYwIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMTQiIGZpbGw9IiM5OTkiPuWKoOi9veWksei0pTwvdGV4dD48L3N2Zz4="
                />
              </div>
            )}

            {/* 摘要 */}
            <Paragraph type="secondary" italic style={{ fontSize: 16, marginBottom: 24 }}>
              {article.excerpt}
            </Paragraph>

            <Divider />

            {/* 正文 */}
            <div 
              dangerouslySetInnerHTML={{ __html: article.content }} 
              style={{ lineHeight: 1.8, fontSize: 15 }}
            />
          </Card>
        </Col>

        {/* 右侧：文章信息 */}
        <Col xs={24} lg={8}>
          <Card title="文章信息" style={{ marginBottom: 16 }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="分类">
                {article.category_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Slug">
                {article.slug || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="品牌名称">
                {article.brand_name || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="关键词次数">
                {article.keyword_count}
              </Descriptions.Item>
              <Descriptions.Item label="追踪链接">
                <Text copyable ellipsis style={{ maxWidth: 200 }}>
                  {article.tracking_link || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="商家URL">
                {article.merchant_url ? (
                  <a href={article.merchant_url} target="_blank" rel="noopener noreferrer">
                    查看
                  </a>
                ) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {article.created_at ? dayjs(article.created_at).format('YYYY-MM-DD HH:mm') : '-'}
              </Descriptions.Item>
              {article.published_at && (
                <Descriptions.Item label="发布时间">
                  {dayjs(article.published_at).format('YYYY-MM-DD HH:mm')}
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>

          {/* 内容图片 */}
          {images.content && images.content.length > 0 && (
            <Card title="内容配图" style={{ marginBottom: 16 }}>
              <Space wrap>
                {images.content.map((img, index) => (
                  <Image
                    key={index}
                    src={getProxyImageUrl(img.url)}
                    alt={img.alt}
                    width={80}
                    height={80}
                    style={{ objectFit: 'cover' }}
                    fallback="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0iI2YwZjBmMCIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXNpemU9IjEwIiBmaWxsPSIjOTk5Ij7lpLHotKU8L3RleHQ+PC9zdmc+"
                  />
                ))}
              </Space>
            </Card>
          )}

          {/* 产品推荐 */}
          {products.length > 0 && (
            <Card title="产品推荐">
              <List
                size="small"
                dataSource={products}
                renderItem={(product) => (
                  <List.Item>
                    <List.Item.Meta
                      title={product.name}
                      description={
                        <Space direction="vertical" size={0}>
                          {product.price && <Text strong>{product.price}</Text>}
                          {product.description && <Text type="secondary">{product.description}</Text>}
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}
        </Col>
      </Row>

      {/* 版本历史弹窗 */}
      <Modal
        title="版本历史"
        open={showVersions}
        onCancel={() => setShowVersions(false)}
        footer={null}
        width={600}
      >
        <Timeline>
          {versions.map((v) => (
            <Timeline.Item key={v.id} color={v.change_type === 'review_reject' ? 'red' : 'blue'}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <Text strong>版本 {v.version_number}</Text>
                  <br />
                  <Text type="secondary">
                    {v.changer_name} · {dayjs(v.created_at).format('YYYY-MM-DD HH:mm')}
                  </Text>
                  <br />
                  <Tag color={v.change_type === 'create' ? 'green' : v.change_type === 'review_reject' ? 'red' : 'blue'}>
                    {v.change_type === 'create' ? '创建' : 
                     v.change_type === 'edit' ? '编辑' : 
                     v.change_type === 'review_reject' ? '驳回' : 
                     v.change_type === 'restore' ? '恢复' : v.change_type}
                  </Tag>
                  {v.change_reason && (
                    <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                      {v.change_reason}
                    </Paragraph>
                  )}
                </div>
                
                {v.version_number !== article.version && (
                  <Popconfirm
                    title={`确定恢复到版本 ${v.version_number}？`}
                    onConfirm={() => handleRestore(v.version_number)}
                  >
                    <Button 
                      size="small" 
                      icon={<RollbackOutlined />}
                      loading={actionLoading}
                    >
                      恢复
                    </Button>
                  </Popconfirm>
                )}
              </div>
            </Timeline.Item>
          ))}
        </Timeline>
      </Modal>
    </div>
  )
}

export default LuchuArticleDetail

