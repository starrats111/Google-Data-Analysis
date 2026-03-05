import React, { useState, useCallback } from 'react'
import { Steps, Card, Input, Button, Space, List, Tag, Checkbox, DatePicker, Switch, message, Spin, Typography, Divider } from 'antd'
import { RocketOutlined, CheckOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import articleApi from '../../services/articleApi'

const { TextArea } = Input

const PublishWizard = () => {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Step 1: 提示词
  const [prompt, setPrompt] = useState('')
  const [generatedTitles, setGeneratedTitles] = useState([])

  // Step 2: 选标题
  const [selectedTitle, setSelectedTitle] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [saveTitles, setSaveTitles] = useState([])

  // Step 3: 超链接
  const [links, setLinks] = useState([])

  // Step 4: 生成结果
  const [generatedArticle, setGeneratedArticle] = useState(null)
  const [generatedImages, setGeneratedImages] = useState([])
  const [selectedImages, setSelectedImages] = useState([])
  const [publishDate, setPublishDate] = useState(null)
  const [enableLinks, setEnableLinks] = useState(false)

  const handleGenerateTitles = async () => {
    if (!prompt.trim()) {
      message.warning('请输入主题描述')
      return
    }
    setLoading(true)
    try {
      const res = await articleApi.generateTitles({ prompt, count: 10 })
      setGeneratedTitles(res.data?.titles || [])
      setStep(1)
    } catch (err) {
      message.error('标题生成失败: ' + (err?.response?.data?.detail || err.message))
    } finally {
      setLoading(false)
    }
  }

  const handleSelectTitle = (title) => {
    setSelectedTitle(title.title || title)
  }

  const handleToggleSaveTitle = (title) => {
    const idx = saveTitles.findIndex(t => t.title === title.title)
    if (idx >= 0) {
      setSaveTitles(saveTitles.filter((_, i) => i !== idx))
    } else {
      setSaveTitles([...saveTitles, title])
    }
  }

  const handleConfirmTitle = async () => {
    const finalTitle = customTitle.trim() || selectedTitle
    if (!finalTitle) {
      message.warning('请选择或输入标题')
      return
    }
    setSelectedTitle(finalTitle)

    if (saveTitles.length > 0) {
      try {
        await articleApi.batchCreateTitles({
          titles: saveTitles.map(t => ({
            title: t.title || '',
            title_en: t.title_en || '',
            score: t.score || 0,
            prompt,
          })),
        })
        message.success(`已保存 ${saveTitles.length} 个标题到标题库`)
      } catch (_) {}
    }
    setStep(2)
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

  const handleGenerate = async () => {
    setLoading(true)
    try {
      const validLinks = links.filter(l => l.keyword && l.url)
      const [articleRes, imageRes] = await Promise.all([
        articleApi.generateArticle({
          title: selectedTitle,
          links: validLinks.length > 0 ? validLinks : undefined,
        }),
        articleApi.generateImages({ title: selectedTitle, count: 5 }),
      ])
      setGeneratedArticle(articleRes.data)
      setGeneratedImages(imageRes.data?.images || [])
      setStep(3)
    } catch (err) {
      message.error('生成失败: ' + (err?.response?.data?.detail || err.message))
    } finally {
      setLoading(false)
    }
  }

  const handlePublish = async () => {
    if (!generatedArticle) return
    setSaving(true)
    try {
      const payload = {
        title: selectedTitle,
        content: generatedArticle.content,
        excerpt: generatedArticle.excerpt,
        status: publishDate ? 'draft' : 'published',
        publish_date: publishDate ? publishDate.toISOString() : null,
        enable_keyword_links: enableLinks,
        meta_title: generatedArticle.meta_title,
        meta_description: generatedArticle.meta_description,
        meta_keywords: generatedArticle.meta_keywords,
        links: links.filter(l => l.keyword && l.url),
        ai_model_used: 'gemini',
      }
      await articleApi.createArticle(payload)
      message.success(publishDate ? '文章已保存，将定时发布' : '文章已发布')
      navigate('/articles')
    } catch (err) {
      message.error('发布失败: ' + (err?.response?.data?.detail || err.message))
    } finally {
      setSaving(false)
    }
  }

  const steps = [
    { title: '输入主题', description: '描述文章主题' },
    { title: '选择标题', description: '从AI生成的标题中选择' },
    { title: '超链接', description: '添加关键词链接' },
    { title: '生成发布', description: '预览并发布' },
  ]

  return (
    <Card title="发布文章向导">
      <Steps current={step} items={steps} style={{ marginBottom: 32 }} />

      <Spin spinning={loading}>
        {step === 0 && (
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            <Typography.Title level={5}>输入文章主题或描述</Typography.Title>
            <TextArea
              rows={4}
              placeholder="例如：春季护肤品推荐，如何选择适合自己肤质的产品"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={1000}
            />
            <Button
              type="primary"
              icon={<RocketOutlined />}
              onClick={handleGenerateTitles}
              style={{ marginTop: 16 }}
              size="large"
              block
            >
              AI 生成标题
            </Button>
          </div>
        )}

        {step === 1 && (
          <div style={{ maxWidth: 700, margin: '0 auto' }}>
            <Typography.Title level={5}>选择标题（或自定义）</Typography.Title>
            <List
              dataSource={generatedTitles}
              renderItem={(item, index) => {
                const title = typeof item === 'string' ? item : item.title
                const titleEn = typeof item === 'string' ? '' : item.title_en
                const isSelected = selectedTitle === title
                const isSaved = saveTitles.some(t => (t.title || t) === title)
                return (
                  <List.Item
                    style={{
                      cursor: 'pointer',
                      background: isSelected ? '#e6f7ff' : undefined,
                      borderRadius: 8,
                      padding: '12px 16px',
                      marginBottom: 4,
                    }}
                    onClick={() => handleSelectTitle(item)}
                    actions={[
                      <Checkbox
                        checked={isSaved}
                        onClick={(e) => { e.stopPropagation(); handleToggleSaveTitle(item) }}
                      >
                        存入标题库
                      </Checkbox>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<Tag color={isSelected ? 'blue' : 'default'}>{index + 1}</Tag>}
                      title={title}
                      description={titleEn || null}
                    />
                  </List.Item>
                )
              }}
            />
            <Divider />
            <Input
              placeholder="或输入自定义标题"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              style={{ marginBottom: 16 }}
            />
            <Space>
              <Button onClick={() => setStep(0)}>上一步</Button>
              <Button type="primary" onClick={handleConfirmTitle}>下一步</Button>
            </Space>
          </div>
        )}

        {step === 2 && (
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            <Typography.Title level={5}>添加超链接（可选）</Typography.Title>
            <Typography.Text type="secondary">文章中出现这些关键词时，会自动添加超链接</Typography.Text>
            <div style={{ marginTop: 16 }}>
              {links.map((link, index) => (
                <Space key={index} style={{ display: 'flex', marginBottom: 8 }}>
                  <Input
                    placeholder="关键词"
                    value={link.keyword}
                    onChange={e => handleLinkChange(index, 'keyword', e.target.value)}
                    style={{ width: 180 }}
                  />
                  <Input
                    placeholder="URL"
                    value={link.url}
                    onChange={e => handleLinkChange(index, 'url', e.target.value)}
                    style={{ width: 300 }}
                  />
                  <Button icon={<DeleteOutlined />} danger onClick={() => handleRemoveLink(index)} />
                </Space>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddLink} block>
                添加超链接
              </Button>
            </div>
            <Divider />
            <Space>
              <Button onClick={() => setStep(1)}>上一步</Button>
              <Button type="primary" icon={<RocketOutlined />} onClick={handleGenerate}>
                生成文章 + 配图
              </Button>
            </Space>
          </div>
        )}

        {step === 3 && generatedArticle && (
          <div>
            <Typography.Title level={5}>
              预览：{selectedTitle}
            </Typography.Title>
            {generatedArticle.excerpt && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 14 }}>
                {generatedArticle.excerpt}
              </Typography.Paragraph>
            )}
            <Card
              size="small"
              style={{ marginBottom: 16, maxHeight: 400, overflow: 'auto' }}
            >
              <div dangerouslySetInnerHTML={{ __html: generatedArticle.content }} />
            </Card>

            {generatedImages.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Typography.Title level={5}>配图建议</Typography.Title>
                <Space wrap>
                  {generatedImages.map((img, i) => (
                    <Tag key={i} color="geekblue">
                      <a href={img.url} target="_blank" rel="noopener noreferrer">{img.keyword}</a>
                    </Tag>
                  ))}
                </Space>
              </div>
            )}

            <Divider />
            <Space size="large" wrap>
              <div>
                <Typography.Text>定时发布：</Typography.Text>
                <DatePicker
                  showTime
                  placeholder="留空则立即发布"
                  value={publishDate}
                  onChange={setPublishDate}
                  style={{ marginLeft: 8 }}
                />
              </div>
              <div>
                <Typography.Text>启用关键词链接：</Typography.Text>
                <Switch checked={enableLinks} onChange={setEnableLinks} style={{ marginLeft: 8 }} />
              </div>
            </Space>
            <Divider />
            <Space>
              <Button onClick={() => setStep(2)}>上一步</Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={handlePublish}
                loading={saving}
                size="large"
              >
                {publishDate ? '保存（定时发布）' : '立即发布'}
              </Button>
            </Space>
          </div>
        )}
      </Spin>
    </Card>
  )
}

export default PublishWizard
