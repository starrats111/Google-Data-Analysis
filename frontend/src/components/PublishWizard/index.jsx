import React, { useState, useEffect } from 'react'
import {
  Steps, Card, Input, Button, Space, List, Tag, Checkbox, DatePicker,
  Switch, message, Spin, Typography, Divider, Radio, Select, AutoComplete, Row, Col, Image,
} from 'antd'
import {
  RocketOutlined, CheckOutlined, PlusOutlined, DeleteOutlined,
  ShopOutlined, FileTextOutlined, GlobalOutlined, LinkOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import articleApi from '../../services/articleApi'

const { TextArea } = Input

const LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

const PublishWizard = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // mode: 'generic' | 'merchant'
  const [mode, setMode] = useState(null)

  // === Generic Mode State ===
  const [gStep, setGStep] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [generatedTitles, setGeneratedTitles] = useState([])
  const [selectedTitle, setSelectedTitle] = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const [saveTitles, setSaveTitles] = useState([])
  const [links, setLinks] = useState([])
  const [generatedArticle, setGeneratedArticle] = useState(null)
  const [generatedImages, setGeneratedImages] = useState([])
  const [publishDate, setPublishDate] = useState(null)
  const [enableLinks, setEnableLinks] = useState(false)

  // === Merchant Mode State ===
  const [mStep, setMStep] = useState(0)
  const [merchantUrl, setMerchantUrl] = useState('')
  const [trackingLink, setTrackingLink] = useState('')
  const [language, setLanguage] = useState('en')
  const [crawlResult, setCrawlResult] = useState(null)
  const [merchantTitles, setMerchantTitles] = useState([])
  const [merchantKeywords, setMerchantKeywords] = useState([])
  const [selectedMTitle, setSelectedMTitle] = useState('')
  const [selectedMKeywords, setSelectedMKeywords] = useState([])
  const [merchantArticle, setMerchantArticle] = useState(null)
  const [merchantImages, setMerchantImages] = useState([])
  const [mPublishDate, setMPublishDate] = useState(null)
  const [mEnableLinks, setMEnableLinks] = useState(false)
  const [trackingHistory, setTrackingHistory] = useState([])

  useEffect(() => {
    if (mode === 'merchant') {
      articleApi.getTrackingLinks({ limit: 50 })
        .then(res => setTrackingHistory(res.data?.items || []))
        .catch(() => {})
    }
  }, [mode])

  // ==================== Generic Mode Handlers ====================

  const handleGenerateTitles = async () => {
    if (!prompt.trim()) { message.warning('请输入主题描述'); return }
    setLoading(true)
    try {
      const res = await articleApi.generateTitles({ prompt, count: 10 })
      setGeneratedTitles(res.data?.titles || [])
      setGStep(1)
    } catch (err) {
      message.error('标题生成失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setLoading(false) }
  }

  const handleSelectTitle = (title) => setSelectedTitle(title.title || title)

  const handleToggleSaveTitle = (title) => {
    const idx = saveTitles.findIndex(t => t.title === title.title)
    if (idx >= 0) setSaveTitles(saveTitles.filter((_, i) => i !== idx))
    else setSaveTitles([...saveTitles, title])
  }

  const handleConfirmTitle = async () => {
    const finalTitle = customTitle.trim() || selectedTitle
    if (!finalTitle) { message.warning('请选择或输入标题'); return }
    setSelectedTitle(finalTitle)
    if (saveTitles.length > 0) {
      try {
        await articleApi.batchCreateTitles({
          titles: saveTitles.map(t => ({
            title: t.title || '', title_en: t.title_en || '', score: t.score || 0, prompt,
          })),
        })
        message.success(`已保存 ${saveTitles.length} 个标题到标题库`)
      } catch (_) {}
    }
    setGStep(2)
  }

  const handleAddLink = () => setLinks([...links, { keyword: '', url: '' }])
  const handleLinkChange = (index, field, value) => {
    const newLinks = [...links]; newLinks[index][field] = value; setLinks(newLinks)
  }
  const handleRemoveLink = (index) => setLinks(links.filter((_, i) => i !== index))

  const handleGenerate = async () => {
    setLoading(true)
    try {
      const validLinks = links.filter(l => l.keyword && l.url)
      const [articleRes, imageRes] = await Promise.all([
        articleApi.generateArticle({ title: selectedTitle, links: validLinks.length > 0 ? validLinks : undefined }),
        articleApi.generateImages({ title: selectedTitle, count: 5 }),
      ])
      setGeneratedArticle(articleRes.data)
      setGeneratedImages(imageRes.data?.images || [])
      setGStep(3)
    } catch (err) {
      message.error('生成失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setLoading(false) }
  }

  const handlePublish = async () => {
    if (!generatedArticle) return
    setSaving(true)
    try {
      const payload = {
        title: selectedTitle, content: generatedArticle.content,
        excerpt: generatedArticle.excerpt,
        status: publishDate ? 'draft' : 'published',
        publish_date: publishDate ? publishDate.toISOString().replace('Z', '+00:00') : null,
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
    } finally { setSaving(false) }
  }

  // ==================== Merchant Mode Handlers ====================

  const handleCrawl = async () => {
    if (!merchantUrl.trim()) { message.warning('请输入商家网址'); return }
    if (!trackingLink.trim()) { message.warning('请输入追踪链接'); return }
    setLoading(true)
    try {
      const res = await articleApi.crawlMerchant({ url: merchantUrl, language })
      setCrawlResult(res.data)
      setMerchantTitles(res.data?.analysis?.titles || [])
      setMerchantKeywords(res.data?.analysis?.keywords || [])
      setMerchantImages(res.data?.images || [])
      setMStep(1)
    } catch (err) {
      message.error('爬取失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setLoading(false) }
  }

  const handleMerchantConfirmTitle = () => {
    if (!selectedMTitle) { message.warning('请选择一个标题'); return }
    if (selectedMKeywords.length === 0) { message.warning('请至少选择一个关键词'); return }
    setMStep(2)
  }

  const handleMerchantGenerate = async () => {
    setLoading(true)
    try {
      const res = await articleApi.generateMerchantArticle({
        title: selectedMTitle,
        merchant_info: {
          brand_name: crawlResult?.brand_name || '',
          url: merchantUrl,
          products: crawlResult?.analysis?.products || [],
          selling_points: crawlResult?.analysis?.selling_points || [],
          promotions: crawlResult?.analysis?.promotions || '',
        },
        tracking_link: trackingLink,
        keywords: selectedMKeywords,
        language,
      })
      setMerchantArticle(res.data)
      setMStep(3)
    } catch (err) {
      message.error('文章生成失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setLoading(false) }
  }

  const handleMerchantPublish = async () => {
    if (!merchantArticle) return
    setSaving(true)
    try {
      const payload = {
        title: selectedMTitle,
        content: merchantArticle.content,
        excerpt: merchantArticle.excerpt,
        status: mPublishDate ? 'draft' : 'published',
        publish_date: mPublishDate ? mPublishDate.toISOString().replace('Z', '+00:00') : null,
        enable_keyword_links: mEnableLinks,
        meta_title: merchantArticle.meta_title,
        meta_description: merchantArticle.meta_description,
        meta_keywords: merchantArticle.meta_keywords,
        ai_model_used: 'gemini',
        merchant_url: merchantUrl,
        tracking_link: trackingLink,
        language,
        category_name: merchantArticle.category || crawlResult?.analysis?.category || null,
      }
      await articleApi.createArticle(payload)
      message.success(mPublishDate ? '文章已保存，将定时发布' : '文章已发布')
      navigate('/articles')
    } catch (err) {
      message.error('发布失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setSaving(false) }
  }

  const handleToggleMKeyword = (kw) => {
    if (selectedMKeywords.includes(kw)) setSelectedMKeywords(selectedMKeywords.filter(k => k !== kw))
    else setSelectedMKeywords([...selectedMKeywords, kw])
  }

  const handleRemoveMerchantImage = (index) => {
    setMerchantImages(prev => prev.filter((_, i) => i !== index))
  }

  // ==================== Tracking link autocomplete ====================
  const trackingOptions = trackingHistory.map(t => ({
    value: t.tracking_link,
    label: `${t.brand_name || t.merchant_url} — ${t.tracking_link}`,
  }))

  // ==================== Mode Selection Screen ====================
  if (!mode) {
    return (
      <Card title="发布文章向导">
        <div style={{ maxWidth: 600, margin: '0 auto', textAlign: 'center', padding: '40px 0' }}>
          <Typography.Title level={4} style={{ marginBottom: 32 }}>选择发布模式</Typography.Title>
          <Row gutter={24}>
            <Col span={12}>
              <Card
                hoverable
                style={{ textAlign: 'center', borderColor: '#1890ff', height: '100%' }}
                onClick={() => setMode('generic')}
              >
                <FileTextOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 16 }} />
                <Typography.Title level={5}>通用文章</Typography.Title>
                <Typography.Text type="secondary">输入主题，AI 生成文章，无特定商家</Typography.Text>
              </Card>
            </Col>
            <Col span={12}>
              <Card
                hoverable
                style={{ textAlign: 'center', borderColor: '#52c41a', height: '100%' }}
                onClick={() => setMode('merchant')}
              >
                <ShopOutlined style={{ fontSize: 48, color: '#52c41a', marginBottom: 16 }} />
                <Typography.Title level={5}>商家推广</Typography.Title>
                <Typography.Text type="secondary">输入商家链接，AI 爬取分析后生成推广软文</Typography.Text>
              </Card>
            </Col>
          </Row>
          <Button type="link" style={{ marginTop: 24 }} onClick={() => navigate('/articles')}>返回文章列表</Button>
        </div>
      </Card>
    )
  }

  // ==================== Generic Mode Steps ====================
  if (mode === 'generic') {
    const gSteps = [
      { title: '输入主题', description: '描述文章主题' },
      { title: '选择标题', description: '从AI生成的标题中选择' },
      { title: '超链接', description: '添加关键词链接' },
      { title: '生成发布', description: '预览并发布' },
    ]

    return (
      <Card
        title="发布文章向导 — 通用文章"
        extra={<Button size="small" onClick={() => setMode(null)}>切换模式</Button>}
      >
        <Steps current={gStep} items={gSteps} style={{ marginBottom: 32 }} />
        <Spin spinning={loading}>
          {gStep === 0 && (
            <div style={{ maxWidth: 600, margin: '0 auto' }}>
              <Typography.Title level={5}>输入文章主题或描述</Typography.Title>
              <TextArea rows={4} placeholder="例如：春季护肤品推荐" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={1000} />
              <Button type="primary" icon={<RocketOutlined />} onClick={handleGenerateTitles} style={{ marginTop: 16 }} size="large" block>
                AI 生成标题
              </Button>
            </div>
          )}

          {gStep === 1 && (
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
                      style={{ cursor: 'pointer', background: isSelected ? '#e6f7ff' : undefined, borderRadius: 8, padding: '12px 16px', marginBottom: 4 }}
                      onClick={() => handleSelectTitle(item)}
                      actions={[
                        <Checkbox checked={isSaved} onClick={e => { e.stopPropagation(); handleToggleSaveTitle(item) }}>存入标题库</Checkbox>,
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
              <Input placeholder="或输入自定义标题" value={customTitle} onChange={e => setCustomTitle(e.target.value)} style={{ marginBottom: 16 }} />
              <Space>
                <Button onClick={() => setGStep(0)}>上一步</Button>
                <Button type="primary" onClick={handleConfirmTitle}>下一步</Button>
              </Space>
            </div>
          )}

          {gStep === 2 && (
            <div style={{ maxWidth: 600, margin: '0 auto' }}>
              <Typography.Title level={5}>添加超链接（可选）</Typography.Title>
              <Typography.Text type="secondary">文章中出现这些关键词时，会自动添加超链接</Typography.Text>
              <div style={{ marginTop: 16 }}>
                {links.map((link, index) => (
                  <Space key={index} style={{ display: 'flex', marginBottom: 8 }}>
                    <Input placeholder="关键词" value={link.keyword} onChange={e => handleLinkChange(index, 'keyword', e.target.value)} style={{ width: 180 }} />
                    <Input placeholder="URL" value={link.url} onChange={e => handleLinkChange(index, 'url', e.target.value)} style={{ width: 300 }} />
                    <Button icon={<DeleteOutlined />} danger onClick={() => handleRemoveLink(index)} />
                  </Space>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddLink} block>添加超链接</Button>
              </div>
              <Divider />
              <Space>
                <Button onClick={() => setGStep(1)}>上一步</Button>
                <Button type="primary" icon={<RocketOutlined />} onClick={handleGenerate}>生成文章 + 配图</Button>
              </Space>
            </div>
          )}

          {gStep === 3 && generatedArticle && (
            <div>
              <Typography.Title level={5}>预览：{selectedTitle}</Typography.Title>
              {generatedArticle.excerpt && (
                <Typography.Paragraph type="secondary" style={{ fontSize: 14 }}>{generatedArticle.excerpt}</Typography.Paragraph>
              )}
              <Card size="small" style={{ marginBottom: 16, maxHeight: 400, overflow: 'auto' }}>
                <div dangerouslySetInnerHTML={{ __html: generatedArticle.content }} />
              </Card>
              {generatedImages.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Title level={5}>配图建议</Typography.Title>
                  <Space wrap>
                    {generatedImages.map((img, i) => (
                      <Tag key={i} color="geekblue"><a href={img.url} target="_blank" rel="noopener noreferrer">{img.keyword}</a></Tag>
                    ))}
                  </Space>
                </div>
              )}
              <Divider />
              <Space size="large" wrap>
                <div>
                  <Typography.Text>定时发布：</Typography.Text>
                  <DatePicker showTime placeholder="留空则立即发布" value={publishDate} onChange={setPublishDate} style={{ marginLeft: 8 }} />
                </div>
                <div>
                  <Typography.Text>启用关键词链接：</Typography.Text>
                  <Switch checked={enableLinks} onChange={setEnableLinks} style={{ marginLeft: 8 }} />
                </div>
              </Space>
              <Divider />
              <Space>
                <Button onClick={() => setGStep(2)}>上一步</Button>
                <Button type="primary" icon={<CheckOutlined />} onClick={handlePublish} loading={saving} size="large">
                  {publishDate ? '保存（定时发布）' : '立即发布'}
                </Button>
              </Space>
            </div>
          )}
        </Spin>
      </Card>
    )
  }

  // ==================== Merchant Mode Steps ====================
  const mSteps = [
    { title: '输入商家信息', description: '网址 + 追踪链接' },
    { title: 'AI 分析结果', description: '选择标题和关键词' },
    { title: '生成文章', description: 'AI 撰写推广软文' },
    { title: '预览发布', description: '确认并发布' },
  ]

  return (
    <Card
      title="发布文章向导 — 商家推广"
      extra={<Button size="small" onClick={() => setMode(null)}>切换模式</Button>}
    >
      <Steps current={mStep} items={mSteps} style={{ marginBottom: 32 }} />
      <Spin spinning={loading}>

        {/* Step 0: 输入商家信息 */}
        {mStep === 0 && (
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            <Typography.Title level={5}><ShopOutlined /> 商家网址</Typography.Title>
            <Input
              placeholder="https://www.example.com"
              value={merchantUrl}
              onChange={e => setMerchantUrl(e.target.value)}
              prefix={<GlobalOutlined />}
              size="large"
            />

            <Typography.Title level={5} style={{ marginTop: 24 }}><LinkOutlined /> 追踪链接</Typography.Title>
            <AutoComplete
              options={trackingOptions}
              value={trackingLink}
              onChange={setTrackingLink}
              placeholder="输入追踪链接（支持历史记录自动补全）"
              style={{ width: '100%' }}
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />

            <Typography.Title level={5} style={{ marginTop: 24 }}>文章语言</Typography.Title>
            <Select value={language} onChange={setLanguage} options={LANGUAGES} style={{ width: 200 }} />

            <Divider />
            <Button type="primary" icon={<RocketOutlined />} onClick={handleCrawl} size="large" block>
              开始爬取 & AI 分析
            </Button>
          </div>
        )}

        {/* Step 1: AI 分析结果 */}
        {mStep === 1 && crawlResult && (
          <div style={{ maxWidth: 700, margin: '0 auto' }}>
            <Card size="small" style={{ marginBottom: 16, background: '#f6ffed' }}>
              <Typography.Text strong>品牌：</Typography.Text>
              <Typography.Text>{crawlResult.brand_name}</Typography.Text>
              {crawlResult.analysis?.products && (
                <div style={{ marginTop: 8 }}>
                  <Typography.Text strong>主营产品：</Typography.Text>
                  <Typography.Text>{crawlResult.analysis.products.join('、')}</Typography.Text>
                </div>
              )}
              {crawlResult.analysis?.selling_points && (
                <div style={{ marginTop: 4 }}>
                  <Typography.Text strong>卖点：</Typography.Text>
                  <Typography.Text>{crawlResult.analysis.selling_points.join('、')}</Typography.Text>
                </div>
              )}
              {crawlResult.analysis?.promotions && (
                <div style={{ marginTop: 4 }}>
                  <Typography.Text strong>促销：</Typography.Text>
                  <Typography.Text>{crawlResult.analysis.promotions}</Typography.Text>
                </div>
              )}
            </Card>

            {merchantImages.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Typography.Title level={5}>商家图片 <Typography.Text type="secondary" style={{ fontSize: 12 }}>点击 × 可移除不需要的图片</Typography.Text></Typography.Title>
                <Space wrap>
                  {merchantImages.slice(0, 8).map((src, i) => (
                    <div key={i} style={{ position: 'relative', display: 'inline-block' }}>
                      <Image src={src} width={100} height={100} style={{ objectFit: 'cover', borderRadius: 4 }}
                        fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
                      />
                      <Button
                        type="text" danger size="small" icon={<DeleteOutlined />}
                        onClick={() => handleRemoveMerchantImage(i)}
                        style={{ position: 'absolute', top: -6, right: -6, background: '#fff', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', width: 22, height: 22, padding: 0, minWidth: 22 }}
                      />
                    </div>
                  ))}
                </Space>
              </div>
            )}

            <Typography.Title level={5}>选择标题</Typography.Title>
            <List
              dataSource={merchantTitles}
              renderItem={(item, index) => {
                const titleZh = typeof item === 'string' ? item : item.title
                const titleEn = typeof item === 'string' ? item : (item.title_en || item.title)
                const displayTitle = language === 'en' ? titleEn : titleZh
                const subTitle = language === 'en' ? titleZh : titleEn
                const isSelected = selectedMTitle === displayTitle
                return (
                  <List.Item
                    style={{ cursor: 'pointer', background: isSelected ? '#e6f7ff' : undefined, borderRadius: 8, padding: '10px 16px', marginBottom: 4 }}
                    onClick={() => setSelectedMTitle(displayTitle)}
                  >
                    <List.Item.Meta
                      avatar={<Tag color={isSelected ? 'blue' : 'default'}>{index + 1}</Tag>}
                      title={displayTitle}
                      description={subTitle !== displayTitle ? subTitle : null}
                    />
                  </List.Item>
                )
              }}
            />

            <Typography.Title level={5} style={{ marginTop: 16 }}>选择关键词</Typography.Title>
            <Space wrap>
              {merchantKeywords.map((kw, i) => (
                <Tag
                  key={i}
                  color={selectedMKeywords.includes(kw) ? 'green' : 'default'}
                  style={{ cursor: 'pointer', padding: '4px 12px', fontSize: 14 }}
                  onClick={() => handleToggleMKeyword(kw)}
                >
                  {kw}
                </Tag>
              ))}
            </Space>

            <Divider />
            <Space>
              <Button onClick={() => setMStep(0)}>上一步</Button>
              <Button type="primary" onClick={handleMerchantConfirmTitle}>下一步</Button>
            </Space>
          </div>
        )}

        {/* Step 2: 生成文章 */}
        {mStep === 2 && (
          <div style={{ maxWidth: 600, margin: '0 auto', textAlign: 'center', padding: '40px 0' }}>
            <Typography.Title level={5}>确认信息</Typography.Title>
            <Card size="small" style={{ textAlign: 'left', marginBottom: 24 }}>
              <p><strong>标题：</strong>{selectedMTitle}</p>
              <p><strong>关键词：</strong>{selectedMKeywords.join('、')}</p>
              <p><strong>品牌：</strong>{crawlResult?.brand_name}</p>
              <p><strong>追踪链接：</strong>{trackingLink}</p>
              <p><strong>语言：</strong>{language === 'en' ? 'English' : '中文'}</p>
            </Card>
            <Space>
              <Button onClick={() => setMStep(1)}>上一步</Button>
              <Button type="primary" icon={<RocketOutlined />} onClick={handleMerchantGenerate} size="large">
                生成推广文章
              </Button>
            </Space>
          </div>
        )}

        {/* Step 3: 预览发布 */}
        {mStep === 3 && merchantArticle && (
          <div>
            <Typography.Title level={5}>预览：{selectedMTitle}</Typography.Title>
            {merchantArticle.excerpt && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 14 }}>{merchantArticle.excerpt}</Typography.Paragraph>
            )}
            <Card size="small" style={{ marginBottom: 16, maxHeight: 400, overflow: 'auto' }}>
              <div dangerouslySetInnerHTML={{ __html: merchantArticle.content }} />
            </Card>

            {merchantImages.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Typography.Title level={5}>商家图片 <Typography.Text type="secondary" style={{ fontSize: 12 }}>点击 × 可移除</Typography.Text></Typography.Title>
                <Space wrap>
                  {merchantImages.slice(0, 8).map((src, i) => (
                    <div key={i} style={{ position: 'relative', display: 'inline-block' }}>
                      <Image src={src} width={120} height={120} style={{ objectFit: 'cover', borderRadius: 4 }}
                        fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
                      />
                      <Button
                        type="text" danger size="small" icon={<DeleteOutlined />}
                        onClick={() => handleRemoveMerchantImage(i)}
                        style={{ position: 'absolute', top: -6, right: -6, background: '#fff', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', width: 22, height: 22, padding: 0, minWidth: 22 }}
                      />
                    </div>
                  ))}
                </Space>
              </div>
            )}
            <Divider />
            <Space size="large" wrap>
              <div>
                <Typography.Text>定时发布：</Typography.Text>
                <DatePicker showTime placeholder="留空则立即发布" value={mPublishDate} onChange={setMPublishDate} style={{ marginLeft: 8 }} />
              </div>
              <div>
                <Typography.Text>启用关键词链接：</Typography.Text>
                <Switch checked={mEnableLinks} onChange={setMEnableLinks} style={{ marginLeft: 8 }} />
              </div>
            </Space>
            <Divider />
            <Space>
              <Button onClick={() => setMStep(2)}>上一步</Button>
              <Button type="primary" icon={<CheckOutlined />} onClick={handleMerchantPublish} loading={saving} size="large">
                {mPublishDate ? '保存（定时发布）' : '立即发布'}
              </Button>
            </Space>
          </div>
        )}
      </Spin>
    </Card>
  )
}

export default PublishWizard
