import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Button, Space, Select, message, Tag, Empty, Spin,
  Popconfirm, Typography, Row, Col,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, GlobalOutlined, LinkOutlined,
} from '@ant-design/icons'
import api from '../../services/api'

const { Text, Title } = Typography

const MySites = () => {
  const [boundSites, setBoundSites] = useState([])
  const [availableSites, setAvailableSites] = useState([])
  const [loading, setLoading] = useState(false)
  const [binding, setBinding] = useState(false)
  const [selectedSiteId, setSelectedSiteId] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [boundRes, availRes] = await Promise.all([
        api.get('/api/users/me/sites'),
        api.get('/api/users/me/available-sites'),
      ])
      setBoundSites(boundRes.data?.items || [])
      setAvailableSites(availRes.data?.items || [])
    } catch {
      message.error('加载网站数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handleBind = async () => {
    if (!selectedSiteId) return message.warning('请选择要绑定的网站')
    setBinding(true)
    try {
      await api.post('/api/users/me/sites', { site_id: selectedSiteId })
      message.success('绑定成功')
      setSelectedSiteId(null)
      fetchData()
    } catch (err) {
      message.error(err.response?.data?.detail || '绑定失败')
    } finally {
      setBinding(false)
    }
  }

  const handleUnbind = async (siteId) => {
    try {
      await api.delete(`/api/users/me/sites/${siteId}`)
      message.success('已解绑')
      fetchData()
    } catch (err) {
      message.error(err.response?.data?.detail || '解绑失败')
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <Title level={4} style={{ marginBottom: 24 }}>
        <GlobalOutlined style={{ marginRight: 8 }} />
        我的网站
      </Title>

      <Card
        title="绑定新网站"
        size="small"
        style={{ marginBottom: 24 }}
      >
        <Space>
          <Select
            placeholder="选择要绑定的网站"
            value={selectedSiteId}
            onChange={setSelectedSiteId}
            style={{ width: 360 }}
            options={availableSites.map(s => ({
              value: s.id,
              label: `${s.site_name}${s.domain ? ` (${s.domain})` : ''}`,
            }))}
            notFoundContent={
              availableSites.length === 0
                ? '本组内所有网站均已绑定'
                : '无可用网站'
            }
            showSearch
            filterOption={(input, option) =>
              (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleBind}
            loading={binding}
            disabled={!selectedSiteId}
          >
            绑定
          </Button>
        </Space>
      </Card>

      <Card title={`已绑定网站（${boundSites.length}）`} size="small">
        <Spin spinning={loading}>
          {boundSites.length === 0 ? (
            <Empty
              description="尚未绑定任何网站，发布文章前请先绑定"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <Row gutter={[16, 16]}>
              {boundSites.map(site => (
                <Col key={site.id} xs={24} sm={12} md={8} lg={6}>
                  <Card
                    size="small"
                    hoverable
                    actions={[
                      <Popconfirm
                        key="unbind"
                        title="确定要解绑此网站吗？"
                        description="解绑后发布文章时将无法选择此网站"
                        onConfirm={() => handleUnbind(site.id)}
                        okText="确定解绑"
                        cancelText="取消"
                      >
                        <DeleteOutlined style={{ color: '#ff4d4f' }} />
                      </Popconfirm>,
                    ]}
                  >
                    <Card.Meta
                      avatar={
                        <GlobalOutlined style={{ fontSize: 28, color: '#1890ff' }} />
                      }
                      title={
                        <Text ellipsis style={{ maxWidth: 160 }}>
                          {site.site_name}
                        </Text>
                      }
                      description={
                        <Space direction="vertical" size={2}>
                          {site.domain && (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              <LinkOutlined style={{ marginRight: 4 }} />
                              {site.domain}
                            </Text>
                          )}
                          {site.site_type && (
                            <Tag color="blue" style={{ fontSize: 11 }}>
                              {site.site_type}
                            </Tag>
                          )}
                        </Space>
                      }
                    />
                  </Card>
                </Col>
              ))}
            </Row>
          )}
        </Spin>
      </Card>
    </div>
  )
}

export default MySites
