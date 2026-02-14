import React, { useState } from 'react'
import { Card, Row, Col, Input, Button, Select, Spin, Typography, Space, message, Divider, Tooltip, Tag } from 'antd'
import { RocketOutlined, CopyOutlined, GlobalOutlined, PictureOutlined, CheckOutlined, ReloadOutlined } from '@ant-design/icons'
import api from '../services/api'

const { Text, Title, Paragraph } = Typography
const { TextArea } = Input

const AdCopyGenerator = () => {
  // 输入状态
  const [productUrl, setProductUrl] = useState('')
  const [keywords, setKeywords] = useState('')
  const [targetCountry, setTargetCountry] = useState('US')
  
  // 加载状态
  const [loading, setLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  
  // 粘贴图片状态
  const [pastedImage, setPastedImage] = useState(null)
  
  // 生成结果
  const [result, setResult] = useState(null)
  
  // 复制状态
  const [copiedItems, setCopiedItems] = useState({})

  // 国家选项
  const countryOptions = [
    { value: 'US', label: '🇺🇸 美国 (US)' },
    { value: 'UK', label: '🇬🇧 英国 (UK)' },
    { value: 'DE', label: '🇩🇪 德国 (DE)' },
    { value: 'FR', label: '🇫🇷 法国 (FR)' },
    { value: 'ES', label: '🇪🇸 西班牙 (ES)' },
    { value: 'IT', label: '🇮🇹 意大利 (IT)' },
    { value: 'AU', label: '🇦🇺 澳大利亚 (AU)' },
    { value: 'CA', label: '🇨🇦 加拿大 (CA)' },
    { value: 'JP', label: '🇯🇵 日本 (JP)' },
    { value: 'KR', label: '🇰🇷 韩国 (KR)' },
  ]

  // 复制到剪贴板
  const copyToClipboard = (text, key) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedItems(prev => ({ ...prev, [key]: true }))
      message.success('已复制')
      setTimeout(() => {
        setCopiedItems(prev => ({ ...prev, [key]: false }))
      }, 2000)
    })
  }

  // 处理粘贴截图
  const handlePaste = async (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile()
        if (file) {
          e.preventDefault()
          await recognizeImage(file)
          break
        }
      }
    }
  }

  // 识别图片中的关键词
  const recognizeImage = async (file) => {
    setImageLoading(true)
    setPastedImage(URL.createObjectURL(file))
    
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('prompt', `请仔细分析这张关键词工具截图，提取所有可见的关键词。

要求：
1. 只提取关键词本身，不要搜索量、竞争度等数据
2. 每个关键词用逗号分隔
3. 直接输出关键词列表，不要任何解释

例如输出格式：wireless earbuds, bluetooth headphones, earphones wireless`)
      
      const res = await api.post('/api/gemini/analyze-image', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      
      if (res.data.success) {
        setKeywords(res.data.analysis)
        message.success('关键词识别成功！')
      } else {
        message.error(res.data.message || '识别失败')
      }
    } catch (error) {
      message.error('识别失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setImageLoading(false)
    }
  }

  // 生成广告词
  const generateAdCopy = async () => {
    if (!productUrl.trim()) {
      message.warning('请输入产品链接 URL')
      return
    }
    if (!keywords.trim()) {
      message.warning('请输入关键词或粘贴截图识别')
      return
    }
    
    setLoading(true)
    setResult(null)
    
    try {
      const keywordList = keywords.split(/[,，\n]+/).filter(k => k.trim())
      const res = await api.post('/api/gemini/recommend-keywords', {
        keywords: keywordList,
        product_url: productUrl,
        target_country: targetCountry
      })
      
      if (res.data.success) {
        // 解析返回的文本，提取结构化数据
        const parsed = parseAdCopyResult(res.data.recommendations)
        setResult({
          raw: res.data.recommendations,
          parsed,
          keywords: keywordList,
          country: res.data.country_name,
          language: res.data.language,
          currency: res.data.currency,
          url: productUrl
        })
      } else {
        message.error(res.data.message || '生成失败')
      }
    } catch (error) {
      message.error('生成失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setLoading(false)
    }
  }

  // 解析广告词结果
  const parseAdCopyResult = (text) => {
    const result = {
      businessInfo: '',
      keywords: [],
      headlines: [],
      descriptions: [],
      sitelinks: []
    }
    
    // 简单解析，提取关键信息
    const lines = text.split('\n')
    let currentSection = ''
    
    for (const line of lines) {
      const trimmed = line.trim()
      
      if (trimmed.includes('主营业务') || trimmed.includes('1.1')) {
        currentSection = 'business'
      } else if (trimmed.includes('关键词') || trimmed.includes('1.2')) {
        currentSection = 'keywords'
      } else if (trimmed.includes('Headlines') || trimmed.includes('广告标题') || trimmed.includes('1.3')) {
        currentSection = 'headlines'
      } else if (trimmed.includes('Descriptions') || trimmed.includes('广告描述')) {
        currentSection = 'descriptions'
      } else if (trimmed.includes('附加链接') || trimmed.includes('Sitelink') || trimmed.includes('1.4')) {
        currentSection = 'sitelinks'
      }
      
      // 提取标题（格式：| 1 | xxx | xxx | 24 |）
      if (currentSection === 'headlines' && trimmed.startsWith('|') && !trimmed.includes('---') && !trimmed.includes('#')) {
        const parts = trimmed.split('|').map(p => p.trim()).filter(p => p)
        if (parts.length >= 3 && !isNaN(parseInt(parts[0]))) {
          result.headlines.push({
            num: parts[0],
            en: parts[1],
            zh: parts[2],
            chars: parts[3] || ''
          })
        }
      }
      
      // 提取描述
      if (currentSection === 'descriptions' && trimmed.startsWith('|') && !trimmed.includes('---') && !trimmed.includes('#')) {
        const parts = trimmed.split('|').map(p => p.trim()).filter(p => p)
        if (parts.length >= 3 && !isNaN(parseInt(parts[0]))) {
          result.descriptions.push({
            num: parts[0],
            en: parts[1],
            zh: parts[2],
            chars: parts[3] || ''
          })
        }
      }
      
      // 提取附加链接（新格式：标题 | URL | 描述1 | 描述2）
      if (currentSection === 'sitelinks' && trimmed.startsWith('|') && !trimmed.includes('---') && !trimmed.includes('附加链接') && !trimmed.includes('标题')) {
        const parts = trimmed.split('|').map(p => p.trim()).filter(p => p)
        // 新格式：4列（标题、URL、描述1、描述2）
        if (parts.length >= 4 && parts[0] && !parts[0].includes('#') && !parts[0].includes('分类')) {
          result.sitelinks.push({
            title: parts[0],
            url: parts[1],
            desc1: parts[2],
            desc2: parts[3] || ''
          })
        } 
        // 兼容旧格式：3列（标题、描述1、描述2）
        else if (parts.length >= 3 && parts[0] && !parts[0].includes('#') && !parts[0].includes('分类')) {
          result.sitelinks.push({
            title: parts[0],
            url: '',
            desc1: parts[1],
            desc2: parts[2] || ''
          })
        }
      }
      
      // 提取关键词（格式：[xxx] 或 "xxx"）
      if (currentSection === 'keywords') {
        const matches = trimmed.match(/[\["\u201c]([^\]"\u201d]+)[\]"\u201d]/g)
        if (matches) {
          matches.forEach(m => {
            const kw = m.replace(/[\[\]""\u201c\u201d]/g, '').trim()
            if (kw && !result.keywords.includes(kw)) {
              result.keywords.push(kw)
            }
          })
        }
      }
    }
    
    return result
  }

  // 可复制的项目组件
  const CopyableItem = ({ text, label, itemKey }) => (
    <div style={{ 
      display: 'flex', 
      justifyContent: 'space-between', 
      alignItems: 'center',
      padding: '8px 12px',
      background: '#fafafa',
      borderRadius: 6,
      marginBottom: 8,
      border: '1px solid #f0f0f0'
    }}>
      <div style={{ flex: 1 }}>
        {label && <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>}
        <div style={{ fontFamily: 'monospace' }}>{text}</div>
      </div>
      <Tooltip title={copiedItems[itemKey] ? '已复制' : '点击复制'}>
        <Button 
          type="text" 
          icon={copiedItems[itemKey] ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
          onClick={() => copyToClipboard(text, itemKey)}
        />
      </Tooltip>
    </div>
  )

  return (
    <div style={{ padding: 24 }}>
      <Title level={2}>🚀 AI 广告词生成器</Title>
      <Text type="secondary">基于产品链接生成真实的广告标题、描述和附加链接，支持截图识别关键词</Text>
      
      <Row gutter={24} style={{ marginTop: 24 }}>
        {/* 左侧：输入区 */}
        <Col span={8}>
          <Card title="📝 输入信息" style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 16 }}>
              <Text strong>产品链接 URL <Text type="danger">*</Text></Text>
              <Input
                placeholder="https://www.example.com"
                value={productUrl}
                onChange={(e) => setProductUrl(e.target.value)}
                prefix={<GlobalOutlined />}
                style={{ marginTop: 8 }}
                size="large"
              />
            </div>
            
            <div style={{ marginBottom: 16 }}>
              <Text strong>目标国家</Text>
              <Select
                value={targetCountry}
                onChange={setTargetCountry}
                options={countryOptions}
                style={{ width: '100%', marginTop: 8 }}
                size="large"
              />
            </div>
            
            <Divider>关键词</Divider>
            
            {/* 粘贴截图区域 */}
            <div
              onPaste={handlePaste}
              tabIndex={0}
              style={{
                border: pastedImage ? '2px solid #52c41a' : '2px dashed #d9d9d9',
                borderRadius: 8,
                padding: 16,
                marginBottom: 16,
                background: pastedImage ? '#f6ffed' : '#fafafa',
                cursor: 'pointer',
                textAlign: 'center',
                minHeight: 100
              }}
            >
              {imageLoading ? (
                <div>
                  <Spin />
                  <p style={{ marginTop: 8, color: '#4DA6FF' }}>AI 正在识别关键词...</p>
                </div>
              ) : pastedImage ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Tag color="success">✅ 截图已识别</Tag>
                    <Button size="small" onClick={() => setPastedImage(null)}>清除</Button>
                  </div>
                  <img src={pastedImage} alt="截图" style={{ maxWidth: '100%', maxHeight: 80, borderRadius: 4 }} />
                </div>
              ) : (
                <div style={{ color: '#999' }}>
                  <PictureOutlined style={{ fontSize: 32, marginBottom: 8 }} />
                  <p style={{ margin: 0 }}><b>Ctrl+V 粘贴截图</b></p>
                  <p style={{ margin: 0, fontSize: 12 }}>从 sem.3ue.co 截图后粘贴</p>
                </div>
              )}
            </div>
            
            <TextArea
              placeholder="输入关键词（每行一个或逗号分隔）"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              rows={4}
              style={{ marginBottom: 16 }}
            />
            
            <Button 
              type="primary" 
              icon={<RocketOutlined />}
              onClick={generateAdCopy}
              loading={loading}
              size="large"
              block
            >
              生成广告词
            </Button>
          </Card>
        </Col>
        
        {/* 右侧：结果区 */}
        <Col span={16}>
          {loading ? (
            <Card>
              <div style={{ textAlign: 'center', padding: 60 }}>
                <Spin size="large" />
                <p style={{ marginTop: 16 }}>AI 正在分析网站并生成广告词...</p>
                <p style={{ color: '#999', fontSize: 12 }}>这可能需要 20-40 秒</p>
              </div>
            </Card>
          ) : result ? (
            <div>
              {/* 基本信息 */}
              <Card size="small" style={{ marginBottom: 16 }}>
                <Space wrap>
                  <Tag color="blue">🌍 {result.country}</Tag>
                  <Tag color="green">📝 {result.language}</Tag>
                  <Tag color="orange">💰 {result.currency}</Tag>
                  <a href={result.url} target="_blank" rel="noreferrer">
                    <Tag color="purple">🔗 {result.url}</Tag>
                  </a>
                </Space>
              </Card>

              {/* 关键词 */}
              <Card 
                title="🎯 推荐关键词" 
                size="small" 
                style={{ marginBottom: 16 }}
                extra={
                  <Button 
                    size="small" 
                    icon={<CopyOutlined />}
                    onClick={() => copyToClipboard(result.parsed.keywords.map(k => `[${k}]`).join('\n'), 'all-keywords')}
                  >
                    全部复制
                  </Button>
                }
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {result.parsed.keywords.length > 0 ? (
                    result.parsed.keywords.map((kw, idx) => (
                      <Tag 
                        key={idx} 
                        style={{ cursor: 'pointer', fontSize: 14, padding: '4px 12px' }}
                        onClick={() => copyToClipboard(`[${kw}]`, `kw-${idx}`)}
                      >
                        {copiedItems[`kw-${idx}`] ? '✓' : ''} [{kw}]
                      </Tag>
                    ))
                  ) : (
                    result.keywords.map((kw, idx) => (
                      <Tag 
                        key={idx} 
                        style={{ cursor: 'pointer', fontSize: 14, padding: '4px 12px' }}
                        onClick={() => copyToClipboard(`[${kw}]`, `kw-${idx}`)}
                      >
                        {copiedItems[`kw-${idx}`] ? '✓' : ''} [{kw}]
                      </Tag>
                    ))
                  )}
                </div>
              </Card>

              {/* 广告标题 */}
              <Card 
                title="📌 广告标题 (Headlines)" 
                size="small" 
                style={{ marginBottom: 16 }}
                extra={
                  <Button 
                    size="small" 
                    icon={<CopyOutlined />}
                    onClick={() => copyToClipboard(result.parsed.headlines.map(h => h.en).join('\n'), 'all-headlines')}
                  >
                    全部复制
                  </Button>
                }
              >
                {result.parsed.headlines.length > 0 ? (
                  result.parsed.headlines.map((h, idx) => (
                    <CopyableItem 
                      key={idx}
                      text={h.en}
                      label={`#${h.num} · ${h.zh} · ${h.chars}字符`}
                      itemKey={`headline-${idx}`}
                    />
                  ))
                ) : (
                  <Paragraph style={{ whiteSpace: 'pre-wrap', background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
                    {result.raw}
                  </Paragraph>
                )}
              </Card>

              {/* 广告描述 */}
              <Card 
                title="📝 广告描述 (Descriptions)" 
                size="small" 
                style={{ marginBottom: 16 }}
                extra={
                  <Button 
                    size="small" 
                    icon={<CopyOutlined />}
                    onClick={() => copyToClipboard(result.parsed.descriptions.map(d => d.en).join('\n'), 'all-descriptions')}
                  >
                    全部复制
                  </Button>
                }
              >
                {result.parsed.descriptions.map((d, idx) => (
                  <CopyableItem 
                    key={idx}
                    text={d.en}
                    label={`#${d.num} · ${d.zh} · ${d.chars}字符`}
                    itemKey={`desc-${idx}`}
                  />
                ))}
              </Card>

              {/* 附加链接 */}
              <Card 
                title="🔗 附加链接 (Sitelinks)" 
                size="small"
              >
                {result.parsed.sitelinks.map((s, idx) => (
                  <div key={idx} style={{ 
                    padding: 12, 
                    background: '#fafafa', 
                    borderRadius: 8, 
                    marginBottom: 12,
                    border: '1px solid #f0f0f0'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text strong style={{ fontSize: 16 }}>{s.title}</Text>
                      <Space size="small">
                        <Button 
                          size="small" 
                          icon={<CopyOutlined />}
                          onClick={() => copyToClipboard(s.title, `sitelink-title-${idx}`)}
                        >
                          复制标题
                        </Button>
                        {s.url && (
                          <Button 
                            size="small" 
                            type="link"
                            icon={<CopyOutlined />}
                            onClick={() => copyToClipboard(s.url, `sitelink-url-${idx}`)}
                          >
                            复制链接
                          </Button>
                        )}
                      </Space>
                    </div>
                    {/* 显示真实链接 URL */}
                    {s.url && (
                      <div style={{ marginBottom: 8 }}>
                        <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#4DA6FF' }}>
                          🔗 {s.url}
                        </a>
                        {copiedItems[`sitelink-url-${idx}`] && <Tag color="success" style={{ marginLeft: 8 }}>✓ 已复制</Tag>}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <Tag 
                        style={{ cursor: 'pointer' }}
                        onClick={() => copyToClipboard(s.desc1, `sitelink-desc1-${idx}`)}
                      >
                        描述1: {s.desc1} {copiedItems[`sitelink-desc1-${idx}`] && '✓'}
                      </Tag>
                      <Tag 
                        style={{ cursor: 'pointer' }}
                        onClick={() => copyToClipboard(s.desc2, `sitelink-desc2-${idx}`)}
                      >
                        描述2: {s.desc2} {copiedItems[`sitelink-desc2-${idx}`] && '✓'}
                      </Tag>
                    </div>
                  </div>
                ))}
              </Card>

              {/* 重新生成 */}
              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <Button icon={<ReloadOutlined />} onClick={generateAdCopy}>
                  重新生成
                </Button>
              </div>
            </div>
          ) : (
            <Card>
              <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                <RocketOutlined style={{ fontSize: 64, marginBottom: 16 }} />
                <Title level={4} type="secondary">输入产品链接和关键词</Title>
                <Text type="secondary">AI 将生成：</Text>
                <div style={{ marginTop: 16 }}>
                  <Tag>17条广告标题</Tag>
                  <Tag>6条广告描述</Tag>
                  <Tag>6条附加链接</Tag>
                </div>
                <Paragraph style={{ marginTop: 16, fontSize: 12 }}>
                  折扣和物流信息将从产品链接中抓取，确保真实有效
                </Paragraph>
              </div>
            </Card>
          )}
        </Col>
      </Row>
    </div>
  )
}

export default AdCopyGenerator

