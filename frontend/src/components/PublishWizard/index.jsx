import React, { useState, useEffect, useRef } from 'react'
import {
  Steps, Card, Input, Button, Space, List, Tag, Checkbox, DatePicker,
  Switch, message, Spin, Typography, Divider, Radio, Select, AutoComplete,
  Row, Col, Image, Segmented, Descriptions, Alert, Upload, Tooltip,
} from 'antd'
import {
  RocketOutlined, CheckOutlined, PlusOutlined, DeleteOutlined,
  ShopOutlined, FileTextOutlined, GlobalOutlined, LinkOutlined,
  SearchOutlined, ThunderboltOutlined, InboxOutlined, UploadOutlined,
  ClockCircleOutlined, EyeOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import articleApi from '../../services/articleApi'
import api from '../../services/api'
import { usePublishDrawer } from '../../store/publishDrawerStore'

const { TextArea } = Input
const { Dragger } = Upload

// 图片代理：通过后端转发，绕过商家网站防盗链
// CR-040: 缓存图片直接用 cache_url（已下载到后端），图库图直接用原始 URL
const proxyImg = (url) => {
  if (!url) return '';
  // CR-040: 缓存图片 URL（/api/article-gen/image-cache/...）直接拼接后端域名
  if (url.startsWith('/api/article-gen/image-cache/')) {
    const apiBase = api.defaults?.baseURL || '';
    return `${apiBase}${url}`;
  }
  if (/pexels\.com|unsplash\.com|images\.pexels/i.test(url)) return url;
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  const apiBase = api.defaults?.baseURL || '';
  return `${apiBase}/api/article-gen/image-proxy?url=${encodeURIComponent(url)}`;
};

// CR-040: 从图片对象或字符串中提取显示 URL
const getImgDisplayUrl = (img) => {
  if (!img) return '';
  if (typeof img === 'string') return proxyImg(img);
  return proxyImg(img.cache_url || img.url || '');
};

// CR-040: 从图片对象或字符串中提取提交用的值
const getImgSubmitValue = (img) => {
  if (!img) return '';
  if (typeof img === 'string') return img;
  return img.cache_url || img.url || '';
};

const LANGUAGES = [
  { value: 'en', label: 'English (en)' },
  { value: 'zh', label: '中文 (zh)' },
  { value: 'de', label: 'Deutsch (de)' },
  { value: 'fr', label: 'Français (fr)' },
  { value: 'es', label: 'Español (es)' },
  { value: 'it', label: 'Italiano (it)' },
  { value: 'pt', label: 'Português (pt)' },
  { value: 'nl', label: 'Nederlands (nl)' },
  { value: 'pl', label: 'Polski (pl)' },
  { value: 'ja', label: '日本語 (ja)' },
  { value: 'ko', label: '한국어 (ko)' },
  { value: 'ru', label: 'Русский (ru)' },
  { value: 'tr', label: 'Türkçe (tr)' },
  { value: 'sv', label: 'Svenska (sv)' },
  { value: 'da', label: 'Dansk (da)' },
  { value: 'no', label: 'Norsk (no)' },
  { value: 'fi', label: 'Suomi (fi)' },
  { value: 'th', label: 'ไทย (th)' },
  { value: 'vi', label: 'Tiếng Việt (vi)' },
  { value: 'id', label: 'Bahasa Indonesia (id)' },
  { value: 'hi', label: 'हिन्दी (hi)' },
  { value: 'ar', label: 'العربية (ar)' },
  { value: 'he', label: 'עברית (he)' },
  { value: 'el', label: 'Ελληνικά (el)' },
  { value: 'cs', label: 'Čeština (cs)' },
  { value: 'hu', label: 'Magyar (hu)' },
  { value: 'ro', label: 'Română (ro)' },
]

// 常用国家代码 → 语言映射
const COUNTRY_LANG_MAP = {
  'de': 'de', 'at': 'de', 'ch': 'de',
  'fr': 'fr', 'be': 'fr',
  'es': 'es', 'mx': 'es', 'ar': 'es',
  'it': 'it',
  'pt': 'pt', 'br': 'pt',
  'nl': 'nl',
  'pl': 'pl',
  'se': 'sv', 'dk': 'da', 'no': 'no', 'fi': 'fi',
  'jp': 'ja', 'kr': 'ko', 'cn': 'zh', 'tw': 'zh',
  'us': 'en', 'gb': 'en', 'uk': 'en', 'au': 'en', 'ca': 'en', 'nz': 'en', 'ie': 'en',
  'ru': 'ru', 'tr': 'tr', 'th': 'th', 'vn': 'vi', 'id': 'id',
  'in': 'hi', 'sa': 'ar', 'ae': 'ar', 'eg': 'ar',
  'cz': 'cs', 'sk': 'sk', 'hu': 'hu', 'ro': 'ro', 'bg': 'bg', 'hr': 'hr',
  'gr': 'el', 'il': 'he',
}

const PublishWizard = ({ drawerMode = false }) => {
  const navigate = useNavigate()
  const { setProcessing: setDrawerProcessing, closeDrawer } = usePublishDrawer()
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
  // merchantImages removed - replaced by selectedImages + crawledImages + stockImages
  const [mPublishDate, setMPublishDate] = useState(null)
  const [mEnableLinks, setMEnableLinks] = useState(true)
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
  const [publishToSite, setPublishToSite] = useState(true)
  const [siteList, setSiteList] = useState([])
  const [selectedSiteId, setSelectedSiteId] = useState(null)
  const [publishingSite, setPublishingSite] = useState(false)

  // === 图片双区域 State ===
  const [selectedImages, setSelectedImages] = useState([])       // 文章用图（位置0=头图），CR-040: 对象 {url, cache_url, source} 或字符串
  const [crawledImages, setCrawledImages] = useState([])         // 网站爬取的待选图（CR-040: 对象数组）
  const [stockImages, setStockImages] = useState([])             // 图片库待选图（字符串或对象）
  const [imagePoolMode, setImagePoolMode] = useState('crawl')    // 'crawl' | 'stock'
  const [searchingImages, setSearchingImages] = useState(false)
  const [poolPreviewSrc, setPoolPreviewSrc] = useState('')
  const [poolPreviewOpen, setPoolPreviewOpen] = useState(false)
  const [imageCacheSession, setImageCacheSession] = useState('') // CR-040: 缓存会话 ID

  // === 手动上传图片 State ===
  const [manualHeroFile, setManualHeroFile] = useState(null)       // 头图文件
  const [manualContentFiles, setManualContentFiles] = useState([]) // 内容图文件列表
  const [manualHeroPreview, setManualHeroPreview] = useState('')
  const [manualContentPreviews, setManualContentPreviews] = useState([])
  const [countryCode, setCountryCode] = useState('')               // 国家代码

  const _buildImageSearchQuery = (resData) => {
    const brand = resData?.brand_name || ''
    if (brand) return `${brand} products`
    const products = resData?.analysis?.products
    if (Array.isArray(products) && products.length > 0) return products.slice(0, 3).join(', ')
    if (typeof products === 'string' && products) return products.slice(0, 60)
    const category = resData?.analysis?.category
    if (category && category !== 'general') return `${category} products lifestyle`
    try {
      const domain = new URL(resData?.url || '').hostname.replace('www.', '').split('.')[0]
      if (domain && domain.length > 2) return `${domain} brand products`
    } catch (_e) { /* ignore */ }
    return 'online shopping products'
  }

  // === 手动上传图片处理 ===
  const fileToDataUrl = (file) => new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.readAsDataURL(file)
  })

  // CR-040: 上传图片到缓存 API
  const uploadToImageCache = async (file) => {
    if (!imageCacheSession) {
      // 如果还没有缓存会话（比如没爬虫直接上传），先用 data URL
      const dataUrl = await fileToDataUrl(file)
      return { cache_url: dataUrl, url: dataUrl, source: 'upload' }
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      const res = await api.post('/api/article-gen/image-cache/upload-base64', {
        session_id: imageCacheSession,
        filename: file.name || 'upload.jpg',
        data_base64: dataUrl,
      })
      return res.data  // {cache_url, original_url, source, width, height}
    } catch (e) {
      // 上传到缓存失败，回退到 data URL
      const dataUrl = await fileToDataUrl(file)
      return { cache_url: dataUrl, url: dataUrl, source: 'upload' }
    }
  }

  const handleHeroDrop = async (info) => {
    const file = info.file?.originFileObj || info.file
    if (!file) return
    setManualHeroFile(file)
    const preview = await fileToDataUrl(file)
    setManualHeroPreview(preview)
  }

  const handleContentDrop = async (info) => {
    const file = info.file?.originFileObj || info.file
    if (!file) return
    if (manualContentFiles.length >= 4) {
      message.warning('最多上传 4 张内容图')
      return
    }
    const newFiles = [...manualContentFiles, file]
    setManualContentFiles(newFiles)
    const preview = await fileToDataUrl(file)
    setManualContentPreviews(prev => [...prev, preview])
  }

  const handleRemoveContentImg = (index) => {
    setManualContentFiles(prev => prev.filter((_, i) => i !== index))
    setManualContentPreviews(prev => prev.filter((_, i) => i !== index))
  }

  const handleRemoveHeroImg = () => {
    setManualHeroFile(null)
    setManualHeroPreview('')
  }

  // 国家代码 → 语言自动映射
  const handleCountryCodeChange = (val) => {
    const code = val.toLowerCase().trim()
    setCountryCode(code)
    const lang = COUNTRY_LANG_MAP[code]
    if (lang) setLanguage(lang)
  }

  // 手动模式：跳过爬虫，直接进入 AI 分析（用上传的图片）
  const handleManualSubmit = async () => {
    if (!merchantUrl.trim()) { message.warning('请输入商家网址'); return }
    if (!trackingLink.trim()) { message.warning('请输入追踪链接'); return }
    if (!manualHeroFile) { message.warning('请上传头图（拖入第一个框）'); return }
    if (!countryCode.trim()) { message.warning('请输入国家代码（如 de, us, fr）'); return }

    // 将上传的图片转为 data URL 放入 selectedImages
    const heroUrl = manualHeroPreview
    const contentUrls = [...manualContentPreviews]
    setSelectedImages([heroUrl, ...contentUrls])
    setCrawledImages([])
    setStockImages([])

    setLoading(true)
    if (drawerMode) setDrawerProcessing(true, '正在爬取 & AI 分析…')
    try {
      const res = await articleApi.crawlMerchant({ url: merchantUrl, language, merchant_name: campaignResult?.merchant_name || '' })
      const resData = res.data
      setCrawlResult(resData)
      _autoSelectTitleAndKeywords(resData)
      setCrawledImages(resData?.images || [])
      setMStep(1)
    } catch (err) {
      const detail = err?.response?.data?.detail || err.message || '未知错误'
      const isTimeout = err.code === 'ECONNABORTED' || detail.includes('timeout')
      message.info(isTimeout ? '爬取超时，正在用 AI 分析...' : `爬取失败(${detail.slice(0,50)})，正在用 AI 分析...`)
      try {
        const aiRes = await articleApi.analyzeUrl({ url: merchantUrl, language, merchant_name: campaignResult?.merchant_name || '' })
        const aiData = aiRes.data
        const analysis = aiData?.analysis || {}
        const crawlData = {
          brand_name: aiData?.brand_name || '',
          url: merchantUrl,
          analysis,
        }
        setCrawlResult(crawlData)
        _autoSelectTitleAndKeywords(crawlData)
        message.success('AI 分析完成，已自动选择标题和关键词')
      } catch (_aiErr) {
        message.warning('AI 分析也失败了，请手动输入标题和关键词')
        setCrawlResult({ brand_name: '', url: merchantUrl, analysis: { titles: [], keywords: [], products: [], selling_points: [], promotions: '' } })
        setMerchantTitles([])
        setMerchantKeywords([])
      }
      setCrawledImages([])
      setMStep(1)
    } finally {
      setLoading(false)
      if (drawerMode) setDrawerProcessing(false)
    }
  }

  // 自动选择标题和关键词的辅助函数
  const _autoSelectTitleAndKeywords = (resData) => {
    const titles = resData?.analysis?.titles || []
    const keywords = resData?.analysis?.keywords || []
    setMerchantTitles(titles)
    setMerchantKeywords(keywords)
    // 自动选择第一个标题
    if (titles.length > 0) {
      const t = titles[0]
      let firstTitle
      if (typeof t === 'string') {
        firstTitle = t
      } else if (language === 'en') {
        firstTitle = t.title_en || t.title
      } else {
        firstTitle = (t.title && t.title !== t.title_en) ? t.title : (t.title_en || t.title)
      }
      setSelectedMTitle(firstTitle)
    }
    // 自动选择所有关键词
    if (keywords.length > 0) {
      setSelectedMKeywords(keywords)
    }
  }

  const _applyCrawlImages = async (resData) => {
    setCrawlResult(resData)
    _autoSelectTitleAndKeywords(resData)

    // CR-040: 保存缓存会话 ID
    const cacheSession = resData?.image_cache_session || ''
    setImageCacheSession(cacheSession)

    // CR-040: images 现在是对象数组 [{cache_url, original_url, source, width, height}]
    const imgs = resData?.images || []
    // stock_images 是对象数组 [{url, source}] 或字符串数组（不走缓存）
    const backendStockImgs = (resData?.stock_images || []).map(s =>
      typeof s === 'string' ? { url: s, source: 'stock' } : s
    )
    setCrawledImages(imgs)
    if (backendStockImgs.length > 0) {
      setStockImages(backendStockImgs)
    } else {
      setStockImages([])
    }

    if (imgs.length === 0 && backendStockImgs.length > 0) {
      // 爬取 0 张，但后端已补充图库图片
      setImagePoolMode('stock')
      setSelectedImages([])  // 不自动预选，让员工自己选
    } else if (imgs.length === 0 && backendStockImgs.length === 0) {
      // 爬取 0 张，后端也没补充 → 前端自行搜索图库
      setImagePoolMode('stock')
      const query = _buildImageSearchQuery(resData)
      setSearchingImages(true)
      try {
        const stockRes = await articleApi.searchImages({ query, count: 16 })
        const stockImgs = (stockRes.data?.images || []).map(s =>
          typeof s === 'string' ? { url: s, source: 'stock' } : s
        )
        setStockImages(stockImgs)
        // 不自动预选，让员工自己选
      } catch (_e) { /* ignore */ }
      finally { setSearchingImages(false) }
    } else {
      // 有爬取图片（已缓存）
      setSelectedImages([])  // 不自动预选，让员工自己选
      setImagePoolMode('crawl')
    }
    // 跳到图片选择步骤，让员工手动选择图片
    setMStep(1)
  }

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

  // OPT-013: 加载网站列表，如果只有一个网站自动选中
  useEffect(() => {
    if (mode) {
      articleApi.getSites()
        .then(res => {
          const items = res.data?.items || []
          setSiteList(items)
          if (items.length === 1) setSelectedSiteId(items[0].id)
        })
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
        status: (publishDate && publishDate.isAfter(dayjs())) ? 'draft' : 'published',
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
        const isPast = publishDate && publishDate.isBefore(dayjs())
        message.success(publishDate ? (isPast ? '文章已发布（回溯时间）' : '文章已保存，将定时发布') : '文章已发布')
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
      } else if (res.data?.site_url) {
        // CR-019: 有 support_regions 时必须先选语言；无 support_regions 也要从 URL TLD 推断语言
        if (res.data?.support_regions?.length > 0) {
          message.success('已获取 Campaign Link，请先选择目标区域/语言，再点击「开始爬取」')
        } else {
          // 从 URL TLD 推断语言（.de→de, .fr→fr 等），避免用默认 en 爬取
          const tldLang = _inferLangFromUrl(res.data.site_url)
          if (tldLang && tldLang !== language) {
            setLanguage(tldLang)
          }
          message.success('已获取 Campaign Link，正在自动爬取商家网站...')
          setFetchingCampaign(false)
          _autoCrawl(res.data.site_url, res.data.campaign_link, res.data.merchant_name || '', tldLang || language)
          return
        }
      }
    } catch (err) {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail || '获取 Campaign Link 失败'
      if (status === 404) {
        message.warning(detail)
        setInputMode('manual')
      } else if (!err?.response || err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.message?.includes('Network Error')) {
        message.warning('请求超时，平台响应较慢，请再试一次')
      } else {
        message.error(detail)
      }
    } finally { setFetchingCampaign(false) }
  }

  const _inferLangFromUrl = (url) => {
    try {
      const host = new URL(url).hostname
      const tld = host.split('.').pop().toLowerCase()
      const TLD_LANG = { de:'de', fr:'fr', it:'it', es:'es', nl:'nl', pl:'pl', pt:'pt', se:'sv', dk:'da', no:'no', fi:'fi', jp:'ja', kr:'ko', ru:'ru', tr:'tr', th:'th', cz:'cs', at:'de', ch:'de', be:'fr', br:'pt' }
      return TLD_LANG[tld] || null
    } catch { return null }
  }

  const _autoCrawl = async (siteUrl, link, merchantName, lang) => {
    setLoading(true)
    if (drawerMode) setDrawerProcessing(true, '正在爬取商家网站…')
    const crawlLang = lang || language
    const crawlMerchantName = merchantName || ''
    try {
      const res = await articleApi.crawlMerchant({ url: siteUrl, language: crawlLang, merchant_name: crawlMerchantName })
      await _applyCrawlImages(res.data)
    } catch (err) {
      const detail = err?.response?.data?.detail || err.message || '未知错误'
      const isTimeout = err.code === 'ECONNABORTED' || detail.includes('timeout')
      const msg = isTimeout
        ? '爬取超时，请稍后手动点击"爬取商家网站"重试'
        : `爬取失败: ${detail}，请选择图片后继续`
      message.warning(msg)
      setCrawlResult({ brand_name: '', url: siteUrl, analysis: { titles: [], keywords: [], products: [], selling_points: [], promotions: '' } })
      setMerchantTitles([])
      setMerchantKeywords([])
      setCrawledImages([])
      setMStep(1)
    } finally {
      setLoading(false)
      if (drawerMode) setDrawerProcessing(false)
    }
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
    if (drawerMode) setDrawerProcessing(true, '正在爬取 & AI 分析…')
    const mName = campaignResult?.merchant_name || ''
    try {
      const res = await articleApi.crawlMerchant({ url: merchantUrl, language, merchant_name: mName })
      await _applyCrawlImages(res.data)
    } catch (err) {
      const detail = err?.response?.data?.detail || err.message || '未知错误'
      const isTimeout = err.code === 'ECONNABORTED' || detail.includes('timeout')
      message.info(isTimeout ? '爬取超时，正在用 AI 分析...' : `爬取失败(${detail.slice(0,50)})，正在用 AI 分析...`)
      try {
        const aiRes = await articleApi.analyzeUrl({ url: merchantUrl, language, merchant_name: mName })
        const aiData = aiRes.data
        const analysis = aiData?.analysis || {}
        const crawlData = {
          brand_name: aiData?.brand_name || '',
          url: merchantUrl,
          analysis,
        }
        setCrawlResult(crawlData)
        _autoSelectTitleAndKeywords(crawlData)
        message.success('AI 分析完成，已自动选择标题和关键词')
      } catch (_aiErr) {
        message.warning('AI 分析也失败了，请在确认页面手动输入标题和关键词')
        setCrawlResult({ brand_name: '', url: merchantUrl, analysis: { titles: [], keywords: [], products: [], selling_points: [], promotions: '' } })
        setMerchantTitles([])
        setMerchantKeywords([])
      }
      setCrawledImages([])
      setMStep(1)
    } finally {
      setLoading(false)
      if (drawerMode) setDrawerProcessing(false)
    }
  }

  // ==================== Merchant Mode Handlers ====================

  const handleCrawl = async () => {
    if (!merchantUrl.trim()) { message.warning('请输入商家网址'); return }
    if (!trackingLink.trim()) { message.warning('请输入追踪链接'); return }
    setLoading(true)
    if (drawerMode) setDrawerProcessing(true, '正在爬取 & AI 分析…')
    const mName = campaignResult?.merchant_name || ''
    try {
      const res = await articleApi.crawlMerchant({ url: merchantUrl, language, merchant_name: mName })
      await _applyCrawlImages(res.data)
    } catch (err) {
      const detail = err?.response?.data?.detail || err.message || '未知错误'
      const isTimeout = err.code === 'ECONNABORTED' || detail.includes('timeout')
      message.info(isTimeout ? '爬取超时，正在用 AI 分析...' : `爬取失败(${detail.slice(0,50)})，正在用 AI 分析...`)
      try {
        const aiRes = await articleApi.analyzeUrl({ url: merchantUrl, language, merchant_name: mName })
        const aiData = aiRes.data
        const analysis = aiData?.analysis || {}
        const crawlData = {
          brand_name: aiData?.brand_name || '',
          url: merchantUrl,
          analysis,
        }
        setCrawlResult(crawlData)
        _autoSelectTitleAndKeywords(crawlData)
        message.success('AI 分析完成，已自动选择标题和关键词')
      } catch (_aiErr) {
        message.warning('AI 分析也失败了，请在确认页面手动输入标题和关键词')
        setCrawlResult({ brand_name: '', url: merchantUrl, analysis: { titles: [], keywords: [], products: [], selling_points: [], promotions: '' } })
        setMerchantTitles([])
        setMerchantKeywords([])
      }
      setCrawledImages([])
      setMStep(1)
    } finally {
      setLoading(false)
      if (drawerMode) setDrawerProcessing(false)
    }
  }

  const handleMerchantConfirmTitle = () => {
    if (!selectedMTitle) { message.warning('请选择或输入一个标题'); return }
    setMStep(2)
  }

  const [genProgress, setGenProgress] = useState('')

  const handleMerchantGenerate = async () => {
    setLoading(true)
    setGenProgress('正在连接 AI...')
    if (drawerMode) setDrawerProcessing(true, 'AI 文章生成中…')
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
      }, (progress) => {
        setGenProgress(progress)
        if (drawerMode) setDrawerProcessing(true, progress || 'AI 生成中…')
      })
      setMerchantArticle(res.data)
      setMStep(3)
    } catch (err) {
      message.error('文章生成失败: ' + (err?.response?.data?.detail || err.message))
    } finally {
      setLoading(false)
      setGenProgress('')
      if (drawerMode) setDrawerProcessing(false)
    }
  }

  const handleMerchantPublish = async () => {
    if (!merchantArticle) return
    setSaving(true)
    if (drawerMode) setDrawerProcessing(true, '正在发布文章…')
    try {
      const payload = {
        title: selectedMTitle,
        content: merchantArticle.content,
        excerpt: merchantArticle.excerpt,
        status: (mPublishDate && mPublishDate.isAfter(dayjs())) ? 'draft' : 'published',
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
        featured_image: getImgSubmitValue(selectedImages[0]) || null,
        content_images: selectedImages.slice(1).map(img => {
          if (typeof img === 'string') return img
          return { cache_url: img.cache_url || '', url: img.url || '', source: img.source || 'crawl' }
        }),
        image_cache_session: imageCacheSession || null,
        author: merchantArticle.author || null,
      }
      const res = await articleApi.createArticle(payload)
      const articleId = res.data?.id

      if (publishToSite && selectedSiteId && articleId) {
        try {
          await articleApi.publishToSite(articleId, selectedSiteId)
          message.success('文章已发布，并同步到网站')
        } catch (siteErr) {
          message.warning('文章已保存，但发布到网站失败: ' + (siteErr?.response?.data?.detail || siteErr.message))
        }
      } else {
        const isPast = mPublishDate && mPublishDate.isBefore(dayjs())
        message.success(mPublishDate ? (isPast ? '文章已发布（回溯时间）' : '文章已保存，将定时发布') : '文章已发布')
      }
      if (drawerMode) {
        closeDrawer()
      }
      navigate('/articles')
    } catch (err) {
      message.error('发布失败: ' + (err?.response?.data?.detail || err.message))
    } finally {
      setSaving(false)
      if (drawerMode) setDrawerProcessing(false)
    }
  }

  const handleToggleMKeyword = (kw) => {
    if (selectedMKeywords.includes(kw)) setSelectedMKeywords(selectedMKeywords.filter(k => k !== kw))
    else setSelectedMKeywords([...selectedMKeywords, kw])
  }

  // === 图片选择操作（CR-040: 支持对象格式） ===
  const handleAddToSelected = (imgObj) => {
    // 去重：比较 cache_url 或 url
    const newKey = getImgSubmitValue(imgObj)
    const exists = selectedImages.some(s => getImgSubmitValue(s) === newKey)
    if (exists) { message.info('该图片已在文章用图中'); return }
    setSelectedImages(prev => [...prev, imgObj])
  }

  const handleRemoveFromSelected = (index) => {
    setSelectedImages(prev => prev.filter((_, i) => i !== index))
  }

  const handleMoveSelected = (fromIndex, toIndex) => {
    if (toIndex < 0 || toIndex >= selectedImages.length) return
    setSelectedImages(prev => {
      const arr = [...prev]
      const [item] = arr.splice(fromIndex, 1)
      arr.splice(toIndex, 0, item)
      return arr
    })
  }

  const handleLoadStockImages = async () => {
    if (stockImages.length > 0) { setImagePoolMode('stock'); return }
    const query = _buildImageSearchQuery(crawlResult)
    setSearchingImages(true)
    try {
      const res = await articleApi.searchImages({ query, count: 16 })
      // CR-040: 图库图不走缓存，转为对象格式 {url, source}
      const imgs = (res.data?.images || []).map(s =>
        typeof s === 'string' ? { url: s, source: 'stock' } : s
      )
      setStockImages(imgs)
      setImagePoolMode('stock')
      if (imgs.length === 0) message.info('图片库未搜索到匹配图片')
    } catch (err) {
      message.error('搜索图片库失败: ' + (err?.response?.data?.detail || err.message))
    } finally { setSearchingImages(false) }
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
                  <Typography.Text>发布时间：</Typography.Text>
                  <DatePicker showTime placeholder="留空=当前时间，可选过去" value={publishDate} onChange={setPublishDate} style={{ marginLeft: 8, minWidth: 220 }} />
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
                    notFoundContent="暂无可绑定网站，请先到「文章管理 → 我的网站」中绑定"
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
    { title: '图片选择', description: '选择文章配图' },
    { title: '确认 & 生成', description: 'AI 自动标题/关键词，确认后生成' },
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
                      {fetchingCampaign ? '正在查找商家，请耐心等待...' : '获取 Campaign Link'}
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

                    {!campaignResult.campaign_link && (
                      <Alert
                        type="warning"
                        message="该商家未返回 Campaign Link"
                        description="建议切换到「手动输入」模式手动粘贴追踪链接"
                        showIcon
                        style={{ marginBottom: 16 }}
                      />
                    )}

                    {/* CR-019: 在 Step 0 显示语言/区域选择器 */}
                    {campaignResult.support_regions?.length > 0 && (
                      <div style={{ marginTop: 16, marginBottom: 16, padding: '12px 16px', background: '#f0f5ff', borderRadius: 8 }}>
                        <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>🌐 选择目标区域/语言</Typography.Text>
                        <Row gutter={12} align="middle">
                          <Col span={14}>
                            <Select
                              placeholder="选择目标区域"
                              value={selectedRegion}
                              onChange={handleRegionSelect}
                              style={{ width: '100%' }}
                              showSearch
                              filterOption={(input, option) =>
                                option.label.toLowerCase().includes(input.toLowerCase()) ||
                                option.value.toLowerCase().includes(input.toLowerCase())
                              }
                              options={campaignResult.support_regions.map(r => ({
                                value: r.code,
                                label: `${r.code} — ${r.language}`,
                              }))}
                            />
                          </Col>
                          <Col span={10}>
                            {selectedRegion && language && (
                              <Tag color="blue" style={{ fontSize: 14, padding: '4px 12px' }}>
                                语言: {LANGUAGES.find(l => l.value === language)?.label || language}
                              </Tag>
                            )}
                          </Col>
                        </Row>
                      </div>
                    )}

                    <Divider />
                    <Button
                      type="primary"
                      icon={<RocketOutlined />}
                      onClick={handlePlatformCrawl}
                      size="large"
                      block
                      disabled={!merchantUrl || !trackingLink || (campaignResult.support_regions?.length > 0 && !selectedRegion)}
                    >
                      开始爬取 & AI 分析
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* 商家网址 */}
                <Typography.Title level={5}><ShopOutlined /> 商家网址</Typography.Title>
                <Input
                  placeholder="https://www.example.com"
                  value={merchantUrl}
                  onChange={e => setMerchantUrl(e.target.value)}
                  prefix={<GlobalOutlined />}
                  size="large"
                />

                {/* 追踪链接 */}
                <Typography.Title level={5} style={{ marginTop: 20 }}><LinkOutlined /> 追踪链接</Typography.Title>
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

                {/* 图片上传区域：1头图 + 4内容图 */}
                <Typography.Title level={5} style={{ marginTop: 20 }}>
                  📷 文章图片
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    拖拽或点击上传，头图 1 张（必须）+ 内容图最多 4 张
                  </Typography.Text>
                </Typography.Title>
                <Row gutter={16}>
                  <Col span={8}>
                    <div style={{ textAlign: 'center', marginBottom: 4 }}>
                      <Tag color="green">头图（必须）</Tag>
                    </div>
                    {manualHeroPreview ? (
                      <div style={{ position: 'relative', textAlign: 'center' }}>
                        <Image src={manualHeroPreview} width={160} height={160}
                          style={{ objectFit: 'cover', borderRadius: 8, border: '3px solid #52c41a' }}
                          preview={false} />
                        <Button type="text" danger size="small" icon={<DeleteOutlined />}
                          onClick={handleRemoveHeroImg}
                          style={{ position: 'absolute', top: -8, right: 20, background: '#fff', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }} />
                      </div>
                    ) : (
                      <Upload.Dragger
                        accept="image/*"
                        showUploadList={false}
                        beforeUpload={() => false}
                        onChange={handleHeroDrop}
                        style={{ padding: '20px 8px' }}
                      >
                        <p className="ant-upload-drag-icon"><InboxOutlined style={{ fontSize: 32, color: '#52c41a' }} /></p>
                        <p style={{ fontSize: 13 }}>拖入头图</p>
                      </Upload.Dragger>
                    )}
                  </Col>
                  <Col span={16}>
                    <div style={{ textAlign: 'center', marginBottom: 4 }}>
                      <Tag color="blue">内容图（最多 4 张）</Tag>
                    </div>
                    <Row gutter={8}>
                      {manualContentPreviews.map((src, i) => (
                        <Col span={6} key={`mc-${i}`}>
                          <div style={{ position: 'relative', textAlign: 'center', marginBottom: 8 }}>
                            <Image src={src} width={90} height={90}
                              style={{ objectFit: 'cover', borderRadius: 6, border: '2px solid #d9d9d9' }}
                              preview={false} />
                            <Button type="text" danger size="small" icon={<DeleteOutlined />}
                              onClick={() => handleRemoveContentImg(i)}
                              style={{ position: 'absolute', top: -6, right: -2, background: '#fff', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', width: 20, height: 20, padding: 0, minWidth: 20 }} />
                            <div><Tag style={{ fontSize: 10 }}>内容{i + 1}</Tag></div>
                          </div>
                        </Col>
                      ))}
                      {manualContentFiles.length < 4 && (
                        <Col span={6}>
                          <Upload.Dragger
                            accept="image/*"
                            showUploadList={false}
                            beforeUpload={() => false}
                            onChange={handleContentDrop}
                            style={{ padding: '12px 4px', height: 90 }}
                          >
                            <PlusOutlined style={{ fontSize: 20, color: '#1890ff' }} />
                            <p style={{ fontSize: 11, margin: '4px 0 0' }}>添加</p>
                          </Upload.Dragger>
                        </Col>
                      )}
                    </Row>
                  </Col>
                </Row>

                <Row gutter={16} style={{ marginTop: 20 }}>
                  <Col span={8}>
                    <Typography.Title level={5}><ClockCircleOutlined /> 发布时间</Typography.Title>
                    <DatePicker
                      showTime
                      placeholder="留空=立即发布，可选过去"
                      value={mPublishDate}
                      onChange={setMPublishDate}
                      style={{ width: '100%' }}
                      size="large"
                    />
                  </Col>
                  <Col span={8}>
                    <Typography.Title level={5}><GlobalOutlined /> 发布网站</Typography.Title>
                    <Select
                      placeholder="选择目标网站"
                      value={selectedSiteId}
                      onChange={setSelectedSiteId}
                      style={{ width: '100%' }}
                      size="large"
                      options={siteList.map(s => ({ value: s.id, label: `${s.site_name}${s.domain ? ` (${s.domain})` : ''}` }))}
                      notFoundContent="暂无可绑定网站，请先到「文章管理 → 我的网站」中绑定"
                    />
                  </Col>
                </Row>

                <Alert
                  type="info"
                  showIcon
                  style={{ marginTop: 16 }}
                  message="默认设置"
                  description="文章将自动使用「去AI味」处理 + 「软植入」风格 + 笔名作者。爬虫失败时追踪链接和商家链接将自动保留。"
                />

                <Divider />
                <Button type="primary" icon={<RocketOutlined />} onClick={handleManualSubmit} loading={loading} size="large" block>
                  开始 AI 分析 & 生成文章
                </Button>
              </>
            )}
          </div>
        )}

        {/* Step 1: 图片选择 + 商家信息概览 */}
        {mStep === 1 && crawlResult && (
          <div style={{ maxWidth: 700, margin: '0 auto' }}>
            {/* 商家信息概览 */}
            <Card size="small" style={{ marginBottom: 16, background: '#f6ffed' }}>
              {crawlResult.brand_name ? (
                <>
                  <Typography.Text strong>品牌：</Typography.Text>
                  <Typography.Text>{crawlResult.brand_name}</Typography.Text>
                </>
              ) : (
                <Alert type="warning" message="爬虫未获取到品牌信息，AI 已自动生成标题和关键词" showIcon style={{ marginBottom: 8 }} />
              )}
              {merchantUrl && (
                <div style={{ marginTop: 4 }}>
                  <Typography.Text strong>商家网址：</Typography.Text>
                  <Typography.Text copyable>{merchantUrl}</Typography.Text>
                </div>
              )}
              {trackingLink && (
                <div style={{ marginTop: 4 }}>
                  <Typography.Text strong>追踪链接：</Typography.Text>
                  <Typography.Text copyable style={{ color: '#52c41a', fontSize: 12 }}>{trackingLink}</Typography.Text>
                </div>
              )}
            </Card>

            {/* ===== 文章用图 ===== */}
            <div style={{ marginBottom: 20 }}>
              <Typography.Title level={5} style={{ color: '#52c41a' }}>
                文章用图
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  第一张为头图，其余为内容图。从下方待选图中点击添加，点 × 移除，点箭头调整顺序
                </Typography.Text>
              </Typography.Title>
              {selectedImages.length === 0 ? (
                <Alert type="info" message="请从下方待选图中点击选择图片" showIcon />
              ) : (
                <Space wrap size={[10, 10]}>
                  {selectedImages.map((src, i) => (
                    <div key={`sel-${i}`} style={{
                      position: 'relative', display: 'inline-block',
                      border: i === 0 ? '3px solid #52c41a' : '2px solid #d9d9d9',
                      borderRadius: 8, padding: 2, background: '#fff',
                    }}>
                      <Tag color={i === 0 ? 'green' : 'default'} style={{ position: 'absolute', bottom: 4, left: 4, zIndex: 2, margin: 0, fontSize: 11 }}>
                        {i === 0 ? '头图' : `内容${i}`}
                      </Tag>
                      <Image src={getImgDisplayUrl(src)} width={110} height={110} style={{ objectFit: 'cover', borderRadius: 6 }}
                        fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
                      />
                      <Button type="text" danger size="small" icon={<DeleteOutlined />}
                        onClick={() => handleRemoveFromSelected(i)}
                        style={{ position: 'absolute', top: -6, right: -6, background: '#fff', borderRadius: '50%', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', width: 22, height: 22, padding: 0, minWidth: 22 }}
                      />
                      <div style={{ position: 'absolute', top: '50%', left: -14, transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {i > 0 && (
                          <Button type="text" size="small" onClick={() => handleMoveSelected(i, i - 1)}
                            style={{ fontSize: 10, padding: 0, width: 18, height: 18, minWidth: 18, lineHeight: '18px', background: '#fff', borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }}>
                            ←
                          </Button>
                        )}
                      </div>
                      <div style={{ position: 'absolute', top: '50%', right: -14, transform: 'translateY(-50%)' }}>
                        {i < selectedImages.length - 1 && (
                          <Button type="text" size="small" onClick={() => handleMoveSelected(i, i + 1)}
                            style={{ fontSize: 10, padding: 0, width: 18, height: 18, minWidth: 18, lineHeight: '18px', background: '#fff', borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' }}>
                            →
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </Space>
              )}
            </div>

            {/* ===== 待选用图 ===== */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 12 }}>
                <Typography.Title level={5} style={{ margin: 0, color: '#ff4d4f' }}>待选用图</Typography.Title>
                {crawledImages.length > 0 && (
                  <Segmented
                    size="small"
                    value={imagePoolMode}
                    onChange={(v) => {
                      if (v === 'stock') handleLoadStockImages()
                      else setImagePoolMode('crawl')
                    }}
                    options={[
                      { label: '商家网站', value: 'crawl' },
                      { label: '图片库', value: 'stock' },
                    ]}
                  />
                )}
                {crawledImages.length === 0 && stockImages.length > 0 && (
                  <Tag color="purple">图片库（商家网站无法爬取，已自动搜索相关图片）</Tag>
                )}
                {(crawledImages.length > 0 || stockImages.length > 0) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    点击图片添加到文章用图
                  </Typography.Text>
                )}
              </div>

              {crawledImages.length === 0 && !searchingImages && stockImages.length === 0 && (
                <Alert type="warning" message="未从商家网站获取到图片，请通过下方上传按钮手动上传" showIcon style={{ marginBottom: 12 }} />
              )}

              {/* 爬虫成功：正常图片选择 */}
              {imagePoolMode === 'stock' && searchingImages && <Spin tip="搜索图片库中..." />}
              {imagePoolMode === 'stock' && !searchingImages && stockImages.length === 0 && (
                <Alert type="info" message="图片库暂无匹配结果" showIcon />
              )}
              <Space wrap size={[8, 8]} style={{ marginTop: 8 }}>
                {(imagePoolMode === 'crawl' ? crawledImages : stockImages).map((imgObj, i) => {
                  const imgKey = getImgSubmitValue(imgObj)
                  const isSelected = selectedImages.some(s => getImgSubmitValue(s) === imgKey)
                  return (
                    <div key={`pool-${i}`} style={{
                      position: 'relative', display: 'inline-block', cursor: isSelected ? 'default' : 'pointer',
                      border: '2px solid transparent', borderRadius: 6, padding: 1,
                      opacity: isSelected ? 0.4 : 1, transition: 'opacity 0.2s',
                    }} onClick={() => !isSelected && handleAddToSelected(imgObj)}>
                      <Image src={getImgDisplayUrl(imgObj)} width={90} height={90} style={{ objectFit: 'cover', borderRadius: 4 }}
                        preview={false}
                        fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
                      />
                      {isSelected && (
                        <Tag color="green" style={{ position: 'absolute', top: 4, left: 4, zIndex: 2, margin: 0, fontSize: 10 }}>已选</Tag>
                      )}
                      {!isSelected && (
                        <div style={{ position: 'absolute', top: 4, right: 4, zIndex: 2, background: 'rgba(0,0,0,0.5)', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <PlusOutlined style={{ color: '#fff', fontSize: 12 }} />
                        </div>
                      )}
                      <div
                        style={{ position: 'absolute', bottom: 4, right: 4, zIndex: 2, background: 'rgba(0,0,0,0.5)', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); setPoolPreviewSrc(getImgDisplayUrl(imgObj)); setPoolPreviewOpen(true) }}
                      >
                        <EyeOutlined style={{ color: '#fff', fontSize: 12 }} />
                      </div>
                    </div>
                  )
                })}
                {/* 手动上传按钮 — 始终显示 */}
                <Upload
                  accept="image/*"
                  showUploadList={false}
                  multiple
                  beforeUpload={() => false}
                  onChange={async (info) => {
                    const file = info.file?.originFileObj || info.file
                    if (!file) return
                    const imgObj = await uploadToImageCache(file)
                    if (imgObj) {
                      setCrawledImages(prev => [...prev, imgObj])
                      setImagePoolMode('crawl')
                    }
                  }}
                >
                  <div style={{
                    width: 90, height: 90, border: '2px dashed #d9d9d9', borderRadius: 6,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', background: '#fafafa', transition: 'border-color 0.3s',
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#1890ff' }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#d9d9d9' }}
                  >
                    <UploadOutlined style={{ fontSize: 22, color: '#999' }} />
                    <span style={{ fontSize: 11, color: '#999', marginTop: 4 }}>上传图片</span>
                  </div>
                </Upload>
              </Space>
              <Image
                style={{ display: 'none' }}
                preview={{
                  visible: poolPreviewOpen,
                  src: poolPreviewSrc,
                  onVisibleChange: (vis) => setPoolPreviewOpen(vis),
                }}
              />
            </div>

            {/* ===== 文章语言设置（仅手动输入模式或无 support_regions 时显示） ===== */}
            {!(campaignResult?.support_regions?.length > 0) && (
            <div style={{ marginBottom: 20 }}>
              <Typography.Title level={5}>🌐 文章语言</Typography.Title>
              <Row gutter={16} align="middle">
                <Col span={8}>
                  <Tooltip title="输入国家代码，自动映射语言。如 de=德语, fr=法语, us=英语">
                    <Input
                      placeholder="国家代码 如 de, us"
                      value={countryCode}
                      onChange={e => handleCountryCodeChange(e.target.value)}
                      maxLength={3}
                      style={{ textTransform: 'lowercase' }}
                    />
                  </Tooltip>
                </Col>
                <Col span={8}>
                  {!countryCode && (
                    <Select value={language} onChange={setLanguage} options={LANGUAGES} style={{ width: '100%' }} placeholder="选择语言" />
                  )}
                  {countryCode && COUNTRY_LANG_MAP[countryCode.toLowerCase()] && (
                    <Tag color="blue">语言: {COUNTRY_LANG_MAP[countryCode.toLowerCase()]}</Tag>
                  )}
                </Col>
              </Row>
            </div>
            )}

            <Divider />
            <Space>
              <Button onClick={() => setMStep(0)}>上一步</Button>
              <Button type="primary" onClick={() => {
                if (selectedImages.length === 0) {
                  message.warning('请至少选择 1 张图片作为头图')
                  return
                }
                setMStep(2)
              }}>下一步</Button>
              {selectedImages.length === 0 && (
                <Typography.Text type="danger">请至少选择 1 张图片</Typography.Text>
              )}
              {selectedImages.length > 0 && (
                <Typography.Text type="success">已选 {selectedImages.length} 张图片</Typography.Text>
              )}
            </Space>
          </div>
        )}

        {/* Step 2: 确认信息 & 生成文章（标题/关键词可修改） */}
        {mStep === 2 && (
          <div style={{ maxWidth: 650, margin: '0 auto', padding: '20px 0' }}>
            <Typography.Title level={5}>确认信息</Typography.Title>
            <Alert
              type="success"
              showIcon
              message="AI 已自动选择标题和关键词，如需修改可直接编辑"
              style={{ marginBottom: 16 }}
            />
            <Card size="small" style={{ textAlign: 'left', marginBottom: 16 }}>
              <div style={{ marginBottom: 12 }}>
                <Typography.Text strong>标题：</Typography.Text>
                <Input
                  value={selectedMTitle}
                  onChange={e => setSelectedMTitle(e.target.value)}
                  size="large"
                  style={{ marginTop: 4 }}
                  placeholder="文章标题（AI 已自动选择，可修改）"
                />
                {merchantTitles.length > 1 && (
                  <div style={{ marginTop: 6 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>其他候选标题：</Typography.Text>
                    <div style={{ marginTop: 4 }}>
                      {merchantTitles.slice(0, 5).map((item, i) => {
                        let t
                        if (typeof item === 'string') t = item
                        else if (language === 'en') t = item.title_en || item.title
                        else t = (item.title && item.title !== item.title_en) ? item.title : (item.title_en || item.title)
                        if (t === selectedMTitle) return null
                        return (
                          <Tag key={i} color="default" style={{ cursor: 'pointer', marginBottom: 4 }}
                            onClick={() => setSelectedMTitle(t)}>
                            {t}
                          </Tag>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ marginBottom: 12 }}>
                <Typography.Text strong>关键词：</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {selectedMKeywords.length > 0 ? (
                    <Space wrap size={4}>
                      {selectedMKeywords.map((kw, i) => (
                        <Tag key={i} color="green" closable onClose={() => setSelectedMKeywords(prev => prev.filter(k => k !== kw))}>
                          {kw}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <Typography.Text type="secondary">（无关键词）</Typography.Text>
                  )}
                  <Input
                    placeholder="添加关键词（逗号分隔，回车确认）"
                    size="small"
                    style={{ marginTop: 6, width: '100%' }}
                    onPressEnter={e => {
                      const kws = e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
                      setSelectedMKeywords(prev => [...new Set([...prev, ...kws])])
                      e.target.value = ''
                    }}
                  />
                </div>
              </div>
              <p><strong>品牌：</strong>{crawlResult?.brand_name || '（爬虫未获取）'}</p>
              <p><strong>商家网址：</strong>{merchantUrl}</p>
              <p><strong>追踪链接：</strong>{trackingLink}</p>
              <p><strong>语言：</strong>{language}{countryCode ? ` (${countryCode.toUpperCase()})` : ''}</p>
              <p><strong>图片：</strong>头图 {selectedImages.length > 0 ? '✓' : '✗'} + 内容图 {Math.max(0, selectedImages.length - 1)} 张</p>
            </Card>
            <Space>
              <Button onClick={() => setMStep(1)}>上一步（修改图片）</Button>
              <Button type="primary" icon={<RocketOutlined />} onClick={handleMerchantGenerate} loading={loading} size="large"
                disabled={!selectedMTitle || selectedImages.length === 0}>
                {loading ? (genProgress || 'AI 正在撰写...') : '生成推广文章'}
              </Button>
              {selectedImages.length === 0 && (
                <Typography.Text type="danger" style={{ marginLeft: 8 }}>请先选择至少 1 张图片</Typography.Text>
              )}
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

            {selectedImages.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Typography.Title level={5} style={{ color: '#52c41a' }}>
                  文章配图预览
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    返回上一步可修改
                  </Typography.Text>
                </Typography.Title>
                <Space wrap size={[10, 10]}>
                  {selectedImages.map((src, i) => (
                    <div key={`preview-${i}`} style={{
                      position: 'relative', display: 'inline-block',
                      border: i === 0 ? '3px solid #52c41a' : '2px solid #d9d9d9',
                      borderRadius: 8, padding: 2,
                    }}>
                      <Tag color={i === 0 ? 'green' : 'default'} style={{ position: 'absolute', bottom: 4, left: 4, zIndex: 2, margin: 0, fontSize: 11 }}>
                        {i === 0 ? '头图' : `内容${i}`}
                      </Tag>
                      <Image src={getImgDisplayUrl(src)} width={120} height={120} style={{ objectFit: 'cover', borderRadius: 6 }}
                        preview={false}
                        fallback="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=="
                      />
                    </div>
                  ))}
                </Space>
              </div>
            )}
            <Divider />
            {merchantArticle.author && (
              <div style={{ marginBottom: 12 }}>
                <Typography.Text>作者：</Typography.Text>
                <Tag color="blue" style={{ marginLeft: 8 }}>{merchantArticle.author}</Tag>
              </div>
            )}
            <Space size="large" wrap>
              <div>
                <Typography.Text>发布时间：</Typography.Text>
                <DatePicker showTime placeholder="留空=立即发布，可选过去" value={mPublishDate} onChange={setMPublishDate} style={{ marginLeft: 8, minWidth: 220 }} />
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
                  notFoundContent="暂无可绑定网站，请先到「文章管理 → 我的网站」中绑定"
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
