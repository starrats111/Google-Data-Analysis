import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Steps, Card, Button, Space, Table, Input, InputNumber, Select, message, Spin, Typography, Tag, Alert, Row, Col, Divider, Collapse, Modal, Switch, Tooltip, Checkbox } from 'antd'
import { ThunderboltOutlined, SearchOutlined, RocketOutlined, LinkOutlined, BulbOutlined, LoadingOutlined, CheckCircleOutlined, GlobalOutlined, CopyOutlined, ReloadOutlined, PictureOutlined, WarningOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../services/api'
import { getToken } from '../../services/tokenHolder'

const { TextArea } = Input

const RESTRICTED_KEYWORDS = {
  alcohol: { label: '酒类限制品', keywords: ['whiskey', 'whisky', 'vodka', 'rum', 'gin', 'tequila', 'brandy', 'cognac', 'bourbon', 'wine', 'winery', 'vineyard', 'beer', 'brewery', 'brewing', 'distillery', 'spirits', 'liquor', 'champagne', 'sake', 'cider', 'mead', 'absinthe', 'moonshine', 'cocktail', 'scotch', 'ale', 'lager', 'stout', 'prosecco', 'mezcal', 'soju', 'baijiu', 'grappa', 'vermouth', 'schnapps', 'armagnac', 'pilsner', 'craft beer', 'hard seltzer', 'liqueur', 'bitters', 'amaro'], tip: '酒类广告限制：仅限批准国家投放，不可面向未成年人，着陆页需标注ABV，不可推广过量饮酒。' },
  gambling: { label: '赌博限制品', keywords: ['casino', 'poker', 'betting', 'gamble', 'gambling', 'lottery', 'sportsbook', 'jackpot', 'roulette', 'blackjack', 'baccarat', 'slot machine', 'bingo', 'wager', 'bookmaker', 'fantasy sport', 'fanduel', 'draftkings', 'betway', 'bet365'], tip: '赌博广告需 Google 认证和当地牌照，建议不做。' },
  weapon: { label: '武器禁止品', keywords: ['firearm', 'ammunition', 'gun ', 'guns ', 'rifle', 'pistol', 'shotgun', 'handgun', 'revolver', 'ar-15', 'ar15', 'ak-47', 'ak47', 'holster', 'gun safe', 'gun shop', 'ammo', 'bullet', 'silencer', 'suppressor', 'body armor', 'stun gun', 'taser', 'crossbow', 'combat knife', 'machete'], tip: '武器/弹药广告严格禁止，Google Ads 不允许推广。' },
  tobacco: { label: '烟草禁止品', keywords: ['tobacco', 'cigarette', 'cigar', 'vape', 'vaping', 'e-cigarette', 'e-cig', 'juul', 'iqos', 'hookah', 'shisha', 'nicotine', 'smokeless tobacco', 'chewing tobacco', 'snuff', 'snus', 'disposable vape', 'vape juice', 'e-liquid', 'e-juice', 'nicotine pouch', 'zyn'], tip: '烟草/电子烟广告完全禁止。' },
  adult: { label: '成人限制品', keywords: ['adult toy', 'sex toy', 'vibrator', 'dildo', 'lingerie', 'erotic', 'adult shop', 'bondage', 'fetish', 'escort', 'xxx', 'porn', 'adult novelty', 'sensual', 'intimate apparel'], tip: '成人内容严格限制，露骨色情完全禁止。' },
  cbd: { label: 'CBD/大麻', keywords: ['cbd ', ' cbd', 'cannabidiol', 'cannabis', 'marijuana', 'hemp oil', 'hemp extract', 'thc ', ' thc', 'delta-8', 'delta 8', 'dispensary', 'weed', 'cbd oil', 'cbd gummies', 'hemp flower', 'cannabis oil', 'sativa', 'indica'], tip: 'CBD/大麻广告严格限制，大多数国家完全禁止。美国部分州允许FDA批准的CBD产品，需Google认证。' },
  finance: { label: '金融限制品', keywords: ['payday loan', 'cash advance', 'title loan', 'pawn shop', 'crypto exchange', 'bitcoin trading', 'forex trading', 'binary option', 'ico ', 'nft marketplace', 'defi ', 'margin trading', 'penny stock', 'credit repair', 'debt settlement'], tip: '金融服务需遵守当地法规，加密货币需Google认证，高利贷禁止。' },
  weightloss: { label: '减肥限制品', keywords: ['weight loss pill', 'diet pill', 'fat burner', 'appetite suppressant', 'slimming', 'detox tea', 'skinny tea', 'garcinia', 'keto pill', 'metabolism booster', 'carb blocker', 'thermogenic', 'ephedra', 'belly fat', 'lose weight fast'], tip: '减肥产品禁止不切实际的承诺，禁止前后对比图，不得声称有医疗效果。' },
  dating: { label: '约会限制品', keywords: ['dating site', 'dating app', 'matchmaking', 'hookup', 'mail order bride', 'sugar daddy', 'sugar baby', 'affair', 'ashley madison'], tip: '约会服务有限制，禁止推广婚外情/付费陪伴服务。' },
  pharma: { label: '医药限制品', keywords: ['pharmacy', 'pharmaceutical', 'prescription', 'drug store', 'rx ', 'compounding pharmacy', 'online pharmacy', 'controlled substance'], tip: '处方药/药房广告需要Google药品认证。' },
  political: { label: '政治限制品', keywords: ['political campaign', 'vote for', 'election', 'political action', 'super pac', 'campaign fund', 'ballot', 'referendum'], tip: '政治广告需要Google认证和身份验证。' },
}

function detectMerchantRestrictions(name) {
  const n = (name || '').toLowerCase()
  const results = []
  for (const [, rule] of Object.entries(RESTRICTED_KEYWORDS)) {
    if (rule.keywords.some(kw => n.includes(kw))) results.push(rule)
  }
  return results
}

function formatCid(cid) {
  const s = String(cid).replace(/\D/g, '')
  if (s.length === 10) return `${s.slice(0,3)}-${s.slice(3,6)}-${s.slice(6)}`
  return cid
}

const COUNTRY_LABELS = {
  US: '美国', UK: '英国', CA: '加拿大', AU: '澳大利亚',
  DE: '德国', FR: '法国', JP: '日本', BR: '巴西',
}

const COUNTRY_LANGUAGE = {
  US: 'English', UK: 'English', CA: 'English', AU: 'English',
  DE: 'Deutsch', FR: 'Français', JP: '日本語', BR: 'Português',
}

const COUNTRY_LANGUAGE_ZH = {
  US: '英语', UK: '英语', CA: '英语', AU: '英语',
  DE: '德语', FR: '法语', JP: '日语', BR: '葡萄牙语',
}

export default function AdCreationWizard() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const assignmentId = searchParams.get('assignment_id')
  const merchantName = searchParams.get('merchant_name') || ''
  const merchantUrl = searchParams.get('merchant_url') || ''
  const holidayName = searchParams.get('holiday_name') || ''

  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)

  // Assignment details (from claim)
  const [targetCountry, setTargetCountry] = useState('US')
  const [assignmentMode, setAssignmentMode] = useState('test')

  // Step 0: MCC 选择 + 广告系列设置
  const [mccList, setMccList] = useState([])
  const [selectedMcc, setSelectedMcc] = useState(null)
  const [availableCid, setAvailableCid] = useState('')
  const [allCids, setAllCids] = useState([])
  const [busyCids, setBusyCids] = useState([])
  const [cidError, setCidError] = useState('')
  const [cidTotal, setCidTotal] = useState(0)
  const [refreshingCid, setRefreshingCid] = useState(false)

  // 广告系列设置（Google Ads 核心参数）
  const [biddingStrategy, setBiddingStrategy] = useState('MAXIMIZE_CLICKS')  // 出价策略
  const [maxCpcLimit, setMaxCpcLimit] = useState(null)  // 最高 CPC 出价上限
  const [networkSearch, setNetworkSearch] = useState(true)  // 搜索网络
  const [networkPartners, setNetworkPartners] = useState(false)  // 搜索合作伙伴
  const [networkDisplay, setNetworkDisplay] = useState(false)  // 展示网络
  const [adSchedule, setAdSchedule] = useState('all')  // 投放时段: all / custom
  const [adScheduleDays, setAdScheduleDays] = useState([0,1,2,3,4,5,6])  // 0=Mon...6=Sun
  const [adScheduleHours, setAdScheduleHours] = useState([0, 24])  // 起止小时
  const [deviceTargeting, setDeviceTargeting] = useState('all')  // 设备: all / mobile / desktop
  const [campaignStartDate, setCampaignStartDate] = useState('')  // 开始日期
  const [campaignEndDate, setCampaignEndDate] = useState('')  // 结束日期

  // Step 1: 关键词研究
  const [keywordUrl, setKeywordUrl] = useState(merchantUrl)
  const [semrushUrl, setSemrushUrl] = useState('')
  const [seedKeywords, setSeedKeywords] = useState('')
  const [keywordResults, setKeywordResults] = useState([])
  const [selectedKeywords, setSelectedKeywords] = useState([])
  const autoResearchDone = useRef(false)
  const [keywordMatchType, setKeywordMatchType] = useState('BROAD')  // BROAD / PHRASE / EXACT
  const [negativeKeywords, setNegativeKeywords] = useState('')  // 否定关键词（逗号分隔）
  const [adGroupName, setAdGroupName] = useState(merchantName || '')  // 广告组名称=商家名
  // 最终到达网址：限制品类→政策合规页，正常→商家首页
  const [finalUrl, setFinalUrl] = useState(() => {
    const url = merchantUrl || ''
    return url
  })
  const [displayPath1, setDisplayPath1] = useState('')  // 显示路径1
  const [displayPath2, setDisplayPath2] = useState('')  // 显示路径2

  // 限制品检测（必须在 useEffect 之前声明）
  const merchantRestrictions = useMemo(() => detectMerchantRestrictions(merchantName), [merchantName])
  const isRestricted = merchantRestrictions.length > 0
  const isAlcohol = merchantRestrictions.some(r => r.label === '酒类限制品')
  const isGambling = merchantRestrictions.some(r => r.label === '赌博限制品')

  // 根据限制品类自动设置最终到达网址和显示路径
  useEffect(() => {
    if (!merchantUrl) return
    const base = merchantUrl.replace(/\/$/, '')
    if (isAlcohol) {
      setFinalUrl(base + '/age-verification')
      setDisplayPath1('age-gate')
    } else if (isGambling) {
      setFinalUrl(base + '/responsible-gambling')
      setDisplayPath1('responsible')
    } else {
      setFinalUrl(base)
    }
  }, [merchantUrl, isAlcohol, isGambling])

  // Step 2: AI 素材 (SSE streaming)
  const [streamingText, setStreamingText] = useState('')
  const [streamPhase, setStreamPhase] = useState('')
  const [streamDone, setStreamDone] = useState(false)
  const [editHeadlines, setEditHeadlines] = useState([])
  const [editDescriptions, setEditDescriptions] = useState([])
  const [headlineTranslations, setHeadlineTranslations] = useState([])
  const [descTranslations, setDescTranslations] = useState([])
  const [recommendedBudget, setRecommendedBudget] = useState(null)
  const streamingRef = useRef(false)
  const thinkingBoxRef = useRef(null)

  // AI 沟通框
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatBoxRef = useRef(null)

  // 确认弹窗
  const [confirmModalOpen, setConfirmModalOpen] = useState(false)
  const [dailyBudget, setDailyBudget] = useState(10)
  const adDefaultBudgetRef = useRef(null)
  const [createResult, setCreateResult] = useState(null)

  // AI 关键词分析
  const [aiRecommendedKws, setAiRecommendedKws] = useState([])  // AI 推荐关键词
  const [aiNegativeKws, setAiNegativeKws] = useState([])  // AI 否定关键词
  const [aiStrategySummary, setAiStrategySummary] = useState('')
  const [aiAnalyzing, setAiAnalyzing] = useState(false)

  // 限制品合规设置
  const [complianceSettings, setComplianceSettings] = useState({
    excludeMinors: true,        // 排除未成年人群
    ageTargeting: '21_65',      // 年龄定向: 21-65
    addResponsibleMsg: true,    // 添加负责任声明
    responsibleMsg: 'Drink Responsibly. Must be 21+.',
    confirmCompliance: false,   // 确认已阅读政策
  })

  // 广告素材开关
  const [sitelinks, setSitelinks] = useState([])
  const [callouts, setCallouts] = useState([])
  const [enableSitelinks, setEnableSitelinks] = useState(true)
  const [enableCallouts, setEnableCallouts] = useState(true)
  const [enableImages, setEnableImages] = useState(false)
  const [enableLogo, setEnableLogo] = useState(false)
  const [merchantImages, setMerchantImages] = useState([])
  const [merchantLogo, setMerchantLogo] = useState('')

  // 加载 MCC 列表 + 广告默认设置
  useEffect(() => {
    api.get('/api/ad-creation/mcc-accounts').then(res => {
      setMccList(res.data || [])
    }).catch(() => {})
    api.get('/api/merchants/ad-defaults').then(res => {
      if (res.data) {
        const d = res.data
        if (d.default_daily_budget) {
          setDailyBudget(d.default_daily_budget)
          adDefaultBudgetRef.current = d.default_daily_budget
        }
        if (d.bidding_strategy) setBiddingStrategy(d.bidding_strategy)
        if (d.default_cpc_bid) setMaxCpcLimit(d.default_cpc_bid)
        if (d.target_google_search !== undefined) setNetworkSearch(d.target_google_search)
        if (d.target_search_network !== undefined) setNetworkPartners(d.target_search_network)
        if (d.target_content_network !== undefined) setNetworkDisplay(d.target_content_network)
      }
    }).catch(() => {})
  }, [])

  // 加载 assignment 详情（国家、模式等）
  useEffect(() => {
    if (!assignmentId) return
    api.get(`/api/ad-creation/assignment-detail/${assignmentId}`).then(res => {
      const d = res.data || {}
      if (d.target_country) setTargetCountry(d.target_country)
      if (d.mode) setAssignmentMode(d.mode)
      if (d.site_url) setKeywordUrl(d.site_url)
    }).catch(() => {})
  }, [assignmentId])

  // 选择 MCC 后加载 CID 列表
  const handleSelectMcc = async (mccId) => {
    setSelectedMcc(mccId)
    setAvailableCid('')
    setAllCids([])
    setBusyCids([])
    setCidError('')
    setCidTotal(0)
    setLoading(true)
    try {
      const res = await api.post('/api/ad-creation/find-available-cid', { mcc_id: mccId })
      const data = res.data || {}
      const freeCids = data.all_cids || []
      const busyList = data.busy_cids || []
      const total = data.total || (freeCids.length + busyList.length)
      const recommended = data.customer_id || freeCids[0] || ''
      setAllCids(freeCids)
      setBusyCids(busyList)
      setCidTotal(total)
      setAvailableCid(recommended)
      if (mccList.length === 1 && freeCids.length <= 1 && recommended) setStep(1)
    } catch (err) {
      setCidError(err?.response?.data?.detail || err?.message || '查找 CID 失败')
    } finally { setLoading(false) }
  }

  // 手动刷新 CID 列表（调一次 Google Ads API）
  const handleRefreshCids = async () => {
    if (!selectedMcc) return
    setRefreshingCid(true)
    try {
      await api.post('/api/ad-creation/refresh-cid-list', { mcc_id: selectedMcc })
      message.success('CID 列表已刷新')
      await handleSelectMcc(selectedMcc)
    } catch (err) {
      message.error(err?.response?.data?.detail || '刷新失败')
    } finally { setRefreshingCid(false) }
  }

  useEffect(() => {
    if (mccList.length === 1 && mccList[0].id) {
      handleSelectMcc(mccList[0].id)
    }
  }, [mccList])

  // Step 1: 进入时自动获取商家 URL 并触发关键词研究
  useEffect(() => {
    if (step !== 1 || !assignmentId || autoResearchDone.current) return
    const fetchAndResearch = async () => {
      setLoading(true)
      try {
        const detailRes = await api.get(`/api/ad-creation/assignment-detail/${assignmentId}`)
        const siteUrl = detailRes.data?.site_url || ''
        if (siteUrl) {
          setKeywordUrl(siteUrl)
          const res = await api.post('/api/ad-creation/keyword-ideas', {
            mcc_id: selectedMcc,
            customer_id: availableCid,
            url: siteUrl,
          })
          setKeywordResults(res.data.keywords || [])
          const top10 = (res.data.keywords || []).slice(0, 10).map(k => k.keyword)
          setSelectedKeywords(top10)
          autoResearchDone.current = true
        }
      } catch (err) {
        message.error(err?.response?.data?.detail || '自动获取商家信息失败')
      } finally { setLoading(false) }
    }
    fetchAndResearch()
  }, [step, assignmentId])

  const handleKeywordResearch = async () => {
    if (!keywordUrl && !seedKeywords && !semrushUrl) { message.warning('请输入网址、关键词或 SemRush 链接'); return }
    setLoading(true)
    try {
      const res = await api.post('/api/ad-creation/keyword-ideas', {
        mcc_id: selectedMcc,
        customer_id: availableCid,
        url: keywordUrl || undefined,
        keywords: seedKeywords ? seedKeywords.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        semrush_url: semrushUrl || undefined,
      })
      const kws = res.data.keywords || []
      setKeywordResults(kws)
      const top10 = kws.slice(0, 10).map(k => k.keyword)
      setSelectedKeywords(top10)

      // 自动触发 AI 关键词分析
      if (kws.length > 0) {
        setAiAnalyzing(true)
        api.post('/api/ad-creation/ai-keyword-analysis', {
          keywords: kws,
          merchant_name: merchantName,
          merchant_url: keywordUrl || merchantUrl,
          daily_budget: dailyBudget,
          target_cpc: maxCpcLimit || 0.3,
          target_country: targetCountry,
        }).then(aiRes => {
          if (aiRes.data?.recommended_keywords?.length) {
            setAiRecommendedKws(aiRes.data.recommended_keywords)
            // 自动选中 AI 推荐的关键词
            const aiKwNames = aiRes.data.recommended_keywords.map(k => k.keyword)
            setSelectedKeywords(prev => [...new Set([...prev, ...aiKwNames])])
          }
          if (aiRes.data?.negative_keywords?.length) {
            setAiNegativeKws(aiRes.data.negative_keywords)
            // 自动填入否定关键词
            const negKws = aiRes.data.negative_keywords.map(k => k.keyword).join(', ')
            setNegativeKeywords(prev => prev ? prev + ', ' + negKws : negKws)
          }
          if (aiRes.data?.strategy_summary) setAiStrategySummary(aiRes.data.strategy_summary)
        }).catch(() => {}).finally(() => setAiAnalyzing(false))
      }
    } catch (err) {
      message.error(err?.response?.data?.detail || '关键词研究失败')
    } finally { setLoading(false) }
  }

  // Step 2: SSE 流式生成
  const handleGenerateAdCopyStream = useCallback(async () => {
    if (streamingRef.current) return
    streamingRef.current = true
    setStreamingText('')
    setStreamPhase('analyzing')
    setStreamDone(false)
    setEditHeadlines([])
    setEditDescriptions([])
    setHeadlineTranslations([])
    setDescTranslations([])
    setRecommendedBudget(null)

    const kwData = keywordResults.filter(k => selectedKeywords.includes(k.keyword))
    const token = getToken()
    const baseUrl = api.defaults.baseURL || ''

    try {
      const resp = await fetch(`${baseUrl}/api/ad-creation/generate-ad-copy-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          merchant_name: merchantName,
          merchant_url: keywordUrl || merchantUrl,
          keywords: kwData,
          target_country: targetCountry,
          mcc_id: selectedMcc,
          ...(holidayName ? { holiday_name: holidayName } : {}),
        }),
      })

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6))
            if (evt.phase === 'done' && evt.result) {
              const r = evt.result
              setEditHeadlines(r.headlines || [])
              setEditDescriptions(r.descriptions || [])
              setHeadlineTranslations(r.headline_translations || [])
              setDescTranslations(r.description_translations || [])
              if (r.recommended_budget) {
                setRecommendedBudget(r.recommended_budget)
              }
              // sitelinks: 优先使用爬虫获取的真实链接，用 AI 描述补充
              setSitelinks(prev => {
                if (prev.length > 0 && prev[0].url) {
                  // 已有真实爬取的 sitelinks，用 AI 的描述补充
                  const aiSitelinks = r.sitelinks || []
                  return prev.map((sl, i) => ({
                    ...sl,
                    desc1: sl.desc1 || (aiSitelinks[i]?.desc1 || ''),
                    desc2: sl.desc2 || (aiSitelinks[i]?.desc2 || ''),
                  }))
                }
                // 没有真实数据，使用 AI 生成的
                return r.sitelinks || prev
              })
              // callouts: 优先使用爬虫获取的真实卖点
              setCallouts(prev => {
                if (prev.length > 0) return prev
                return r.callouts || prev
              })
              setStreamPhase('done')
              setStreamDone(true)
            } else if (evt.phase === 'error') {
              setStreamingText(prev => prev + '\n[错误] ' + (evt.text || '生成失败'))
              setStreamPhase('error')
              setStreamDone(true)
            } else if (evt.text) {
              setStreamPhase(evt.phase || 'thinking')
              setStreamingText(prev => prev + evt.text)
            }
          } catch {}
        }
      }
    } catch (err) {
      message.error('AI 生成连接失败: ' + (err.message || ''))
      setStreamPhase('error')
      setStreamDone(true)
    } finally {
      streamingRef.current = false
    }
  }, [keywordResults, selectedKeywords, merchantName, keywordUrl, merchantUrl, targetCountry, selectedMcc])

  // Auto-scroll thinking box
  useEffect(() => {
    if (thinkingBoxRef.current) {
      thinkingBoxRef.current.scrollTop = thinkingBoxRef.current.scrollHeight
    }
  }, [streamingText])

  const handleCreateAd = async () => {
    setLoading(true)
    try {
      const payload = {
        assignment_id: parseInt(assignmentId),
        mcc_id: selectedMcc,
        customer_id: availableCid,
        merchant_name: merchantName,
        merchant_url: finalUrl || keywordUrl || merchantUrl,
        keywords: selectedKeywords,
        headlines: editHeadlines,
        descriptions: editDescriptions,
        daily_budget: dailyBudget,
        target_country: targetCountry,
        mode: assignmentMode,
        // 新增广告系列设置
        bidding_strategy: biddingStrategy,
        max_cpc_limit: maxCpcLimit,
        network_search: networkSearch,
        network_partners: networkPartners,
        network_display: networkDisplay,
        ad_schedule: adSchedule,
        device_targeting: deviceTargeting,
        // 广告组设置
        ad_group_name: adGroupName || merchantName || '默认广告组',
        keyword_match_type: keywordMatchType,
        negative_keywords: negativeKeywords ? negativeKeywords.split(',').map(k => k.trim()).filter(Boolean) : [],
        display_path1: displayPath1,
        display_path2: displayPath2,
      }
      if (enableSitelinks && sitelinks.length > 0) payload.sitelinks = sitelinks
      if (enableCallouts && callouts.length > 0) payload.callouts = callouts
      if (enableImages && merchantImages.length > 0) payload.image_urls = merchantImages.slice(0, 3)
      if (enableLogo && merchantLogo) payload.logo_url = merchantLogo
      // 限制品合规设置
      if (isRestricted) {
        payload.compliance = {
          restricted_categories: merchantRestrictions.map(r => r.label),
          exclude_minors: complianceSettings.excludeMinors,
          age_targeting: complianceSettings.ageTargeting,
          add_responsible_msg: complianceSettings.addResponsibleMsg,
          responsible_msg: complianceSettings.responsibleMsg,
        }
      }
      const res = await api.post('/api/ad-creation/create-campaign', payload)
      setCreateResult(res.data)
      setConfirmModalOpen(false)
      message.success('广告创建成功！')
      // 从空闲列表移除刚使用的 CID
      if (availableCid) {
        setAllCids(prev => prev.filter(c => c !== availableCid))
        setAvailableCid('')
      }
    } catch (err) {
      message.error(err?.response?.data?.detail || '广告创建失败')
    } finally { setLoading(false) }
  }

  // AI 沟通框：发送修改指令
  const handleChatSend = async () => {
    if (!chatInput.trim() || chatLoading) return
    const userMsg = chatInput.trim()
    setChatInput('')
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }])
    setChatLoading(true)
    try {
      const res = await api.post('/api/ad-creation/modify-ad-copy', {
        headlines: editHeadlines,
        descriptions: editDescriptions,
        instruction: userMsg,
        merchant_name: merchantName,
        target_country: targetCountry,
      })
      const d = res.data
      if (d.headlines) setEditHeadlines(d.headlines)
      if (d.descriptions) setEditDescriptions(d.descriptions)
      if (d.headline_translations) setHeadlineTranslations(d.headline_translations)
      if (d.description_translations) setDescTranslations(d.description_translations)
      setChatMessages(prev => [...prev, { role: 'ai', text: d.reply || '已修改完成' }])
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'ai', text: `修改失败: ${err?.response?.data?.detail || err.message}` }])
    } finally {
      setChatLoading(false)
    }
  }

  // Auto-scroll chat box
  useEffect(() => {
    if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight
  }, [chatMessages])

  const phaseIcon = streamPhase === 'done' ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> :
                    streamPhase === 'error' ? <BulbOutlined style={{ color: '#ff4d4f' }} /> :
                    <LoadingOutlined style={{ color: '#1890ff' }} />

  const keywordColumns = [
    { title: '关键词', dataIndex: 'keyword', width: 250 },
    { title: '月搜索量', dataIndex: 'avg_monthly_searches', width: 120, sorter: (a, b) => a.avg_monthly_searches - b.avg_monthly_searches },
    { title: '竞争度', dataIndex: 'competition', width: 100, render: v => <Tag color={v === 'HIGH' ? 'red' : v === 'MEDIUM' ? 'orange' : 'green'}>{v}</Tag> },
    { title: 'CPC 低', dataIndex: 'low_top_of_page_bid', width: 90, render: v => `$${v.toFixed(2)}` },
    { title: 'CPC 高', dataIndex: 'high_top_of_page_bid', width: 90, render: v => `$${v.toFixed(2)}` },
  ]

  const steps = [
    { title: '广告系列设置' },
    { title: '关键词 & 广告组' },
    { title: 'AI 智能文案' },
    { title: '预览 & 创建' },
  ]

  // 创建成功后显示全屏成功页
  if (createResult) {
    const campaignLink = createResult.campaign_link || ''
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: 'calc(100vh - 120px)', padding: 40, background: '#fff',
      }}>
        <CheckCircleOutlined style={{ fontSize: 72, color: '#52c41a', marginBottom: 24 }} />
        <Typography.Title level={2} style={{ marginBottom: 8 }}>广告创建成功</Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 16, marginBottom: 32 }}>
          广告系列: {createResult.campaign_name || createResult.campaign_id}
        </Typography.Text>

        {campaignLink && (
          <Card
            size="small"
            style={{ width: '100%', maxWidth: 600, marginBottom: 24, borderColor: '#91caff' }}
            title={<span><LinkOutlined /> Campaign Link</span>}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Input value={campaignLink} readOnly style={{ flex: 1 }} />
              <Button
                icon={<CopyOutlined />}
                onClick={() => {
                  navigator.clipboard.writeText(campaignLink)
                  message.success('链接已复制')
                }}
              >
                复制
              </Button>
            </div>
          </Card>
        )}

        <Space size={16}>
          <Button type="primary" size="large" onClick={() => navigate('/ads/test-dashboard')}>
            查看测试看板
          </Button>
          <Button size="large" onClick={() => navigate('/merchant-management')}>
            返回商家管理
          </Button>
        </Space>

        <Typography.Text type="secondary" style={{ marginTop: 24, fontSize: 13 }}>
          广告数据将在次日同步后显示
        </Typography.Text>
      </div>
    )
  }

  return (
    <div style={{ padding: 24 }}>
      {(() => {
        const restrictions = detectMerchantRestrictions(merchantName)
        return restrictions.length > 0 && (
          <Alert
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            style={{ marginBottom: 12 }}
            message={restrictions.map(r => r.label).join(' / ')}
            description={restrictions.map(r => r.tip).join(' ')}
          />
        )
      })()}
      <Typography.Title level={4}>
        <ThunderboltOutlined /> 广告创建向导
        {merchantName && <Tag color="blue" style={{ marginLeft: 12 }}>{merchantName}</Tag>}
        {targetCountry && (
          <Tag color="cyan" style={{ marginLeft: 6 }}>
            <GlobalOutlined /> {COUNTRY_LABELS[targetCountry] || targetCountry}
          </Tag>
        )}
        {assignmentMode && (
          <Tag color={assignmentMode === 'test' ? 'orange' : 'green'} style={{ marginLeft: 6 }}>
            {assignmentMode === 'test' ? '测试' : '正式'}
          </Tag>
        )}
        {holidayName && (
          <Tag color="magenta" style={{ marginLeft: 6 }}>
            🎉 节日营销 — {holidayName}
          </Tag>
        )}
      </Typography.Title>

      <Steps current={step} items={steps} style={{ marginBottom: 24 }} />

      <Spin spinning={loading}>
        {/* Step 0: 选择 MCC */}
        {step === 0 && (
          <Card title="广告系列设置">
            {mccList.length === 0 ? (
              <Alert type="warning" message="您还没有绑定 MCC 账号，请先在设置中添加" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={16}>
                {/* MCC + CID */}
                <Row gutter={16}>
                  <Col span={12}>
                    <Typography.Text strong>MCC 账号</Typography.Text>
                    <Select style={{ width: '100%', marginTop: 4 }} placeholder="选择 MCC 账号"
                      value={selectedMcc} onChange={handleSelectMcc}
                      options={mccList.map(m => ({ value: m.id, label: `${m.name} (${m.mcc_id})` }))}
                    />
                  </Col>
                  <Col span={12}>
                    <Typography.Text strong>客户账号 (CID)</Typography.Text>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <Select style={{ flex: 1 }} placeholder="选择空闲的客户账号"
                        value={availableCid || undefined}
                        onChange={(v) => { setAvailableCid(v); setCidError(''); }}
                        options={allCids.map(cid => ({ value: cid, label: formatCid(cid) }))}
                      />
                      <Button icon={<ReloadOutlined />} loading={refreshingCid} onClick={handleRefreshCids}>刷新</Button>
                    </div>
                    {cidTotal > 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        空闲 {allCids.length} / 总计 {cidTotal}，忙碌 {busyCids.length}
                      </Typography.Text>
                    )}
                  </Col>
                </Row>
                {cidError && <Alert type="error" message={cidError} />}
                {allCids.length === 0 && !loading && selectedMcc && (
                  <Alert type="warning" message="当前 MCC 下没有空闲的客户账号" />
                )}

                <Divider style={{ margin: '4px 0' }}>预算 & 出价</Divider>
                <Row gutter={16}>
                  <Col span={8}>
                    <Typography.Text strong>日预算</Typography.Text>
                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={1} max={10000} step={1}
                      value={dailyBudget} onChange={v => setDailyBudget(v)} addonBefore="$"
                    />
                  </Col>
                  <Col span={8}>
                    <Typography.Text strong>出价策略</Typography.Text>
                    <Select style={{ width: '100%', marginTop: 4 }} value={biddingStrategy} onChange={setBiddingStrategy}
                      options={[
                        { value: 'MAXIMIZE_CLICKS', label: '尽可能多获得点击' },
                        { value: 'MANUAL_CPC', label: '手动 CPC' },
                        { value: 'TARGET_CPA', label: '目标每次转化费用' },
                        { value: 'TARGET_ROAS', label: '目标广告支出回报率' },
                      ]}
                    />
                  </Col>
                  <Col span={8}>
                    <Typography.Text strong>最高 CPC 出价</Typography.Text>
                    <InputNumber style={{ width: '100%', marginTop: 4 }} min={0.01} max={100} step={0.1}
                      value={maxCpcLimit} onChange={v => setMaxCpcLimit(v)} addonBefore="$" placeholder="不限"
                    />
                  </Col>
                </Row>

                <Divider style={{ margin: '4px 0' }}>投放网络 & 设备</Divider>
                <Row gutter={16} align="middle">
                  <Col span={6}><Checkbox checked={networkSearch} onChange={e => setNetworkSearch(e.target.checked)}>Google 搜索</Checkbox></Col>
                  <Col span={6}><Checkbox checked={networkPartners} onChange={e => setNetworkPartners(e.target.checked)}>搜索合作伙伴</Checkbox></Col>
                  <Col span={6}><Checkbox checked={networkDisplay} onChange={e => setNetworkDisplay(e.target.checked)}>展示网络</Checkbox></Col>
                  <Col span={6}>
                    <Select style={{ width: '100%' }} value={adSchedule} onChange={setAdSchedule} size="small"
                      options={[
                        { value: 'all', label: '⏰ 全天候投放' },
                        { value: 'weekday', label: '⏰ 仅工作日' },
                      ]}
                    />
                  </Col>
                </Row>

                <div style={{ marginTop: 8 }}>
                  <Button type="primary" disabled={!availableCid} onClick={() => setStep(1)}>
                    下一步：关键词 & 广告组
                  </Button>
                </div>
              </Space>
            )}
          </Card>
        )}

        {/* Step 1: 关键词 & 广告组 */}
        {step === 1 && (
          <Card title="关键词 & 广告组">
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {/* 广告组名称 + 最终URL（AI 自动填入） */}
              <Row gutter={16}>
                <Col span={8}>
                  <Typography.Text strong>广告组名称</Typography.Text>
                  <Input style={{ marginTop: 4 }} placeholder="自动填入商家名称"
                    value={adGroupName} onChange={e => setAdGroupName(e.target.value)}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>默认使用商家名称，可修改</Typography.Text>
                </Col>
                <Col span={10}>
                  <Typography.Text strong>最终到达网址</Typography.Text>
                  <Input style={{ marginTop: 4 }} placeholder="自动填入商家网址"
                    value={finalUrl} onChange={e => setFinalUrl(e.target.value)}
                  />
                  {isRestricted && (
                    <Typography.Text type="warning" style={{ fontSize: 11 }}>
                      ⚠ 限制品类已自动指向合规页面，请确认网址有效
                    </Typography.Text>
                  )}
                </Col>
                <Col span={6}>
                  <Typography.Text strong>显示路径</Typography.Text>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <Input placeholder="path1" value={displayPath1} onChange={e => setDisplayPath1(e.target.value)} style={{ flex: 1 }} />
                    <Input placeholder="path2" value={displayPath2} onChange={e => setDisplayPath2(e.target.value)} style={{ flex: 1 }} />
                  </div>
                </Col>
              </Row>

              <Divider style={{ margin: '4px 0' }}>关键词研究</Divider>
              <Row gutter={16}>
                <Col span={12}>
                  <Input placeholder="商家网址（如 https://www.trovata.com）" value={keywordUrl} onChange={e => setKeywordUrl(e.target.value)} />
                </Col>
                <Col span={12}>
                  <Input placeholder="种子关键词（逗号分隔）" value={seedKeywords} onChange={e => setSeedKeywords(e.target.value)} />
                </Col>
              </Row>
              <Collapse
                ghost
                items={[{
                  key: 'semrush',
                  label: <span><LinkOutlined /> 使用 SemRush 链接（高级）</span>,
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }} size={8}>
                      <Input
                        placeholder="粘贴 SemRush 链接，如 https://sem.3ue.co/analytics/overview/?q=..."
                        value={semrushUrl}
                        onChange={e => setSemrushUrl(e.target.value)}
                        allowClear
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        如果自动研究无结果，可将 SemRush 网页上的链接粘贴到这里
                      </Typography.Text>
                    </Space>
                  ),
                }]}
              />
              <Row gutter={16} align="middle">
                <Col span={6}>
                  <Button type="primary" icon={<SearchOutlined />} onClick={handleKeywordResearch}>研究关键词</Button>
                </Col>
                <Col span={6}>
                  <Typography.Text strong style={{ marginRight: 8 }}>匹配类型</Typography.Text>
                  <Select size="small" value={keywordMatchType} onChange={setKeywordMatchType} style={{ width: 120 }}
                    options={[
                      { value: 'PHRASE', label: '词组匹配' },
                      { value: 'BROAD', label: '广泛匹配' },
                      { value: 'EXACT', label: '完全匹配' },
                    ]}
                  />
                </Col>
                <Col span={12}>
                  <Typography.Text strong style={{ marginRight: 8 }}>否定关键词</Typography.Text>
                  <Input size="small" placeholder="逗号分隔，如：free, cheap, crack"
                    value={negativeKeywords} onChange={e => setNegativeKeywords(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </Col>
              </Row>
              {keywordResults.length > 0 && (
                <>
                  {/* 搜索关键词（红色区域） */}
                  <div style={{ border: '2px solid #ff4d4f', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                    <Typography.Text strong style={{ color: '#ff4d4f', fontSize: 14 }}>
                      🔍 搜索关键词（{keywordResults.length} 个）
                    </Typography.Text>
                    <Table
                      dataSource={keywordResults}
                      columns={keywordColumns}
                      rowKey="keyword"
                      size="small"
                      pagination={{ pageSize: 10, size: 'small' }}
                      rowSelection={{
                        selectedRowKeys: selectedKeywords,
                        onChange: setSelectedKeywords,
                      }}
                    />
                  </div>

                  {/* AI 推荐关键词（蓝色区域） */}
                  <div style={{ border: '2px solid #1890ff', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                    <Typography.Text strong style={{ color: '#1890ff', fontSize: 14 }}>
                      🤖 AI 推荐关键词 {aiAnalyzing ? <Spin size="small" style={{ marginLeft: 8 }} /> : aiRecommendedKws.length > 0 ? `（${aiRecommendedKws.length} 个）` : ''}
                    </Typography.Text>
                    {aiAnalyzing && <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>Claude claude-opus-4-6 正在分析中...</Typography.Text>}
                    {aiRecommendedKws.length > 0 && (
                      <Table
                        dataSource={aiRecommendedKws}
                        rowKey="keyword"
                        size="small"
                        pagination={false}
                        columns={[
                          { title: '关键词', dataIndex: 'keyword', width: 200 },
                          { title: '预估CPC', dataIndex: 'estimated_cpc', width: 90, render: v => v ? `$${Number(v).toFixed(2)}` : '-' },
                          { title: '匹配类型', dataIndex: 'match_type', width: 90, render: v => <Tag color="blue">{v === 'PHRASE' ? '词组' : v === 'EXACT' ? '完全' : '广泛'}</Tag> },
                          { title: '优先级', dataIndex: 'priority', width: 80, render: v => <Tag color={v === 'high' ? 'red' : v === 'medium' ? 'orange' : 'default'}>{v === 'high' ? '高' : v === 'medium' ? '中' : '低'}</Tag> },
                          { title: '推荐理由', dataIndex: 'reason', ellipsis: true },
                        ]}
                        rowSelection={{
                          selectedRowKeys: selectedKeywords,
                          onChange: setSelectedKeywords,
                        }}
                      />
                    )}
                    {!aiAnalyzing && aiRecommendedKws.length === 0 && (
                      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>等待 AI 分析完成...</Typography.Text>
                    )}
                  </div>

                  {/* AI 否定关键词（绿色区域） */}
                  <div style={{ border: '2px solid #52c41a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                    <Typography.Text strong style={{ color: '#52c41a', fontSize: 14 }}>
                      🚫 AI 推荐否定关键词 {aiNegativeKws.length > 0 ? `（${aiNegativeKws.length} 个）` : ''}
                    </Typography.Text>
                    {aiNegativeKws.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {aiNegativeKws.map((nk, i) => (
                          <Tooltip key={i} title={nk.reason}>
                            <Tag color="red" closable onClose={() => {
                              setAiNegativeKws(prev => prev.filter((_, idx) => idx !== i))
                              setNegativeKeywords(prev => {
                                const parts = prev.split(',').map(s => s.trim()).filter(s => s !== nk.keyword)
                                return parts.join(', ')
                              })
                            }}>
                              {nk.keyword}
                            </Tag>
                          </Tooltip>
                        ))}
                      </div>
                    ) : (
                      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                        {aiAnalyzing ? 'AI 分析中...' : '暂无否定关键词建议'}
                      </Typography.Text>
                    )}
                  </div>

                  {/* AI 策略建议 */}
                  {aiStrategySummary && (
                    <Alert type="info" message="AI 策略建议" description={aiStrategySummary} style={{ marginBottom: 12 }} />
                  )}
                  <Space>
                    <Button onClick={() => setStep(0)}>上一步</Button>
                    <Button type="primary" disabled={selectedKeywords.length === 0} onClick={() => {
                      setStep(2)
                      handleGenerateAdCopyStream()
                      const assetUrl = keywordUrl || merchantUrl
                      if (assetUrl) {
                        api.post('/api/ad-creation/merchant-assets', { url: assetUrl })
                          .then(res => {
                            if (res.data?.images?.length) { setMerchantImages(res.data.images); setEnableImages(true) }
                            if (res.data?.logo) { setMerchantLogo(res.data.logo); setEnableLogo(true) }
                            if (res.data?.nav_links?.length) {
                              const realSitelinks = res.data.nav_links.slice(0, 4).map(link => ({
                                link_text: link.text.slice(0, 25),
                                desc1: '',
                                desc2: '',
                                path: link.path,
                                url: link.url,
                              }))
                              setSitelinks(realSitelinks)
                            }
                            if (res.data?.selling_points?.length) {
                              setCallouts(res.data.selling_points.slice(0, 4))
                            }
                          })
                          .catch(() => {})
                      }
                    }}>
                      下一步：AI 智能生成（已选 {selectedKeywords.length} 个关键词）
                    </Button>
                  </Space>
                </>
              )}
            </Space>
          </Card>
        )}

        {/* Step 2: AI 智能文案（SSE 流式） */}
        {step === 2 && (
          <Card title={<span>AI 智能文案生成 <Tag color="purple" style={{ marginLeft: 8 }}>{COUNTRY_LANGUAGE[targetCountry] || 'English'} ({COUNTRY_LANGUAGE_ZH[targetCountry] || '英语'})</Tag></span>}>
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {/* AI 思考过程 */}
              <div
                ref={thinkingBoxRef}
                style={{
                  background: '#f6f8fa',
                  border: '1px solid #d0d7de',
                  borderRadius: 8,
                  padding: 16,
                  maxHeight: 400,
                  overflowY: 'auto',
                  fontFamily: '-apple-system, "Segoe UI", sans-serif',
                  fontSize: 14,
                  lineHeight: 1.8,
                }}
              >
                <div style={{ marginBottom: 8, fontWeight: 600, color: '#1890ff' }}>
                  {phaseIcon}
                  <span style={{ marginLeft: 8 }}>
                    {streamPhase === 'done' ? 'AI 分析完成' :
                     streamPhase === 'error' ? '生成出错' :
                     'AI 正在思考...'}
                  </span>
                </div>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#24292f' }}>
                  {streamingText || '等待 AI 响应...'}
                  {!streamDone && <span className="cursor-blink" style={{ borderRight: '2px solid #1890ff', animation: 'blink 1s infinite', marginLeft: 2 }} />}
                </pre>
              </div>

              {/* 文案结果 */}
              {streamDone && editHeadlines.length > 0 && (
                <>
                  {/* AI 沟通框 */}
                  <div style={{
                    border: '1px solid #91caff',
                    borderRadius: 8,
                    padding: 12,
                    background: '#f0f7ff',
                  }}>
                    <Typography.Text strong style={{ color: '#1890ff' }}>
                      <BulbOutlined style={{ marginRight: 6 }} />AI 助手 — 告诉 AI 如何修改文案
                    </Typography.Text>
                    {chatMessages.length > 0 && (
                      <div
                        ref={chatBoxRef}
                        style={{
                          maxHeight: 180,
                          overflowY: 'auto',
                          margin: '8px 0',
                          padding: 8,
                          background: '#fff',
                          borderRadius: 6,
                          border: '1px solid #e8e8e8',
                        }}
                      >
                        {chatMessages.map((msg, i) => (
                          <div key={i} style={{ marginBottom: 6 }}>
                            <Tag color={msg.role === 'user' ? 'blue' : 'green'} style={{ marginRight: 6 }}>
                              {msg.role === 'user' ? '你' : 'AI'}
                            </Tag>
                            <span style={{ fontSize: 13 }}>{msg.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <Space.Compact style={{ width: '100%', marginTop: 8 }}>
                      <Input
                        placeholder="例如：第3个标题改短一点 / 加入免费送货信息 / 所有描述加上品牌名"
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onPressEnter={handleChatSend}
                        disabled={chatLoading}
                      />
                      <Button type="primary" onClick={handleChatSend} loading={chatLoading}>
                        发送
                      </Button>
                    </Space.Compact>
                  </div>

                  <Divider style={{ margin: '4px 0' }} />
                  <Typography.Text strong>标题（最多 15 个，每个 ≤ 30 字符）</Typography.Text>
                  {editHeadlines.map((h, i) => (
                    <div key={`h-${i}`} style={{ marginBottom: 4, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <Typography.Text strong style={{ minWidth: 28, textAlign: 'right', lineHeight: '32px', color: '#999', flexShrink: 0 }}>
                        {i + 1}.
                      </Typography.Text>
                      <div style={{ flex: 1 }}>
                        <Input
                          value={h}
                          maxLength={30}
                          suffix={`${h.length}/30`}
                          onChange={e => {
                            const arr = [...editHeadlines]
                            arr[i] = e.target.value
                            setEditHeadlines(arr)
                          }}
                        />
                        {headlineTranslations[i] && (
                          <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 4 }}>
                            译：{headlineTranslations[i]}
                          </Typography.Text>
                        )}
                      </div>
                    </div>
                  ))}
                  <Divider style={{ margin: '8px 0' }} />
                  <Typography.Text strong>描述（最多 4 个，每个 ≤ 90 字符）</Typography.Text>
                  {editDescriptions.map((d, i) => (
                    <div key={`d-${i}`} style={{ marginBottom: 4, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <Typography.Text strong style={{ minWidth: 28, textAlign: 'right', lineHeight: '32px', color: '#999', flexShrink: 0 }}>
                        {i + 1}.
                      </Typography.Text>
                      <div style={{ flex: 1 }}>
                        <TextArea
                          value={d}
                          maxLength={90}
                          autoSize={{ minRows: 1, maxRows: 3 }}
                          onChange={e => {
                            const arr = [...editDescriptions]
                            arr[i] = e.target.value
                            setEditDescriptions(arr)
                          }}
                        />
                        {descTranslations[i] && (
                          <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 4 }}>
                            译：{descTranslations[i]}
                          </Typography.Text>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* 站内链接 */}
                  {sitelinks.length > 0 && (
                    <>
                      <Divider style={{ margin: '8px 0' }} />
                      <Typography.Text strong>站内链接（Sitelinks）</Typography.Text>
                      {sitelinks.map((sl, i) => (
                        <div key={`sl-${i}`} style={{ marginBottom: 8, padding: '8px 12px', background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <Typography.Text strong style={{ minWidth: 28, color: '#999' }}>{i + 1}.</Typography.Text>
                            <Input
                              value={sl.link_text || ''}
                              placeholder="链接文字（≤25字符）"
                              maxLength={25}
                              suffix={`${(sl.link_text || '').length}/25`}
                              onChange={e => {
                                const arr = [...sitelinks]
                                arr[i] = { ...arr[i], link_text: e.target.value }
                                setSitelinks(arr)
                              }}
                            />
                          </div>
                          <div style={{ display: 'flex', gap: 8, paddingLeft: 36 }}>
                            <Input
                              size="small"
                              value={sl.desc1 || ''}
                              placeholder="描述行1（≤35字符）"
                              maxLength={35}
                              onChange={e => {
                                const arr = [...sitelinks]
                                arr[i] = { ...arr[i], desc1: e.target.value }
                                setSitelinks(arr)
                              }}
                            />
                            <Input
                              size="small"
                              value={sl.desc2 || ''}
                              placeholder="描述行2（≤35字符）"
                              maxLength={35}
                              onChange={e => {
                                const arr = [...sitelinks]
                                arr[i] = { ...arr[i], desc2: e.target.value }
                                setSitelinks(arr)
                              }}
                            />
                          </div>
                          {sl.url && (
                            <Typography.Text type="secondary" style={{ fontSize: 11, paddingLeft: 36 }}>
                              🔗 {sl.url}
                            </Typography.Text>
                          )}
                        </div>
                      ))}
                    </>
                  )}

                  {/* 宣传信息 */}
                  {callouts.length > 0 && (
                    <>
                      <Divider style={{ margin: '8px 0' }} />
                      <Typography.Text strong>宣传信息（Callouts）</Typography.Text>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                        {callouts.map((c, i) => (
                          <Input
                            key={`co-${i}`}
                            style={{ width: 220 }}
                            value={c}
                            placeholder={`宣传信息 ${i + 1}（≤25字符）`}
                            maxLength={25}
                            suffix={`${c.length}/25`}
                            onChange={e => {
                              const arr = [...callouts]
                              arr[i] = e.target.value
                              setCallouts(arr)
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}

                  {/* 商家图片 */}
                  {merchantImages.length > 0 && (
                    <>
                      <Divider style={{ margin: '8px 0' }} />
                      <Typography.Text strong>商家图片</Typography.Text>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                        {merchantImages.map((img, i) => (
                          <img key={`img-${i}`} src={img} alt={`商家图片${i + 1}`}
                            style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 6, border: '1px solid #d9d9d9' }}
                          />
                        ))}
                      </div>
                    </>
                  )}

                  {/* 商家图标 */}
                  {merchantLogo && (
                    <>
                      <Divider style={{ margin: '8px 0' }} />
                      <Typography.Text strong>商家图标（Logo）</Typography.Text>
                      <div style={{ marginTop: 4 }}>
                        <img src={merchantLogo} alt="商家Logo"
                          style={{ width: 80, height: 80, objectFit: 'contain', borderRadius: 6, border: '1px solid #d9d9d9', background: '#fff', padding: 4 }}
                        />
                      </div>
                    </>
                  )}

                  <Space>
                    <Button onClick={() => setStep(1)}>上一步</Button>
                    <Button type="primary" onClick={() => setStep(3)}>
                      下一步：预览确认
                    </Button>
                    <Button onClick={() => handleGenerateAdCopyStream()}>重新生成</Button>
                  </Space>
                </>
              )}
              {streamDone && editHeadlines.length === 0 && streamPhase !== 'error' && (
                <Alert type="warning" message="AI 未能生成有效文案，请重试" />
              )}
              {!streamDone && (
                <Typography.Text type="secondary">AI 正在分析并生成文案，请稍候...</Typography.Text>
              )}
            </Space>
          </Card>
        )}

        {/* Step 3: 预览确认 */}
        {step === 3 && (
          <Card title="预览 & 创建广告">
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {/* 广告系列设置摘要 */}
              <Card size="small" title="广告系列设置" type="inner">
                <Row gutter={[16, 8]}>
                  <Col span={6}><Typography.Text type="secondary">MCC 账号</Typography.Text><br />{mccList.find(m => m.id === selectedMcc)?.name || '-'}</Col>
                  <Col span={6}><Typography.Text type="secondary">CID</Typography.Text><br />{formatCid(availableCid)}</Col>
                  <Col span={4}><Typography.Text type="secondary">日预算</Typography.Text><br />${dailyBudget}</Col>
                  <Col span={4}><Typography.Text type="secondary">出价策略</Typography.Text><br />{
                    biddingStrategy === 'MAXIMIZE_CLICKS' ? '尽可能多点击' :
                    biddingStrategy === 'MANUAL_CPC' ? '手动 CPC' :
                    biddingStrategy === 'TARGET_CPA' ? '目标 CPA' : '目标 ROAS'
                  }</Col>
                  <Col span={4}><Typography.Text type="secondary">最高 CPC</Typography.Text><br />{maxCpcLimit ? `$${maxCpcLimit}` : '不限'}</Col>
                </Row>
                <Divider style={{ margin: '8px 0' }} />
                <Space size={12}>
                  <Tag color={networkSearch ? 'green' : 'default'}>Google 搜索: {networkSearch ? '开' : '关'}</Tag>
                  <Tag color={networkPartners ? 'green' : 'default'}>搜索合作伙伴: {networkPartners ? '开' : '关'}</Tag>
                  <Tag color={networkDisplay ? 'green' : 'default'}>展示网络: {networkDisplay ? '开' : '关'}</Tag>
                  <Tag color="blue">投放国家: {targetCountry}</Tag>
                </Space>
              </Card>

              {/* 广告组 & 关键词摘要 */}
              <Card size="small" title="广告组 & 关键词" type="inner">
                <Row gutter={[16, 8]}>
                  <Col span={8}><Typography.Text type="secondary">广告组名称</Typography.Text><br />{adGroupName || merchantName || '默认广告组'}</Col>
                  <Col span={8}><Typography.Text type="secondary">最终到达网址</Typography.Text><br /><Typography.Text copyable ellipsis style={{ maxWidth: 300 }}>{finalUrl || merchantUrl}</Typography.Text></Col>
                  <Col span={4}><Typography.Text type="secondary">匹配类型</Typography.Text><br />{
                    keywordMatchType === 'PHRASE' ? '词组匹配' :
                    keywordMatchType === 'BROAD' ? '广泛匹配' : '完全匹配'
                  }</Col>
                  <Col span={4}><Typography.Text type="secondary">关键词数</Typography.Text><br />{selectedKeywords.length} 个</Col>
                </Row>
                {displayPath1 && (
                  <div style={{ marginTop: 8 }}>
                    <Typography.Text type="secondary">显示路径: </Typography.Text>
                    <Typography.Text code>{displayPath1}{displayPath2 ? `/${displayPath2}` : ''}</Typography.Text>
                  </div>
                )}
                {negativeKeywords && (
                  <div style={{ marginTop: 8 }}>
                    <Typography.Text type="secondary">否定关键词: </Typography.Text>
                    <Typography.Text>{negativeKeywords}</Typography.Text>
                  </div>
                )}
                <Divider style={{ margin: '8px 0' }} />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {selectedKeywords.slice(0, 20).map(kw => <Tag key={kw} color="blue">{kw}</Tag>)}
                  {selectedKeywords.length > 20 && <Tag>+{selectedKeywords.length - 20} 更多</Tag>}
                </div>
              </Card>

              {/* 广告预览 */}
              <Card size="small" title="广告预览" type="inner">
                <div style={{ maxWidth: 600, border: '1px solid #e8e8e8', borderRadius: 8, padding: 16, background: '#fff' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>广告 · {(finalUrl || merchantUrl || '').replace(/^https?:\/\//, '').split('/')[0]}</Typography.Text>
                  <div style={{ marginTop: 4 }}>
                    <Typography.Link style={{ fontSize: 18, fontWeight: 500 }}>
                      {editHeadlines[0] || '标题 1'} | {editHeadlines[1] || '标题 2'} | {editHeadlines[2] || '标题 3'}
                    </Typography.Link>
                  </div>
                  <Typography.Paragraph style={{ margin: '4px 0 0', color: '#4d5156', fontSize: 13 }}>
                    {editDescriptions[0] || '描述 1'}
                  </Typography.Paragraph>
                  {sitelinks.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
                      {sitelinks.slice(0, 4).map((sl, i) => (
                        <Typography.Link key={i} style={{ fontSize: 12 }}>{sl.link_text}</Typography.Link>
                      ))}
                    </div>
                  )}
                  {callouts.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <Typography.Text style={{ fontSize: 12, color: '#70757a' }}>
                        {callouts.filter(Boolean).join(' · ')}
                      </Typography.Text>
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 12 }}>
                  <Typography.Text strong>全部标题 ({editHeadlines.length})</Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {editHeadlines.map((h, i) => <Tag key={i}>{i + 1}. {h}</Tag>)}
                  </div>
                </div>
                <div style={{ marginTop: 8 }}>
                  <Typography.Text strong>全部描述 ({editDescriptions.length})</Typography.Text>
                  {editDescriptions.map((d, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{i + 1}. {d}</div>
                  ))}
                </div>
              </Card>

              {/* 素材摘要 */}
              {(sitelinks.length > 0 || callouts.length > 0 || merchantImages.length > 0 || merchantLogo) && (
                <Card size="small" title="广告素材" type="inner">
                  <Space size={16}>
                    {sitelinks.length > 0 && <Tag color="blue">站内链接 ×{sitelinks.length}</Tag>}
                    {callouts.length > 0 && <Tag color="green">宣传信息 ×{callouts.filter(Boolean).length}</Tag>}
                    {merchantImages.length > 0 && <Tag color="purple">商家图片 ×{merchantImages.length}</Tag>}
                    {merchantLogo && <Tag color="orange">商家 Logo</Tag>}
                  </Space>
                </Card>
              )}

              {/* 限制品类合规 */}
              {isRestricted && (
                <Alert type="warning" message="限制品类提醒" description={
                  <div>
                    <div>该商家属于限制品类：{merchantRestrictions.map(r => r.label).join('、')}</div>
                    <Checkbox
                      checked={complianceSettings.confirmCompliance}
                      onChange={e => setComplianceSettings(prev => ({ ...prev, confirmCompliance: e.target.checked }))}
                      style={{ marginTop: 8 }}
                    >
                      我已阅读并确认遵守 Google Ads 限制品类政策
                    </Checkbox>
                  </div>
                } />
              )}

              <Space>
                <Button onClick={() => setStep(2)}>上一步：修改文案</Button>
                <Button type="primary" icon={<RocketOutlined />} size="large"
                  disabled={isRestricted && !complianceSettings.confirmCompliance}
                  onClick={() => setConfirmModalOpen(true)}
                >
                  确认创建广告
                </Button>
              </Space>
            </Space>
          </Card>
        )}


      </Spin>

      {/* 确认创建弹窗 */}
      <Modal
        title="确认创建广告"
        open={confirmModalOpen}
        onOk={() => {
          if (isRestricted && !complianceSettings.confirmCompliance) {
            message.warning('请先确认已阅读限制品类政策')
            return
          }
          handleCreateAd()
        }}
        onCancel={() => setConfirmModalOpen(false)}
        okText="确认创建"
        cancelText="取消"
        confirmLoading={loading}
        maskClosable={false}
        width={480}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Row><Col span={8}><Typography.Text strong>商家</Typography.Text></Col><Col span={16}><Tag color="blue">{merchantName}</Tag></Col></Row>
          <Row><Col span={8}><Typography.Text strong>CID</Typography.Text></Col><Col span={16}>{formatCid(availableCid)}</Col></Row>
          <Row><Col span={8}><Typography.Text strong>投放国家</Typography.Text></Col><Col span={16}><Tag color="cyan">{targetCountry}</Tag></Col></Row>
          <Row><Col span={8}><Typography.Text strong>日预算</Typography.Text></Col><Col span={16}>${dailyBudget}</Col></Row>
          <Row><Col span={8}><Typography.Text strong>出价策略</Typography.Text></Col><Col span={16}>{
            biddingStrategy === 'MAXIMIZE_CLICKS' ? '尽可能多点击' :
            biddingStrategy === 'MANUAL_CPC' ? '手动 CPC' :
            biddingStrategy === 'TARGET_CPA' ? '目标 CPA' : '目标 ROAS'
          }</Col></Row>
          <Row><Col span={8}><Typography.Text strong>关键词</Typography.Text></Col><Col span={16}>{selectedKeywords.length} 个（{keywordMatchType === 'PHRASE' ? '词组' : keywordMatchType === 'BROAD' ? '广泛' : '完全'}匹配）</Col></Row>
          <Row><Col span={8}><Typography.Text strong>标题/描述</Typography.Text></Col><Col span={16}>{editHeadlines.length} 标题 / {editDescriptions.length} 描述</Col></Row>
          <Divider style={{ margin: '8px 0' }} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            点击确认后将通过 Google Ads API 创建广告系列、广告组和广告。
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  )
}
