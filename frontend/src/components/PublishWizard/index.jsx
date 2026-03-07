import React, { useState, useEffect } from 'react'
import {
  Steps, Card, Input, Button, Space, List, Tag, Checkbox, DatePicker,
  Switch, message, Spin, Typography, Divider, Radio, Select, AutoComplete,
  Row, Col, Image, Segmented, Descriptions, Alert,
} from 'antd'
import {
  RocketOutlined, CheckOutlined, PlusOutlined, DeleteOutlined,
  ShopOutlined, FileTextOutlined, GlobalOutlined, LinkOutlined,
  SearchOutlined, ThunderboltOutlined,
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

  // === OPT-015: Campaign Link State ===
  const [inputMode, setInputMode] = useState('platform')  // 'platform' | 'manual'
  const [userPlatforms, setUserPlatforms] = useState([])
  const [selectedPlatform, setSelectedPlatform] = useState(null)
  const [merchantMid, setMerchantMid] = useState('')
  const [campaignResult, setCampaignResult] = useState(null)
  const [selectedRegion, setSelectedRegion] = useState(null)
  const [fetchingCampaign, setFetchingCampaign] = useState(false)

  // === OPT-013: 发布到网站 State ===
  const [publishToSite, setPublishToSite] = useState(false)
  const [siteList, setSiteList] = useState([])
  const [selectedSiteId, setSelectedSiteId] = useState(null)
  const [publishingSite, setPublishingSite] = useState(false)

  // === 图片增强 State ===
  const [featuredImageIndex, setFeaturedImageIndex] = useState(0)  // 默认第一张为头图
  const [searchingImages, setSearchingImages] = useState(false)

  useEffect(() => {
    if (mode === 'merchant') {
      articleApi.getTrackingLinks({ limit: 50 })
        .then(res => setTrackingHistory(res.data?.items || []))
        .catch(() => {})
      articleApi.getUserPlatforms()
        .then(res => setUserPlatforms(res.data?.platforms || []))
        .catch(() => {})
    }
  }, [mode])

  // OPT-013: 加载网站列表
  useEffect(() => {
    if (mode) {
      articleApi.getSites()
        .then(res => setSiteList(res.data?.items || []))
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
      const res = await articleApi.createArticle(payload)
      const articleId = res.data?.id

      // OPT-013: 发布到网站
      if (publishToSite && selectedSiteId && articleId) {
        try {
          await articleApi.publishToSite(articleId, selectedSiteId)
          message.success('文章已发布，并同步到网站')
        } catch (siteErr) {
          message.warning('文章已保存，但发布到网站失败: ' + (siteErr?.response?.data?.detail || siteErr.message))
        }
      } else {
        message.success(publishDate ? '文章已保存，将定时发布' : '文章已发布')
      }
      navigate('/articles')
    } catch (err) {
      message.error('发布失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setSaving(false) }
  }

  // ==================== OPT-015: Campaign Link Handler ====================

  const handleFetchCampaignLink = async () => {
    if (!selectedPlatform) { message.warning('请选择平台'); return }
    if (!merchantMid.trim()) { message.warning('请输入商家 MID'); return }
    setFetchingCampaign(true)
    try {
      const res = await articleApi.getCampaignLink({
        platform_code: selectedPlatform,
        merchant_id: merchantMid.trim(),
      })
      setCampaignResult(res.data)
      setSelectedRegion(null)
      if (res.data?.campaign_link) {
        setTrackingLink(res.data.campaign_link)
      }
      if (res.data?.site_url) {
        setMerchantUrl(res.data.site_url)
      }
      if (!res.data?.campaign_link) {
        message.warning('该商家未返回 Campaign Link，请切换到手动输入')
      }
    } catch (err) {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail || '获取 Campaign Link 失败'
      if (status === 404) {
        message.warning(detail)
        setInputMode('manual')
      } else {
        message.error(detail)
      }
    } finally { setFetchingCampaign(false) }
  }

  const handleRegionSelect = (regionCode) => {
    setSelectedRegion(regionCode)
    const region = campaignResult?.support_regions?.find(r => r.code === regionCode)
    if (region) {
      setLanguage(region.language_code)
    }
  }

  const handlePlatformCrawl = async () => {
    if (!merchantUrl.trim()) { message.warning('商家网址为空，请先获取 Campaign Link'); return }
    if (!trackingLink.trim()) { message.warning('追踪链接为空'); return }
    if (!language) { message.warning('请选择 Support Region 以确定语言'); return }
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
        featured_image: merchantImages[featuredImageIndex] || merchantImages[0] || null,
      }
      const res = await articleApi.createArticle(payload)
      const articleId = res.data?.id

      // OPT-013: 发布到网站
      if (publishToSite && selectedSiteId && articleId) {
        try {
          await articleApi.publishToSite(articleId, selectedSiteId)
          message.success('文章已发布，并同步到网站')
        } catch (siteErr) {
          message.warning('文章已保存，但发布到网站失败: ' + (siteErr?.response?.data?.detail || siteErr.message))
        }
      } else {
        message.success(mPublishDate ? '文章已保存，将定时发布' : '文章已发布')
      }
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
    // 如果删除的是头图，重置为第一张
    if (index === featuredImageIndex) setFeaturedImageIndex(0)
    else if (index < featuredImageIndex) setFeaturedImageIndex(prev => prev - 1)
  }

  const handleSearchMoreImages = async () => {
    const brandName = crawlResult?.brand_name || ''
    if (!brandName) { message.warning('无法获取品牌名，请手动搜索'); return }
    setSearchingImages(true)
    try {
      const res = await articleApi.searchImages({ query: `${brandName} products official`, count: 12 })
      const newImages = res.data?.images || []
      if (newImages.length === 0) { message.info('未搜索到更多图片'); return }
      setMerchantImages(prev => {
        const existing = new Set(prev)
        const merged = [...prev]
        for (const img of newImages) {
          if (!existing.has(img)) { merged.push(img); existing.add(img) }
        }
        return merged
      })
      message.success(`搜索到 ${newImages.length} 张图片`)
    } catch (err) {
      message.error('搜索图片失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setSearchingImages(false) }
  }

  const handleSetFeaturedImage = (index) => {
    setFeaturedImageIndex(index)
    message.success('已设为头图')
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
                <div>
                  <Typography.Text>发布到网站：</Typography.Text>
                  <Switch checked={publishToSite} onChange={(v) => { setPublishToSite(v); if (!v) setSelectedSiteId(null) }} style={{ marginLeft: 8 }} />
                </div>
              </Space>
              {publishToSite && (
                <div style={{ marginTop: 12 }}>
                  <Select
                    placeholder="选择目标网站"
                    value={selectedSiteId}
                    onChange={setSelectedSiteId}
                    style={{ width: 300 }}
                    options={siteList.map(s => ({ value: s.id, label: `${s.site_name}${s.domain ? ` (${s.domain})` : ''}` }))}
                    notFoundContent="暂无可用网站，请先在网站管理中添加"
                  />
                </div>
              )}
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

        {/* Step 0: 输入商家信息（OPT-015 双入口） */}
        {mStep === 0 && (
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <Segmented
                value={inputMode}
                onChange={setInputMode}
                options={[
                  { value: 'platform', label: '从平台获取', icon: <ThunderboltOutlined /> },
                  { value: 'manual', label: '手动输入', icon: <FileTextOutlined /> },
                ]}
                size="large"
              />
            </div>

            {inputMode === 'platform' ? (
              <>
                {userPlatforms.length === 0 ? (
                  <Alert
                    type="info"
                    showIcon
                    message="你还没有已配置的平台账号"
                    description="请先在「联盟账号管理」中添加平台账号，或切换到「手动输入」模式直接粘贴追踪链接。"
                    style={{ marginBottom: 16 }}
                    action={<Button size="small" onClick={() => setInputMode('manual')}>手动输入</Button>}
                  />
                ) : (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Typography.Title level={5}>选择平台</Typography.Title>
                        <Select
                          placeholder="选择平台"
                          value={selectedPlatform}
                          onChange={setSelectedPlatform}
                          options={userPlatforms.map(p => ({ value: p.platform_code, label: p.platform_name }))}
                          style={{ width: '100%' }}
                          size="large"
                        />
                      </Col>
                      <Col span={12}>
                        <Typography.Title level={5}>商家 MID</Typography.Title>
                        <Input
                          placeholder="输入商家 MID"
                          value={merchantMid}
                          onChange={e => setMerchantMid(e.target.value)}
                          size="large"
                        />
                      </Col>
                    </Row>

                    <Button
                      type="primary"
                      icon={<SearchOutlined />}
                      onClick={handleFetchCampaignLink}
                      loading={fetchingCampaign}
                      style={{ marginTop: 16 }}
                      block
                      size="large"
                    >
                      获取 Campaign Link
                    </Button>
                  </>
                )}

                {campaignResult && (
                  <div style={{ marginTop: 24 }}>
                    <Card size="small" style={{ background: '#f6ffed', marginBottom: 16 }}>
                      <Descriptions column={1} size="small">
                        <Descriptions.Item label="商家名称">{campaignResult.merchant_name || '-'}</Descriptions.Item>
                        <Descriptions.Item label="Campaign Link">
                          {campaignResult.campaign_link ? (
                            <Typography.Text copyable style={{ color: '#52c41a' }}>{campaignResult.campaign_link}</Typography.Text>
                          ) : (
                            <Tag color="warning">未返回</Tag>
                          )}
                        </Descriptions.Item>
                        <Descriptions.Item label="商家网址">{campaignResult.site_url || '-'}</Descriptions.Item>
                        {campaignResult.categories && (
                          <Descriptions.Item label="品类">{campaignResult.categories}</Descriptions.Item>
                        )}
                        {campaignResult.commission_rate && (
                          <Descriptions.Item label="佣金率">{campaignResult.commission_rate}</Descriptions.Item>
                        )}
                      </Descriptions>
                    </Card>

                    {campaignResult.support_regions?.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <Typography.Title level={5}>选择 Support Region</Typography.Title>
                        <Select
                          placeholder="选择目标区域"
                          value={selectedRegion}
                          onChange={handleRegionSelect}
                          style={{ width: '100%' }}
                          options={campaignResult.support_regions.map(r => ({
                            value: r.code,
                            label: `${r.code} — ${r.language}`,
                          }))}
                        />
                        {selectedRegion && (
                          <div style={{ marginTop: 8 }}>
                            <Typography.Text>文章语言：</Typography.Text>
                            <Tag color="blue" style={{ marginLeft: 8 }}>
                              {campaignResult.support_regions.find(r => r.code === selectedRegion)?.language || language}
                            </Tag>
                          </div>
                        )}
                      </div>
                    )}

                    {campaignResult.support_regions?.length === 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <Typography.Title level={5}>文章语言</Typography.Title>
                        <Select value={language} onChange={setLanguage} options={LANGUAGES} style={{ width: 200 }} />
                      </div>
                    )}

                    {!campaignResult.campaign_link && (
                      <Alert
                        type="warning"
                        message="该商家未返回 Campaign Link"
                        description="建议切换到「手动输入」模式手动粘贴追踪链接"
                        showIcon
                        style={{ marginBottom: 16 }}
                      />
                    )}

                    <Divider />
                    <Button
                      type="primary"
                      icon={<RocketOutlined />}
                      onClick={handlePlatformCrawl}
                      size="large"
                      block
                      disabled={!merchantUrl || !trackingLink}
                    >
                      开始爬取 & AI 分析
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
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
              </>
            )}
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
                <Typography.Title level={5}>
                  商家图片
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    点击图片设为头图，点击 × 移除
                  </Typography.Text>
                </Typography.Title>
                <Space wrap size={[8, 8]}>
                  {merchantImages.map((src, i) => (
                    <div key={i} style={{
                      position: 'relative', display: 'inline-block', cursor: 'pointer',
                      border: i === featuredImageIndex ? '3px solid #1890ff' : '3px solid transparent',
                      borderRadius: 6, padding: 1,
                    }} onClick={() => handleSetFeaturedImage(i)}>
                      {i === featuredImageIndex && (
                        <Tag color="blue" style={{ position: 'absolute', bottom: 4, left: 4, zIndex: 2, margin: 0, fontSize: 11 }}>头图</Tag>
                      )}
                      <Image src={src} width={100} height={100} style={{ objectFit: 'cover', borderRadius: 4 }}
                        preview={false}
                        fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
                        onClick={(e) => { e.stopPropagation(); handleSetFeaturedImage(i) }}
                      />
                      <Button
                        type="text" danger size="small" icon={<DeleteOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleRemoveMerchantImage(i) }}
                        style={{ position: 'absolute', top: -6, right: -6, background: '#fff', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', width: 22, height: 22, padding: 0, minWidth: 22 }}
                      />
                    </div>
                  ))}
                </Space>
                {merchantImages.length < 8 && (
                  <div style={{ marginTop: 8 }}>
                    <Button icon={<SearchOutlined />} loading={searchingImages} onClick={handleSearchMoreImages} size="small">
                      搜索更多图片
                    </Button>
                    <Typography.Text type="warning" style={{ marginLeft: 8, fontSize: 12 }}>
                      当前 {merchantImages.length} 张，建议至少 8 张
                    </Typography.Text>
                  </div>
                )}
              </div>
            )}
            {merchantImages.length === 0 && (
              <div style={{ marginBottom: 16 }}>
                <Alert
                  type="warning"
                  message="未从商家网站获取到图片"
                  description={
                    <Button icon={<SearchOutlined />} loading={searchingImages} onClick={handleSearchMoreImages} style={{ marginTop: 8 }}>
                      搜索商家图片
                    </Button>
                  }
                />
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
                <Typography.Title level={5}>
                  商家图片
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    点击图片设为头图，点击 × 移除
                  </Typography.Text>
                </Typography.Title>
                <Space wrap size={[8, 8]}>
                  {merchantImages.map((src, i) => (
                    <div key={i} style={{
                      position: 'relative', display: 'inline-block', cursor: 'pointer',
                      border: i === featuredImageIndex ? '3px solid #1890ff' : '3px solid transparent',
                      borderRadius: 6, padding: 1,
                    }} onClick={() => handleSetFeaturedImage(i)}>
                      {i === featuredImageIndex && (
                        <Tag color="blue" style={{ position: 'absolute', bottom: 4, left: 4, zIndex: 2, margin: 0, fontSize: 11 }}>头图</Tag>
                      )}
                      <Image src={src} width={120} height={120} style={{ objectFit: 'cover', borderRadius: 4 }}
                        preview={false}
                        fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
                        onClick={(e) => { e.stopPropagation(); handleSetFeaturedImage(i) }}
                      />
                      <Button
                        type="text" danger size="small" icon={<DeleteOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleRemoveMerchantImage(i) }}
                        style={{ position: 'absolute', top: -6, right: -6, background: '#fff', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', width: 22, height: 22, padding: 0, minWidth: 22 }}
                      />
                    </div>
                  ))}
                </Space>
                {merchantImages.length < 8 && (
                  <div style={{ marginTop: 8 }}>
                    <Button icon={<SearchOutlined />} loading={searchingImages} onClick={handleSearchMoreImages} size="small">
                      搜索更多图片
                    </Button>
                  </div>
                )}
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
              <div>
                <Typography.Text>发布到网站：</Typography.Text>
                <Switch checked={publishToSite} onChange={(v) => { setPublishToSite(v); if (!v) setSelectedSiteId(null) }} style={{ marginLeft: 8 }} />
              </div>
            </Space>
            {publishToSite && (
              <div style={{ marginTop: 12 }}>
                <Select
                  placeholder="选择目标网站"
                  value={selectedSiteId}
                  onChange={setSelectedSiteId}
                  style={{ width: 300 }}
                  options={siteList.map(s => ({ value: s.id, label: `${s.site_name}${s.domain ? ` (${s.domain})` : ''}` }))}
                  notFoundContent="暂无可用网站，请先在网站管理中添加"
                />
              </div>
            )}
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
