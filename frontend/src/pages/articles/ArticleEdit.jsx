import React, { useState, useEffect, useCallback } from 'react'
import { Card, Form, Input, Select, Button, Switch, DatePicker, Space, Tag, message, Spin, Tabs, Modal, List, Typography } from 'antd'
import { SaveOutlined, ArrowLeftOutlined, HistoryOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import articleApi from '../../services/articleApi'

const { TextArea } = Input
const { Option } = Select

const ArticleEdit = () => {
  const { id } = useParams()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [categories, setCategories] = useState([])
  const [tags, setTags] = useState([])
  const [selectedTags, setSelectedTags] = useState([])
  const [links, setLinks] = useState([])
  const [versionsVisible, setVersionsVisible] = useState(false)
  const [versions, setVersions] = useState([])

  const isNew = !id

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [catRes, tagRes] = await Promise.all([
        articleApi.getCategories(),
        articleApi.getTags(),
      ])
      setCategories(catRes.data || [])
      setTags(tagRes.data || [])

      if (id) {
        const res = await articleApi.getArticle(id)
        const article = res.data
        form.setFieldsValue({
          title: article.title,
          content: article.content,
          excerpt: article.excerpt,
          status: article.status,
          category_id: article.category_id,
          author: article.author,
          publish_date: article.publish_date ? dayjs(article.publish_date) : null,
          enable_keyword_links: article.enable_keyword_links,
          meta_title: article.meta_title,
          meta_description: article.meta_description,
          meta_keywords: article.meta_keywords,
        })
        setSelectedTags(article.tags?.map(t => t.id) || [])
        setLinks(article.links || [])
      }
    } catch (err) {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      const payload = {
        ...values,
        publish_date: values.publish_date ? values.publish_date.toISOString() : null,
        tag_ids: selectedTags,
        links,
      }

      if (id) {
        await articleApi.updateArticle(id, payload)
        message.success('文章已更新')
      } else {
        await articleApi.createArticle(payload)
        message.success('文章已创建')
        navigate('/articles')
      }
    } catch (err) {
      if (err?.errorFields) return
      message.error(err?.response?.data?.detail || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const fetchVersions = async () => {
    if (!id) return
    try {
      const res = await articleApi.getArticleVersions(id)
      setVersions(res.data || [])
      setVersionsVisible(true)
    } catch (_) {
      message.error('获取版本历史失败')
    }
  }

  const handleAddLink = () => {
    setLinks([...links, { keyword: '', url: '' }])
  }

  const handleLinkChange = (index, field, value) => {
    const newLinks = [...links]
    newLinks[index][field] = value
    setLinks(newLinks)
  }

  const handleRemoveLink = (index) => {
    setLinks(links.filter((_, i) => i !== index))
  }

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />

  return (
    <Card
      title={
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/articles')} type="text" />
          <span>{isNew ? '创建文章' : '编辑文章'}</span>
        </Space>
      }
      extra={
        <Space>
          {!isNew && (
            <Button icon={<HistoryOutlined />} onClick={fetchVersions}>版本历史</Button>
          )}
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>
            保存
          </Button>
        </Space>
      }
    >
      <Tabs
        defaultActiveKey="content"
        items={[
          {
            key: 'content',
            label: '内容',
            children: (
              <Form form={form} layout="vertical" initialValues={{ status: 'draft', enable_keyword_links: false }}>
                <Form.Item label="标题" name="title" rules={[{ required: true, message: '请输入标题' }]}>
                  <Input placeholder="文章标题" maxLength={500} />
                </Form.Item>
                <Form.Item label="内容" name="content">
                  <TextArea rows={16} placeholder="文章内容（支持 HTML）" />
                </Form.Item>
                <Form.Item label="摘要" name="excerpt">
                  <TextArea rows={3} placeholder="文章摘要" maxLength={500} />
                </Form.Item>
                <Space style={{ width: '100%' }} size="large" wrap>
                  <Form.Item label="状态" name="status">
                    <Select style={{ width: 140 }}>
                      <Option value="draft">草稿</Option>
                      <Option value="published">已发布</Option>
                    </Select>
                  </Form.Item>
                  <Form.Item label="分类" name="category_id">
                    <Select style={{ width: 160 }} placeholder="选择分类" allowClear>
                      {categories.map(c => (
                        <Option key={c.id} value={c.id}>{c.name}</Option>
                      ))}
                    </Select>
                  </Form.Item>
                  <Form.Item label="作者" name="author">
                    <Input placeholder="作者" style={{ width: 140 }} />
                  </Form.Item>
                  <Form.Item label="定时发布" name="publish_date">
                    <DatePicker showTime placeholder="留空则立即发布" />
                  </Form.Item>
                </Space>
                <Form.Item label="标签">
                  <Select
                    mode="multiple"
                    placeholder="选择标签"
                    value={selectedTags}
                    onChange={setSelectedTags}
                    style={{ width: '100%' }}
                  >
                    {tags.map(t => (
                      <Option key={t.id} value={t.id}>{t.name}</Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label="启用关键词超链接" name="enable_keyword_links" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: 'links',
            label: `超链接 (${links.length})`,
            children: (
              <div>
                {links.map((link, index) => (
                  <Space key={index} style={{ display: 'flex', marginBottom: 8 }}>
                    <Input
                      placeholder="关键词"
                      value={link.keyword}
                      onChange={e => handleLinkChange(index, 'keyword', e.target.value)}
                      style={{ width: 200 }}
                    />
                    <Input
                      placeholder="URL"
                      value={link.url}
                      onChange={e => handleLinkChange(index, 'url', e.target.value)}
                      style={{ width: 400 }}
                    />
                    <Button danger onClick={() => handleRemoveLink(index)}>删除</Button>
                  </Space>
                ))}
                <Button type="dashed" onClick={handleAddLink} style={{ marginTop: 8 }}>
                  + 添加超链接
                </Button>
              </div>
            ),
          },
          {
            key: 'seo',
            label: 'SEO',
            children: (
              <Form form={form} layout="vertical">
                <Form.Item label="Meta Title" name="meta_title">
                  <Input placeholder="SEO 标题" maxLength={200} />
                </Form.Item>
                <Form.Item label="Meta Description" name="meta_description">
                  <TextArea rows={3} placeholder="SEO 描述" maxLength={500} />
                </Form.Item>
                <Form.Item label="Meta Keywords" name="meta_keywords">
                  <Input placeholder="SEO 关键词（逗号分隔）" maxLength={500} />
                </Form.Item>
              </Form>
            ),
          },
        ]}
      />

      <Modal
        title="版本历史"
        open={versionsVisible}
        onCancel={() => setVersionsVisible(false)}
        footer={null}
        width={700}
      >
        <List
          dataSource={versions}
          renderItem={v => (
            <List.Item>
              <List.Item.Meta
                title={`v${v.version}: ${v.title || '(无标题)'}`}
                description={
                  <Space direction="vertical" size={0}>
                    <Typography.Text type="secondary">
                      修改人: {v.changed_by} | 时间: {v.created_at ? new Date(v.created_at).toLocaleString('zh-CN') : '-'}
                    </Typography.Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </Modal>
    </Card>
  )
}

export default ArticleEdit
