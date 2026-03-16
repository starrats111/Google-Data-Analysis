import React, { useEffect, useMemo, useState } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Form,
  Input,
  Select,
  Tag,
  Tabs,
  Modal,
  message,
  InputNumber,
  Statistic,
  Row,
  Col,
  Tooltip,
  Badge,
  Spin,
  Upload,
  Alert,
  Popover,
} from 'antd'
import { ReloadOutlined, SearchOutlined, SyncOutlined, CheckCircleOutlined, CloudSyncOutlined, WarningOutlined, InboxOutlined, ThunderboltOutlined, SettingOutlined, GiftOutlined, CopyOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useAuth } from '../store/authStore'
import dayjs from 'dayjs'

/* ── 类别英→中映射 ── */
const CATEGORY_CN = {
  'fashion': '时尚', 'beauty': '美妆', 'health': '健康', 'health & wellness': '健康养生',
  'tech': '科技', 'technology': '科技', 'home': '家居', 'home & garden': '家居园艺',
  'food & beverage': '食品饮料', 'food & drink': '食品饮料', 'travel': '旅行',
  'pets': '宠物', 'sports': '运动', 'sports & fitness & outdoors': '运动健身户外',
  'fitness': '健身', 'outdoors': '户外', 'other': '其他', 'others': '其他',
  'clothing & accessories': '服饰配件', 'shoes': '鞋类', 'apparel': '服装',
  'computers & electronics': '电脑电子', 'software': '软件',
  'internet services': '互联网服务', 'online services & software': '在线服务与软件',
  'finance & insurance & legal services': '金融保险法律',
  'gifts & flowers': '礼品鲜花', 'art & entertainment': '艺术娱乐',
  'toys & kids': '玩具母婴', 'education': '教育', 'automotive': '汽车',
  'jewelry & watches': '珠宝手表', 'books & media': '图书媒体',
}

function translateCategory(raw) {
  if (!raw) return '-'
  // 清理引号和 "A>A" 冗余格式
  let cleaned = raw.replace(/^"|"$/g, '')
  if (cleaned.includes('>')) {
    const parts = cleaned.split('>')
    cleaned = [...new Set(parts.map(p => p.trim()))].join(' / ')
  }
  // 逐段翻译
  const segments = cleaned.split(/\s*[/&,]\s*/).filter(Boolean)
  const translated = segments.map(s => CATEGORY_CN[s.toLowerCase()] || s)
  // 去重
  return [...new Set(translated)].join(' / ') || '-'
}

const { Option } = Select
const relationshipStatusMap = {
  joined: { color: 'green', label: '通过' },
  pending: { color: 'orange', label: '审核' },
  rejected: { color: 'red', label: '拒绝' },
  unknown: { color: 'default', label: '未知' },
}

const PLATFORM_COLORS = {
  CG: '#1890ff', RW: '#52c41a', LH: '#722ed1', LB: '#fa8c16',
  PM: '#13c2c2', BSH: '#eb2f96', CF: '#faad14',
}

const MerchantManagement = () => {
  const navigate = useNavigate()
  const { permissions, user } = useAuth()
  const role = permissions?.role || user?.role || 'member'
  const canManage = role === 'manager' || role === 'leader'
  const isManager = role === 'manager'

  const [tabKey, setTabKey] = useState('merchants')
  const [loading, setLoading] = useState(false)
  const [merchants, setMerchants] = useState([])
  const [merchantTotal, setMerchantTotal] = useState(0)
  const [merchantPage, setMerchantPage] = useState(1)
  const [merchantPageSize, setMerchantPageSize] = useState(20)

  const [stats, setStats] = useState({
    total: 0,
    by_platform: {},
    last_synced_at: null,
    user_platforms: [],
  })
  const [platformOptions, setPlatformOptions] = useState([])
  const [userOptions, setUserOptions] = useState([])

  // 同步商家
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncPlatformCode, setSyncPlatformCode] = useState(undefined)
  const [syncPlatformLoading, setSyncPlatformLoading] = useState(false)

  const [merchantFilters, setMerchantFilters] = useState({
    platform: undefined,
    search: '',
  })
  const [editMerchantModalOpen, setEditMerchantModalOpen] = useState(false)
  const [commissionModalOpen, setCommissionModalOpen] = useState(false)
  const [commissionData, setCommissionData] = useState(null)
  const [commissionMerchant, setCommissionMerchant] = useState(null)
  const [commissionType, setCommissionType] = useState('self_run')
  const [commissionLoading, setCommissionLoading] = useState(false)

  const [advertiserModalOpen, setAdvertiserModalOpen] = useState(false)
  const [advertiserData, setAdvertiserData] = useState([])
  const [advertiserMerchant, setAdvertiserMerchant] = useState(null)
  const [advertiserLoading, setAdvertiserLoading] = useState(false)

  const [currentMerchant, setCurrentMerchant] = useState(null)
  const [platformSyncLoading, setPlatformSyncLoading] = useState(false)
  const [midRepairLoading, setMidRepairLoading] = useState(false)
  const [editingMidId, setEditingMidId] = useState(null)
  const [editingMidValue, setEditingMidValue] = useState('')
  const [midSaving, setMidSaving] = useState(false)

  // 违规商家状态
  const [violations, setViolations] = useState([])
  const [violationTotal, setViolationTotal] = useState(0)
  const [violationPage, setViolationPage] = useState(1)
  const [violationLoading, setViolationLoading] = useState(false)
  const [violationSearch, setViolationSearch] = useState('')
  const [uploadResult, setUploadResult] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [affectedAssignments, setAffectedAssignments] = useState([])

  // 推荐商家状态
  const [recommendations, setRecommendations] = useState([])
  const [recommendTotal, setRecommendTotal] = useState(0)
  const [recommendPage, setRecommendPage] = useState(1)
  const [recommendLoading, setRecommendLoading] = useState(false)
  const [recommendSearch, setRecommendSearch] = useState('')
  const [recommendUploadResult, setRecommendUploadResult] = useState(null)
  const [recommendUploading, setRecommendUploading] = useState(false)

  const [editMerchantForm] = Form.useForm()

  const platformTags = useMemo(() => {
    const entries = Object.entries(stats.by_platform || {})
    if (!entries.length) return <Tag>暂无</Tag>
    return entries
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => (
        <Tag key={k} color={PLATFORM_COLORS[k] || 'blue'} style={{ cursor: 'default' }}>
          {k} <Badge count={v} style={{ backgroundColor: PLATFORM_COLORS[k] || '#1890ff', marginLeft: 4, boxShadow: 'none' }} overflowCount={99999} />
        </Tag>
      ))
  }, [stats.by_platform])

  useEffect(() => {
    fetchUsers()
    fetchStats()
    fetchMerchants(1, merchantPageSize)
    loadAdDefaults()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tabKey === 'violations') {
      fetchViolations(1)
      fetchViolationAssignments()
    } else if (tabKey === 'recommendations') {
      fetchRecommendations(1)
    }
  }, [tabKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchUsers = async () => {
    try {
      const resp = await api.get('/api/team/users')
      const users = resp.data || []
      setUserOptions(users)
    } catch (error) {
      console.error('获取用户列表失败', error)
    }
  }

  const fetchStats = async () => {
    try {
      const resp = await api.get('/api/merchants/my-library/stats')
      setStats(resp.data || { total: 0, by_platform: {}, last_synced_at: null, user_platforms: [] })
      const userPlats = resp.data?.user_platforms || []
      setPlatformOptions(userPlats.length > 0 ? userPlats : Object.keys(resp.data?.by_platform || {}))
    } catch (error) {
      console.error('获取商家统计失败', error)
    }
  }

  const fetchViolations = async (page = 1) => {
    setViolationLoading(true)
    try {
      const resp = await api.get('/api/merchant-violations', {
        params: { page, page_size: 50, search: violationSearch || undefined },
      })
      setViolations(resp.data?.items || [])
      setViolationTotal(resp.data?.total || 0)
      setViolationPage(page)
    } catch (error) {
      console.error('获取违规商家失败', error)
    } finally {
      setViolationLoading(false)
    }
  }

  const fetchViolationAssignments = async () => {
    try {
      const resp = await api.get('/api/merchant-violations/check-assignments')
      setAffectedAssignments(resp.data?.affected_assignments || [])
    } catch (error) {
      console.error('获取违规分配失败', error)
    }
  }

  const fetchRecommendations = async (page = 1) => {
    setRecommendLoading(true)
    try {
      const resp = await api.get('/api/merchant-recommendations', {
        params: { page, page_size: 50, search: recommendSearch || undefined },
      })
      setRecommendations(resp.data?.items || [])
      setRecommendTotal(resp.data?.total || 0)
      setRecommendPage(page)
    } catch (error) {
      console.error('获取推荐商家失败', error)
    } finally {
      setRecommendLoading(false)
    }
  }

  const handleRecommendUpload = async (file) => {
    setRecommendUploading(true)
    setRecommendUploadResult(null)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const resp = await api.post('/api/merchant-recommendations/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setRecommendUploadResult(resp.data)
      message.success(`上传成功：导入 ${resp.data?.total_records || 0} 条推荐商家`)
      fetchRecommendations(1)
      fetchStats()
    } catch (error) {
      message.error('上传失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setRecommendUploading(false)
    }
    return false
  }

  const handleViolationUpload = async (file) => {
    setUploading(true)
    setUploadResult(null)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const resp = await api.post('/api/merchant-violations/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setUploadResult(resp.data)
      message.success(`上传成功：导入 ${resp.data.total_records} 条违规记录，标记 ${resp.data.marked_merchants} 个商家`)
      fetchViolations(1)
      fetchViolationAssignments()
      fetchStats()
    } catch (error) {
      message.error('上传失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setUploading(false)
    }
    return false // prevent default upload
  }

  const fetchMerchants = async (page = merchantPage, pageSize = merchantPageSize) => {
    setLoading(true)
    try {
      const params = { page, page_size: pageSize }
      if (merchantFilters.platform) params.platform = merchantFilters.platform
      if (merchantFilters.search) params.search = merchantFilters.search

      const resp = await api.get('/api/merchants/my-library', { params })
      const data = resp.data || {}
      setMerchants(data.items || [])
      setMerchantTotal(data.total || 0)
      setMerchantPage(page)
      setMerchantPageSize(pageSize)
    } catch (error) {
      message.error(error.response?.data?.detail || '获取商家列表失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSyncAll = async () => {
    setSyncLoading(true)
    try {
      await api.post('/api/article-gen/campaign-link/sync')
      message.success('同步已在后台启动，数据量较大请稍等几分钟后刷新')
      setTimeout(async () => {
        setSyncLoading(false)
        await Promise.all([fetchStats(), fetchMerchants(1, merchantPageSize)])
      }, 8000)
    } catch (error) {
      message.error(error.response?.data?.detail || '同步失败')
      setSyncLoading(false)
    }
  }

  const handleSyncPlatform = async () => {
    if (!syncPlatformCode) { message.warning('请选择平台'); return }
    setSyncPlatformLoading(true)
    try {
      await api.post(`/api/article-gen/campaign-link/sync/${syncPlatformCode}`)
      message.success(`平台 ${syncPlatformCode} 同步已在后台启动`)
      setTimeout(async () => {
        setSyncPlatformLoading(false)
        await Promise.all([fetchStats(), fetchMerchants(1, merchantPageSize)])
      }, 6000)
    } catch (error) {
      message.error(error.response?.data?.detail || '同步失败')
      setSyncPlatformLoading(false)
    }
  }

  const [discoverLoading, setDiscoverLoading] = useState(false)

  const handleCommissionClick = async (record, type) => {
    setCommissionMerchant(record)
    setCommissionType(type)
    setCommissionLoading(true)
    setCommissionModalOpen(true)
    try {
      const sd = dayjs().subtract(30, 'day').format('YYYY-MM-DD')
      const ed = dayjs().format('YYYY-MM-DD')
      const resp = await api.get(`/api/merchants/${record.id}/commission-breakdown`, { params: { start_date: sd, end_date: ed } })
      setCommissionData(resp.data)
    } catch (error) {
      message.error(error.response?.data?.detail || '获取佣金明细失败')
      setCommissionModalOpen(false)
    } finally {
      setCommissionLoading(false)
    }
  }

  const handleAdvertiserClick = async (record) => {
    const count = record.active_advertiser_count || 0
    if (count === 0) return
    setAdvertiserMerchant(record)
    setAdvertiserLoading(true)
    setAdvertiserModalOpen(true)
    try {
      const resp = await api.get(`/api/merchants/${record.id}/active-advertisers`)
      setAdvertiserData(resp.data)
    } catch (error) {
      message.error(error.response?.data?.detail || '获取在投人员失败')
      setAdvertiserModalOpen(false)
    } finally {
      setAdvertiserLoading(false)
    }
  }

  const handleInlineMidSave = async (merchantId) => {
    const val = editingMidValue.trim()
    if (val && !/^\d+$/.test(val)) {
      message.error('MID 仅支持纯数字')
      return
    }
    setMidSaving(true)
    try {
      await api.put(`/api/merchants/${merchantId}`, { merchant_id: val || null })
      message.success('MID 更新成功')
      setEditingMidId(null)
      setEditingMidValue('')
      await fetchMerchants(merchantPage, merchantPageSize)
    } catch (error) {
      message.error(error.response?.data?.detail || 'MID 更新失败')
    } finally {
      setMidSaving(false)
    }
  }

  const handleToggleTag = async (record, field, value) => {
    try {
      await api.put(`/api/merchants/${record.id}`, { [field]: value })
      message.success(value === 'normal' ? '已取消标记' : '标记成功')
      fetchMerchants()
    } catch {
      message.error('操作失败')
    }
  }

  const openEditMerchantModal = (merchant) => {
    setCurrentMerchant(merchant)
    editMerchantForm.setFieldsValue({
      category: merchant.category,
      commission_rate: merchant.commission_rate,
      status: merchant.status,
      notes: merchant.notes,
      slug: merchant.slug,
      merchant_id: merchant.merchant_id,
    })
    setEditMerchantModalOpen(true)
  }

  const handleEditMerchantSubmit = async () => {
    try {
      const values = await editMerchantForm.validateFields()
      await api.put(`/api/merchants/${currentMerchant.id}`, values)
      message.success('商家更新成功')
      setEditMerchantModalOpen(false)
      setCurrentMerchant(null)
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '商家更新失败')
    }
  }

  const merchantColumns = [
    {
      title: '商家名称',
      dataIndex: 'merchant_name',
      key: 'merchant_name',
      width: 220,
      fixed: 'left',
      render: (text, record) => (
        <Space size={6}>
          {record.logo && <img src={record.logo} alt="" style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'contain' }} />}
          <span style={{ fontWeight: 600 }}>{text || '-'}</span>
          {record.campaign_link && (
            <Tooltip title="复制 Campaign Link">
              <CopyOutlined
                style={{ color: '#1677ff', cursor: 'pointer', fontSize: 13 }}
                onClick={(e) => {
                  e.stopPropagation()
                  navigator.clipboard.writeText(record.campaign_link)
                    .then(() => message.success('Campaign Link 已复制'))
                    .catch(() => message.error('复制失败'))
                }}
              />
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '平台',
      dataIndex: 'platform_code',
      key: 'platform_code',
      width: 80,
      render: (val) => <Tag color={PLATFORM_COLORS[val] || 'blue'}>{val || '-'}</Tag>,
    },
    {
      title: 'MID',
      dataIndex: 'merchant_id',
      key: 'merchant_id',
      width: 110,
      render: (val) => <span style={{ fontSize: 12 }}>{val || '-'}</span>,
    },
    {
      title: '类别',
      dataIndex: 'categories',
      key: 'categories',
      width: 120,
      render: (val) => <Tooltip title={val}>{translateCategory(val)}</Tooltip>,
    },
    {
      title: '佣金率',
      dataIndex: 'commission_rate',
      key: 'commission_rate',
      width: 100,
      sorter: (a, b) => {
        const pa = parseFloat((a.commission_rate || '0').replace('%', ''))
        const pb = parseFloat((b.commission_rate || '0').replace('%', ''))
        return pa - pb
      },
      render: (val) => val || '-',
    },
    {
      title: '支持地区',
      dataIndex: 'support_regions',
      key: 'support_regions',
      width: 150,
      render: (regions) => {
        if (!regions || !Array.isArray(regions) || regions.length === 0) return '-'
        const shown = regions.slice(0, 3)
        return (
          <Tooltip title={regions.map(r => r.code || r).join(', ')}>
            <Space size={2} wrap>
              {shown.map((r, i) => <Tag key={i} style={{ fontSize: 11, margin: 0 }}>{r.code || r}</Tag>)}
              {regions.length > 3 && <span style={{ fontSize: 11, color: '#999' }}>+{regions.length - 3}</span>}
            </Space>
          </Tooltip>
        )
      },
    },
    {
      title: '在投人数',
      dataIndex: 'active_advertisers',
      key: 'active_advertisers',
      width: 90,
      align: 'center',
      sorter: (a, b) => (a.active_advertisers || 0) - (b.active_advertisers || 0),
      render: (val, record) => {
        const count = val || 0
        return count > 0 ? (
          <Button size="small" type="link" style={{ padding: 0, fontWeight: 600, color: '#1677ff' }} onClick={() => handleShowActiveAdv(record)}>
            {count} 人
          </Button>
        ) : <span style={{ color: '#bfbfbf' }}>0</span>
      },
    },
    {
      title: '同步时间',
      dataIndex: 'synced_at',
      key: 'synced_at',
      width: 140,
      render: (val) => val ? dayjs(val).format('MM-DD HH:mm') : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right',
      render: (_, record) => (
        <Button
          size="small"
          type="link"
          style={{ padding: '0 4px', color: '#722ed1' }}
          onClick={() => openClaimModal(record)}
        >
          领取
        </Button>
      ),
    },
  ]

  // CR-048: 领取商家 — 先弹窗选择国家+模式
  const [claimModalOpen, setClaimModalOpen] = useState(false)
  const [claimRecord, setClaimRecord] = useState(null)
  const [claimCountry, setClaimCountry] = useState('US')
  const [claimMode, setClaimMode] = useState('test')
  const [claimLoading, setClaimLoading] = useState(false)

  // 在投人数详情弹窗
  const [activeAdvModalOpen, setActiveAdvModalOpen] = useState(false)
  const [activeAdvMerchant, setActiveAdvMerchant] = useState(null)
  const [activeAdvList, setActiveAdvList] = useState([])
  const [activeAdvLoading, setActiveAdvLoading] = useState(false)

  const handleShowActiveAdv = async (record) => {
    setActiveAdvMerchant(record)
    setActiveAdvModalOpen(true)
    setActiveAdvLoading(true)
    try {
      const res = await api.get('/api/merchants/my-library/active-advertisers', { params: { merchant_id: record.merchant_id } })
      setActiveAdvList(res.data || [])
    } catch { setActiveAdvList([]) }
    finally { setActiveAdvLoading(false) }
  }

  // 节日营销
  const [holidayCountry, setHolidayCountry] = useState('US')
  const [holidayList, setHolidayList] = useState([])
  const [holidayLoading, setHolidayLoading] = useState(false)
  const [holidayModalOpen, setHolidayModalOpen] = useState(false)
  const [selectedHoliday, setSelectedHoliday] = useState(null)
  const [holidayMerchants, setHolidayMerchants] = useState([])
  const [holidayMerchantsByPlatform, setHolidayMerchantsByPlatform] = useState({})
  const [holidayPlatforms, setHolidayPlatforms] = useState([])
  const [holidayPlatformFilter, setHolidayPlatformFilter] = useState(undefined)
  const [holidayMerchantLoading, setHolidayMerchantLoading] = useState(false)

  // 广告默认设置
  const [adDefaultsModalOpen, setAdDefaultsModalOpen] = useState(false)
  const [adDefaults, setAdDefaults] = useState({
    bidding_strategy: 'MANUAL_CPC',
    enhanced_cpc: false,
    target_google_search: true,
    target_search_network: false,
    target_content_network: false,
    default_cpc_bid: 1.0,
    default_daily_budget: 10,
    geo_target_type: 'PRESENCE',
    eu_political_ads: false,
  })
  const [adDefaultsForm] = Form.useForm()

  const ALL_CLAIM_COUNTRIES = [
    { value: 'US', label: '美国 (English)' },
    { value: 'UK', label: '英国 (English)' },
    { value: 'CA', label: '加拿大 (English)' },
    { value: 'AU', label: '澳大利亚 (English)' },
    { value: 'DE', label: '德国 (German)' },
    { value: 'FR', label: '法国 (French)' },
    { value: 'JP', label: '日本 (Japanese)' },
    { value: 'BR', label: '巴西 (Portuguese)' },
  ]

  const claimCountryOptions = useMemo(() => {
    const regions = claimRecord?.support_regions
    if (!regions || !Array.isArray(regions) || regions.length === 0) return ALL_CLAIM_COUNTRIES
    const codes = regions.map(r => (r.code || r || '').toUpperCase())
    const filtered = ALL_CLAIM_COUNTRIES.filter(c => codes.includes(c.value))
    return filtered.length > 0 ? filtered : ALL_CLAIM_COUNTRIES
  }, [claimRecord])

  const loadAdDefaults = async () => {
    try {
      const res = await api.get('/api/merchants/ad-defaults')
      if (res.data) {
        setAdDefaults(prev => ({ ...prev, ...res.data }))
        adDefaultsForm.setFieldsValue(res.data)
      }
    } catch (e) {
      // silently use defaults
    }
  }

  const saveAdDefaults = async () => {
    try {
      const values = await adDefaultsForm.validateFields()
      const payload = {
        bidding_strategy: values.bidding_strategy ?? adDefaults.bidding_strategy,
        enhanced_cpc: values.enhanced_cpc ?? adDefaults.enhanced_cpc,
        target_google_search: values.target_google_search ?? adDefaults.target_google_search,
        target_search_network: values.target_search_network ?? adDefaults.target_search_network,
        target_content_network: values.target_content_network ?? adDefaults.target_content_network,
        default_cpc_bid: values.default_cpc_bid ?? adDefaults.default_cpc_bid,
        default_daily_budget: values.default_daily_budget ?? adDefaults.default_daily_budget,
        geo_target_type: values.geo_target_type ?? adDefaults.geo_target_type,
        eu_political_ads: values.eu_political_ads ?? adDefaults.eu_political_ads,
      }
      await api.put('/api/merchants/ad-defaults', payload)
      setAdDefaults(payload)
      setAdDefaultsModalOpen(false)
      message.success('广告默认设置已保存')
    } catch (err) {
      if (err?.errorFields) return
      message.error('保存失败: ' + (err?.response?.data?.detail || err.message))
    }
  }

  const openClaimModal = (record) => {
    setClaimRecord(record)
    const regions = record.support_regions || []
    const codes = regions.map(r => (r.code || r || '').toUpperCase())
    const firstMatch = ALL_CLAIM_COUNTRIES.find(c => codes.includes(c.value))
    setClaimCountry(firstMatch ? firstMatch.value : 'US')
    setClaimMode('test')
    setClaimModalOpen(true)
  }

  const handleClaimConfirm = async () => {
    if (!claimRecord) return
    setClaimLoading(true)
    try {
      const payload = {
        mode: claimMode,
        target_country: claimCountry,
      }
      if (claimRecord.platform_code && claimRecord.merchant_id) {
        payload.platform_code = claimRecord.platform_code
        payload.merchant_mid = claimRecord.merchant_id
        payload.merchant_name = claimRecord.merchant_name || ''
      } else {
        payload.merchant_ids = [claimRecord.id]
      }
      const res = await api.post('/api/merchant-assignments/claim', payload)
      const created = res.data?.assignments || []
      if (created.length > 0) {
        message.success(`已领取商家: ${claimRecord.merchant_name}`)
        setClaimModalOpen(false)
        fetchMerchants(merchantPage, merchantPageSize)
        const assignment = created[0]
        Modal.confirm({
          title: '领取成功',
          content: `已领取商家「${claimRecord.merchant_name}」(${claimCountry}, ${claimMode === 'test' ? '测试模式' : '正式模式'})，是否立即创建广告？`,
          okText: '创建广告',
          cancelText: '稍后再说',
          onOk: () => {
            const params = new URLSearchParams({
              assignment_id: assignment.id,
              merchant_name: claimRecord.merchant_name || '',
            })
            navigate(`/ads/create?${params.toString()}`)
          },
        })
      } else {
        setClaimModalOpen(false)
        const skippedList = res.data?.skipped_assignments || []
        if (skippedList.length > 0) {
          const existing = skippedList[0]
          Modal.confirm({
            title: '该商家已领取',
            content: `你已领取过「${existing.merchant_name}」，是否立即创建广告？`,
            okText: '创建广告',
            cancelText: '稍后再说',
            onOk: () => {
              const params = new URLSearchParams({
                assignment_id: existing.id,
                merchant_name: existing.merchant_name || '',
              })
              navigate(`/ads/create?${params.toString()}`)
            },
          })
        } else {
          message.info(res.data?.message || '该商家你已经领取过了')
        }
      }
    } catch (err) {
      console.error('Claim error:', err)
      const detail = err?.response?.data?.detail || err?.message || '未知错误'
      message.error(`领取失败: ${detail}`)
    } finally {
      setClaimLoading(false)
    }
  }

  const fetchHolidays = async (country) => {
    setHolidayLoading(true)
    try {
      const res = await api.get('/api/holidays', { params: { country, days: 30 } })
      setHolidayList(res.data?.holidays || [])
    } catch (e) {
      console.error('Holiday fetch error:', e)
      setHolidayList([])
    } finally {
      setHolidayLoading(false)
    }
  }

  useEffect(() => { fetchHolidays(holidayCountry) }, [holidayCountry])

  const handleHolidayClick = async (holiday) => {
    setSelectedHoliday(holiday)
    setHolidayModalOpen(true)
    setHolidayMerchantLoading(true)
    setHolidayMerchants([])
    setHolidayMerchantsByPlatform({})
    setHolidayPlatforms([])
    setHolidayPlatformFilter(undefined)
    try {
      const res = await api.post('/api/holidays/recommend-merchants', {
        holiday_name: holiday.name,
        country: holidayCountry,
      })
      const data = res.data || {}
      setHolidayMerchants(data.merchants || [])
      setHolidayMerchantsByPlatform(data.by_platform || {})
      setHolidayPlatforms(data.platforms || [])
    } catch (e) {
      message.error('获取推荐商家失败')
      setHolidayMerchants([])
    } finally {
      setHolidayMerchantLoading(false)
    }
  }

  const handleHolidayClaim = (record) => {
    setClaimRecord(record)
    setClaimCountry(holidayCountry)
    setClaimMode('test')
    setClaimModalOpen(true)
  }

  const origHandleClaimConfirm = handleClaimConfirm
  const handleHolidayClaimConfirm = async () => {
    if (!claimRecord) return
    setClaimLoading(true)
    try {
      const res = await api.post('/api/merchant-assignments/claim', {
        merchant_ids: [claimRecord.id],
        mode: claimMode,
        target_country: claimCountry,
      })
      const created = res.data?.assignments || []
      if (created.length > 0) {
        message.success(`已领取商家: ${claimRecord.merchant_name}`)
        setClaimModalOpen(false)
        setHolidayModalOpen(false)
        const assignment = created[0]
        const params = new URLSearchParams({
          assignment_id: assignment.id,
          merchant_name: claimRecord.merchant_name || '',
          holiday_name: selectedHoliday?.name || '',
        })
        Modal.confirm({
          title: '领取成功',
          content: `已领取商家「${claimRecord.merchant_name}」，是否立即创建节日广告？文案将贴合「${selectedHoliday?.name || ''}」氛围。`,
          okText: '创建广告',
          cancelText: '稍后再说',
          onOk: () => navigate(`/ads/create?${params.toString()}`),
        })
      } else {
        setClaimModalOpen(false)
        const skippedList = res.data?.skipped_assignments || []
        if (skippedList.length > 0) {
          const existing = skippedList[0]
          const params = new URLSearchParams({
            assignment_id: existing.id,
            merchant_name: existing.merchant_name || '',
            holiday_name: selectedHoliday?.name || '',
          })
          Modal.confirm({
            title: '该商家已领取',
            content: `你已领取过「${existing.merchant_name}」，是否立即创建节日广告？`,
            okText: '创建广告',
            cancelText: '稍后再说',
            onOk: () => navigate(`/ads/create?${params.toString()}`),
          })
        } else {
          message.info(res.data?.message || '该商家你已经领取过了')
        }
      }
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.message || '未知错误'
      message.error(`领取失败: ${detail}`)
    } finally {
      setClaimLoading(false)
    }
  }

  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 16 }}>
          {/* 左侧：我的商家库统计 */}
          <Col xs={24} md={6}>
            <Card size="small" style={{ height: '100%' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Statistic title="我的商家" value={stats.total || 0} valueStyle={{ fontSize: 20 }} />
                <div>
                  <span style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>平台分布</span>
                  <Space wrap size={4}>{platformTags}</Space>
                </div>
                <div style={{ fontSize: 11, color: '#999' }}>
                  最近同步: {stats.last_synced_at ? dayjs(stats.last_synced_at).format('YYYY-MM-DD HH:mm') : '从未同步'}
                </div>
              </div>
            </Card>
          </Col>

          {/* 红框：广告投放设置 */}
          <Col xs={24} md={10}>
            <Card
              size="small"
              title={<span style={{ fontSize: 13 }}>广告投放设置</span>}
              extra={
                <Button size="small" icon={<SettingOutlined />} onClick={() => { loadAdDefaults(); setAdDefaultsModalOpen(true) }}>
                  编辑
                </Button>
              }
              style={{ height: '100%' }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px' }}>
                <Tag color="blue">
                  出价: {adDefaults.bidding_strategy === 'MAXIMIZE_CLICKS' ? '尽可能多点击' : '手动CPC'}
                </Tag>
                <Tag color={adDefaults.enhanced_cpc ? 'green' : 'default'}>
                  eCPC: {adDefaults.enhanced_cpc ? '开' : '关'}
                </Tag>
                <Tag color="purple">CPC: ${adDefaults.default_cpc_bid}</Tag>
                <Tag color="purple">日预算: ${adDefaults.default_daily_budget}</Tag>
                <Tag color={adDefaults.target_google_search ? 'green' : 'default'}>
                  Google搜索: {adDefaults.target_google_search ? '开' : '关'}
                </Tag>
                <Tag color={adDefaults.target_search_network ? 'green' : 'default'}>
                  合作伙伴: {adDefaults.target_search_network ? '开' : '关'}
                </Tag>
                <Tag color={adDefaults.target_content_network ? 'green' : 'default'}>
                  展示网络: {adDefaults.target_content_network ? '开' : '关'}
                </Tag>
                <Tag color="cyan">
                  地理定位: {adDefaults.geo_target_type === 'PRESENCE' ? '所在地' : '所在地或兴趣'}
                </Tag>
                <Tag color={adDefaults.eu_political_ads ? 'red' : 'green'}>
                  欧盟政治广告: {adDefaults.eu_political_ads ? '投放' : '不投放'}
                </Tag>
              </div>
            </Card>
          </Col>

          {/* 绿框：测试商家数量 */}
          <Col xs={24} md={4}>
            <Card size="small" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Statistic
                title="测试商家"
                value={stats.test_merchant_count || 0}
                suffix="个"
                valueStyle={{ fontSize: 24, color: '#52c41a' }}
              />
            </Card>
          </Col>

          {/* 节日营销 */}
          <Col xs={24} md={4}>
            <Card size="small" style={{ height: '100%' }} bodyStyle={{ padding: '8px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <GiftOutlined style={{ color: '#eb2f96' }} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>节日营销</span>
              </div>
              <Select
                size="small"
                style={{ width: '100%', marginBottom: 6 }}
                value={holidayCountry}
                onChange={(v) => setHolidayCountry(v)}
                options={ALL_CLAIM_COUNTRIES.map(c => ({ value: c.value, label: c.value }))}
              />
              {holidayLoading ? (
                <Spin size="small" />
              ) : holidayList.length === 0 ? (
                <div style={{ color: '#bfbfbf', fontSize: 11, textAlign: 'center' }}>近期无节日</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {holidayList.slice(0, 3).map((h, i) => (
                    <Tag
                      key={i}
                      color={h.type === 'commercial' ? 'magenta' : 'blue'}
                      style={{ cursor: 'pointer', fontSize: 11, margin: 0 }}
                      onClick={() => handleHolidayClick(h)}
                    >
                      {h.date?.slice(5)} {h.name_zh || h.name}
                    </Tag>
                  ))}
                  {holidayList.length > 3 && (
                    <a style={{ fontSize: 11, textAlign: 'right' }} onClick={() => {
                      setSelectedHoliday(null)
                      setHolidayModalOpen(true)
                      setHolidayMerchants([])
                    }}>
                      +{holidayList.length - 3} 更多...
                    </a>
                  )}
                </div>
              )}
            </Card>
          </Col>
        </Row>

      <Tabs
        activeKey={tabKey}
        onChange={setTabKey}
        items={[
          {
            key: 'merchants',
            label: '我的商家库',
            children: (
              <Card
                title="我的商家库"
                extra={
                  <Space>
                    <Tooltip title="刷新列表">
                      <Button icon={<ReloadOutlined />} onClick={() => fetchMerchants(merchantPage, merchantPageSize)} />
                    </Tooltip>
                    <Button icon={<SyncOutlined />} loading={syncLoading} onClick={handleSyncAll} type="primary">
                      同步所有商家
                    </Button>
                    <Select
                      allowClear
                      placeholder="选择平台"
                      style={{ width: 110 }}
                      value={syncPlatformCode}
                      onChange={(v) => setSyncPlatformCode(v)}
                    >
                      {platformOptions.map((p) => <Option key={p} value={p}>{p}</Option>)}
                    </Select>
                    <Button icon={<CloudSyncOutlined />} loading={syncPlatformLoading} onClick={handleSyncPlatform} disabled={!syncPlatformCode}>
                      同步该平台
                    </Button>
                  </Space>
                }
              >
                <Space wrap style={{ marginBottom: 12 }}>
                  <Select
                    allowClear
                    placeholder="平台"
                    style={{ width: 140 }}
                    value={merchantFilters.platform}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, platform: v }))}
                  >
                    {platformOptions.map((p) => (
                      <Option key={p} value={p}>{p}</Option>
                    ))}
                  </Select>

                  <Input
                    allowClear
                    placeholder="搜索商家名/MID"
                    style={{ width: 240 }}
                    value={merchantFilters.search}
                    prefix={<SearchOutlined />}
                    onChange={(e) => setMerchantFilters((s) => ({ ...s, search: e.target.value }))}
                    onPressEnter={() => fetchMerchants(1, merchantPageSize)}
                  />

                  <Button type="primary" onClick={() => fetchMerchants(1, merchantPageSize)}>查询</Button>
                  <Button
                    onClick={() => {
                      setMerchantFilters({ platform: undefined, search: '' })
                      setTimeout(() => fetchMerchants(1, merchantPageSize), 0)
                    }}
                  >
                    重置
                  </Button>
                </Space>

                <Table
                  rowKey="id"
                  loading={loading && tabKey === 'merchants'}
                  columns={merchantColumns}
                  dataSource={merchants}
                  scroll={{ x: 1200 }}
                  pagination={{
                    current: merchantPage,
                    pageSize: merchantPageSize,
                    total: merchantTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (page, size) => fetchMerchants(page, size),
                  }}
                />
              </Card>
            ),
          },
          ...(isManager ? [{
            key: 'violations',
            label: (
              <span>
                <WarningOutlined style={{ color: '#ff4d4f', marginRight: 4 }} />
                违规商家
                {affectedAssignments.length > 0 && (
                  <Badge count={affectedAssignments.length} size="small" style={{ marginLeft: 6 }} />
                )}
              </span>
            ),
            children: (
              <Card title="违规商家管理">
                {/* 上传区域 */}
                <Upload.Dragger
                  accept=".xlsx,.xls"
                  showUploadList={false}
                  beforeUpload={handleViolationUpload}
                  disabled={uploading}
                  style={{ marginBottom: 16 }}
                >
                  <p className="ant-upload-drag-icon">
                    <InboxOutlined />
                  </p>
                  <p className="ant-upload-text">点击或拖拽 Excel 文件到此区域上传</p>
                  <p className="ant-upload-hint">支持 .xlsx / .xls 格式，包含列：商家Mcid、Violation Time、商家ID、商家名称、平台、商家URL</p>
                </Upload.Dragger>

                {uploading && <Spin tip="正在上传并处理..." style={{ display: 'block', margin: '16px 0' }} />}

                {uploadResult && (
                  <Alert
                    type={uploadResult.affected_assignments > 0 ? 'warning' : 'success'}
                    showIcon
                    closable
                    style={{ marginBottom: 16 }}
                    message={`上传完成：导入 ${uploadResult.total_records} 条记录，标记 ${uploadResult.marked_merchants} 个商家`}
                    description={
                      uploadResult.affected_assignments > 0
                        ? `发现 ${uploadResult.affected_assignments} 条员工分配涉及违规商家，已发送通知给 ${uploadResult.notified_users} 位相关人员。`
                        : '未发现员工分配涉及违规商家。'
                    }
                  />
                )}

                {/* 员工违规告警 */}
                {affectedAssignments.length > 0 && (
                  <Alert
                    type="error"
                    showIcon
                    icon={<WarningOutlined />}
                    style={{ marginBottom: 16 }}
                    message={`${affectedAssignments.length} 条员工分配涉及违规商家`}
                    description={
                      <div style={{ maxHeight: 200, overflow: 'auto' }}>
                        <Table
                          size="small"
                          rowKey={(r, i) => i}
                          pagination={false}
                          dataSource={affectedAssignments}
                          columns={[
                            { title: '员工', dataIndex: 'user_display_name', key: 'user', width: 120 },
                            { title: '商家', dataIndex: 'merchant_name', key: 'merchant', width: 200 },
                            { title: '平台', dataIndex: 'platform', key: 'platform', width: 80,
                              render: (v) => <Tag color={PLATFORM_COLORS[v] || 'blue'}>{v}</Tag> },
                            { title: '违规时间', dataIndex: 'violation_time', key: 'vt', width: 160,
                              render: (v) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
                          ]}
                        />
                      </div>
                    }
                  />
                )}

                {/* 违规商家列表 */}
                <Space style={{ marginBottom: 12 }}>
                  <Input
                    allowClear
                    placeholder="搜索商家名/MCID/MID"
                    style={{ width: 260 }}
                    prefix={<SearchOutlined />}
                    value={violationSearch}
                    onChange={(e) => setViolationSearch(e.target.value)}
                    onPressEnter={() => fetchViolations(1)}
                  />
                  <Button type="primary" onClick={() => fetchViolations(1)}>查询</Button>
                </Space>

                <Table
                  rowKey="id"
                  loading={violationLoading}
                  dataSource={violations}
                  scroll={{ x: 1000 }}
                  pagination={{
                    current: violationPage,
                    pageSize: 50,
                    total: violationTotal,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (page) => fetchViolations(page),
                  }}
                  columns={[
                    { title: '商家名称', dataIndex: 'merchant_name', key: 'name', width: 200 },
                    { title: 'MCID', dataIndex: 'mcid', key: 'mcid', width: 160, render: (v) => v || '-' },
                    { title: 'MID', dataIndex: 'merchant_mid', key: 'mid', width: 100, render: (v) => v || '-' },
                    { title: '平台', dataIndex: 'platform', key: 'platform', width: 80,
                      render: (v) => <Tag color={PLATFORM_COLORS[v] || 'blue'}>{v || '-'}</Tag> },
                    { title: '违规时间', dataIndex: 'violation_time', key: 'vt', width: 170,
                      render: (v) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
                    { title: '商家URL', dataIndex: 'merchant_url', key: 'url', width: 200, ellipsis: true,
                      render: (v) => v ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : '-' },
                    { title: '上传批次', dataIndex: 'upload_batch', key: 'batch', width: 200 },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'recommendations',
            label: (
              <span>
                <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 4 }} />
                推荐商家
              </span>
            ),
            children: (
              <Card title="推荐商家管理">
                <Upload.Dragger
                  accept=".xlsx,.xls"
                  showUploadList={false}
                  beforeUpload={handleRecommendUpload}
                  disabled={recommendUploading}
                  style={{ marginBottom: 16 }}
                >
                  <p className="ant-upload-drag-icon">
                    <InboxOutlined />
                  </p>
                  <p className="ant-upload-text">点击或拖拽推荐商家 Excel 文件到此区域上传</p>
                  <p className="ant-upload-hint">支持 .xlsx / .xls 格式，包含列：mcid、MID、广告主名称、网址、商家地区、EPC、佣金等</p>
                </Upload.Dragger>

                {recommendUploading && <Spin tip="正在上传并处理..." style={{ display: 'block', margin: '16px 0' }} />}

                {recommendUploadResult && (
                  <Alert
                    type="success"
                    showIcon
                    closable
                    style={{ marginBottom: 16 }}
                    message={`上传完成：导入 ${recommendUploadResult.total_records} 条推荐商家，标记 ${recommendUploadResult.marked_merchants} 个已有商家`}
                  />
                )}

                <Space style={{ marginBottom: 12 }}>
                  <Input
                    allowClear
                    placeholder="搜索商家名/MCID/MID"
                    style={{ width: 260 }}
                    prefix={<SearchOutlined />}
                    value={recommendSearch}
                    onChange={(e) => setRecommendSearch(e.target.value)}
                    onPressEnter={() => fetchRecommendations(1)}
                  />
                  <Button type="primary" onClick={() => fetchRecommendations(1)}>查询</Button>
                </Space>

                <Table
                  rowKey="id"
                  loading={recommendLoading}
                  dataSource={recommendations}
                  scroll={{ x: 1200 }}
                  pagination={{
                    current: recommendPage,
                    pageSize: 50,
                    total: recommendTotal,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (page) => fetchRecommendations(page),
                  }}
                  columns={[
                    { title: '商家名称', dataIndex: 'merchant_name', key: 'name', width: 200 },
                    { title: 'MCID', dataIndex: 'mcid', key: 'mcid', width: 140, render: (v) => v || '-' },
                    { title: 'MID', dataIndex: 'merchant_mid', key: 'mid', width: 100, render: (v) => v || '-' },
                    { title: '地区', dataIndex: 'merchant_region', key: 'region', width: 120, render: (v) => v || '-' },
                    { title: 'EPC', dataIndex: 'epc', key: 'epc', width: 90, align: 'right',
                      render: (v) => v != null ? `$${Number(v).toFixed(2)}` : '-' },
                    { title: '平均佣金比例', dataIndex: 'avg_commission_rate', key: 'rate', width: 120, align: 'right',
                      render: (v) => v != null ? `${(Number(v) * 100).toFixed(2)}%` : '-' },
                    { title: '平均客单佣金', dataIndex: 'avg_order_commission', key: 'aoc', width: 120, align: 'right',
                      render: (v) => v != null ? `$${Number(v).toFixed(2)}` : '-' },
                    { title: '网址', dataIndex: 'merchant_url', key: 'url', width: 200, ellipsis: true,
                      render: (v) => v ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : '-' },
                    { title: '上传批次', dataIndex: 'upload_batch', key: 'batch', width: 200 },
                  ]}
                />
              </Card>
            ),
          }] : []),
        ].filter(Boolean)}
      />

      {/* OPT-009: 佣金拆分明细弹窗 */}
      <Modal
        title={`${commissionType === 'self_run' ? '自跑' : '分配'}佣金明细 — ${commissionMerchant?.merchant_name || ''}`}
        open={commissionModalOpen}
        onCancel={() => { setCommissionModalOpen(false); setCommissionData(null) }}
        footer={null}
        width={600}
        destroyOnHidden
      >
        {commissionLoading ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
        ) : commissionData ? (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={12}>
                <Statistic title="自跑佣金" value={commissionData.self_run_total || 0} prefix="$" precision={2} valueStyle={{ color: '#1890ff' }} />
              </Col>
              <Col span={12}>
                <Statistic title="分配佣金" value={commissionData.assigned_total || 0} prefix="$" precision={2} valueStyle={{ color: '#52c41a' }} />
              </Col>
            </Row>
            <Table
              rowKey="user_id"
              size="small"
              pagination={false}
              dataSource={commissionType === 'self_run' ? commissionData.self_run_details : commissionData.assigned_details}
              columns={[
                { title: '员工', dataIndex: 'display_name', key: 'name', render: (v, r) => v || r.username || '-' },
                ...(commissionType === 'assigned' ? [{
                  title: '分配时间', dataIndex: 'assigned_at', key: 'at',
                  render: (v) => v ? new Date(v).toLocaleDateString('zh-CN') : '-',
                }] : []),
                { title: '佣金', dataIndex: 'commission', key: 'commission', align: 'right', render: (v) => `$${(v || 0).toFixed(2)}` },
                { title: '订单数', dataIndex: 'order_count', key: 'orders', align: 'right' },
              ]}
              summary={(data) => {
                const totalComm = data.reduce((s, r) => s + (r.commission || 0), 0)
                const totalOrders = data.reduce((s, r) => s + (r.order_count || 0), 0)
                return (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}><strong>合计</strong></Table.Summary.Cell>
                    {commissionType === 'assigned' && <Table.Summary.Cell index={1} />}
                    <Table.Summary.Cell index={commissionType === 'assigned' ? 2 : 1} align="right"><strong>${totalComm.toFixed(2)}</strong></Table.Summary.Cell>
                    <Table.Summary.Cell index={commissionType === 'assigned' ? 3 : 2} align="right"><strong>{totalOrders}</strong></Table.Summary.Cell>
                  </Table.Summary.Row>
                )
              }}
            />
          </>
        ) : null}
      </Modal>

      {/* 在投人数详情弹窗 */}
      <Modal
        title={`在投人员 — ${advertiserMerchant?.merchant_name || ''}`}
        open={advertiserModalOpen}
        onCancel={() => { setAdvertiserModalOpen(false); setAdvertiserData([]) }}
        footer={null}
        width={700}
        destroyOnHidden
      >
        {advertiserLoading ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
        ) : (
          <Table
            rowKey="user_id"
            size="small"
            pagination={false}
            dataSource={advertiserData}
            columns={[
              { title: '员工', dataIndex: 'display_name', key: 'name', render: (v, r) => v || r.username },
              { title: '广告系列数', dataIndex: 'campaign_count', key: 'campaigns', align: 'center' },
              { title: '总花费', dataIndex: 'total_cost', key: 'cost', align: 'right', render: v => `$${(v || 0).toFixed(2)}` },
              { title: '总点击', dataIndex: 'total_clicks', key: 'clicks', align: 'right', render: v => (v || 0).toLocaleString() },
              { title: '总展示', dataIndex: 'total_impressions', key: 'impressions', align: 'right', render: v => (v || 0).toLocaleString() },
              {
                title: 'CTR', key: 'ctr', align: 'right',
                render: (_, r) => r.total_impressions > 0 ? `${(r.total_clicks / r.total_impressions * 100).toFixed(2)}%` : '-',
              },
              {
                title: 'CPC', key: 'cpc', align: 'right',
                render: (_, r) => r.total_clicks > 0 ? `$${(r.total_cost / r.total_clicks).toFixed(2)}` : '-',
              },
            ]}
            summary={(rows) => {
              const tc = rows.reduce((s, r) => s + (r.total_cost || 0), 0)
              const tk = rows.reduce((s, r) => s + (r.total_clicks || 0), 0)
              const ti = rows.reduce((s, r) => s + (r.total_impressions || 0), 0)
              return (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}><strong>合计</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="center"><strong>{rows.reduce((s, r) => s + (r.campaign_count || 0), 0)}</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right"><strong>${tc.toFixed(2)}</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right"><strong>{tk.toLocaleString()}</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right"><strong>{ti.toLocaleString()}</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right"><strong>{ti > 0 ? `${(tk / ti * 100).toFixed(2)}%` : '-'}</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right"><strong>{tk > 0 ? `$${(tc / tk).toFixed(2)}` : '-'}</strong></Table.Summary.Cell>
                </Table.Summary.Row>
              )
            }}
          />
        )}
      </Modal>

      <Modal
        title="编辑商家"
        open={editMerchantModalOpen}
        onOk={handleEditMerchantSubmit}
        onCancel={() => {
          setEditMerchantModalOpen(false)
          setCurrentMerchant(null)
        }}
        destroyOnHidden
      >
        <Form form={editMerchantForm} layout="vertical">
          <Form.Item
            name="merchant_id"
            label="MID"
            rules={[
              {
                pattern: /^\d*$/,
                message: 'MID 仅支持纯数字（留空表示待补）',
              },
            ]}
          >
            <Input placeholder="留空表示待补MID；填写时必须为纯数字" />
          </Form.Item>
          <Form.Item name="category" label="类别">
            <Input placeholder="例如 beauty / fashion" />
          </Form.Item>
          <Form.Item name="commission_rate" label="佣金比例">
            <Input placeholder="例如 8%" />
          </Form.Item>
          <Form.Item name="slug" label="Slug">
            <Input placeholder="可选" />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select>
              <Option value="active">active</Option>
              <Option value="inactive">inactive</Option>
            </Select>
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      {/* CR-048: 领取商家弹窗 — 选择国家+模式 */}
      <Modal
        title={`领取商家: ${claimRecord?.merchant_name || ''}`}
        open={claimModalOpen}
        onOk={selectedHoliday ? handleHolidayClaimConfirm : handleClaimConfirm}
        onCancel={() => { if (!claimLoading) setClaimModalOpen(false) }}
        okText="确认领取"
        cancelText="取消"
        confirmLoading={claimLoading}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>投放国家</div>
            <Select
              style={{ width: '100%' }}
              value={claimCountry}
              onChange={setClaimCountry}
              options={claimCountryOptions}
              showSearch
              filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </div>
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>投放模式</div>
            <Select
              style={{ width: '100%' }}
              value={claimMode}
              onChange={setClaimMode}
              options={[
                { value: 'test', label: '测试模式 — 小预算测试效果' },
                { value: 'normal', label: '正式模式 — 正式投放' },
              ]}
            />
          </div>
        </Space>
      </Modal>

      {/* 节日推荐商家弹窗 */}
      <Modal
        title={selectedHoliday
          ? <span><GiftOutlined style={{ color: '#eb2f96', marginRight: 8 }} />{selectedHoliday.name_zh || selectedHoliday.name} ({selectedHoliday.date})</span>
          : <span><GiftOutlined style={{ color: '#eb2f96', marginRight: 8 }} />节日列表 — {holidayCountry}</span>
        }
        open={holidayModalOpen}
        onCancel={() => { setHolidayModalOpen(false); setSelectedHoliday(null) }}
        footer={null}
        width={800}
        destroyOnClose
      >
        {!selectedHoliday ? (
          <div>
            <p style={{ color: '#666', marginBottom: 12 }}>点击节日查看推荐商家：</p>
            <Space wrap>
              {holidayList.map((h, i) => (
                <Tag
                  key={i}
                  color={h.type === 'commercial' ? 'magenta' : 'blue'}
                  style={{ cursor: 'pointer', fontSize: 13, padding: '4px 10px' }}
                  onClick={() => handleHolidayClick(h)}
                >
                  {h.date?.slice(5)} {h.name_zh || h.name}
                </Tag>
              ))}
            </Space>
          </div>
        ) : (
          <div>
            <Alert
              type="info"
              message={`以下商家适合「${selectedHoliday.name_zh || selectedHoliday.name}」节日促销，点击「领取创建」可直接进入广告创建（文案将自动贴合节日氛围）`}
              style={{ marginBottom: 12 }}
            />
            <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#666' }}>筛选平台:</span>
              <Select
                allowClear
                placeholder="全部平台"
                style={{ width: 140 }}
                size="small"
                value={holidayPlatformFilter}
                onChange={(v) => setHolidayPlatformFilter(v)}
              >
                {holidayPlatforms.map(p => (
                  <Option key={p} value={p}>
                    {p} ({(holidayMerchantsByPlatform[p] || []).length})
                  </Option>
                ))}
              </Select>
              <span style={{ fontSize: 12, color: '#999', marginLeft: 'auto' }}>
                共 {(holidayPlatformFilter ? (holidayMerchantsByPlatform[holidayPlatformFilter] || []) : holidayMerchants).length} 个商家
              </span>
            </div>
            <Table
              loading={holidayMerchantLoading}
              dataSource={holidayPlatformFilter ? (holidayMerchantsByPlatform[holidayPlatformFilter] || []) : holidayMerchants}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (t) => `共 ${t} 个` }}
              scroll={{ y: 400 }}
              locale={{ emptyText: holidayMerchantLoading ? '正在 AI 匹配中...' : '暂无匹配商家' }}
              columns={[
                { title: '商家名称', dataIndex: 'merchant_name', ellipsis: true },
                {
                  title: '平台', dataIndex: 'platform', width: 80,
                  render: (v) => <Tag color={PLATFORM_COLORS[v] || 'blue'}>{v}</Tag>,
                },
                {
                  title: '类别', dataIndex: 'category', width: 120,
                  render: (v) => <Tooltip title={v}>{translateCategory(v)}</Tooltip>,
                },
                {
                  title: '佣金率', dataIndex: 'commission_rate', width: 110,
                  sorter: (a, b) => {
                    const parse = (s) => { if (!s) return 0; const m = String(s).match(/([\d.]+)/); return m ? parseFloat(m[1]) : 0 }
                    return parse(a.commission_rate) - parse(b.commission_rate)
                  },
                  defaultSortOrder: 'descend',
                  render: (v) => v || '-',
                },
                {
                  title: '操作', width: 100, fixed: 'right',
                  render: (_, record) => (
                    <Button
                      type="primary"
                      size="small"
                      icon={<ThunderboltOutlined />}
                      onClick={() => handleHolidayClaim(record)}
                    >
                      领取创建
                    </Button>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Modal>

      {/* 广告默认设置 Modal */}
      <Modal
        title="广告创建默认设置"
        open={adDefaultsModalOpen}
        onOk={saveAdDefaults}
        onCancel={() => setAdDefaultsModalOpen(false)}
        okText="保存"
        cancelText="取消"
        width={520}
      >
        <Form form={adDefaultsForm} layout="vertical" initialValues={adDefaults}>
          <Form.Item name="bidding_strategy" label="出价策略">
            <Select options={[
              { value: 'MANUAL_CPC', label: '手动 CPC（Manual CPC）' },
              { value: 'MAXIMIZE_CLICKS', label: '尽可能多获得点击（Maximize Clicks）' },
            ]} />
          </Form.Item>
          <Form.Item name="enhanced_cpc" label="智能点击付费（eCPC）"
            extra="启用后 Google 会自动调整出价以提高转化率"
          >
            <Select options={[
              { value: false, label: '关闭' },
              { value: true, label: '开启' },
            ]} />
          </Form.Item>
          <Form.Item name="default_cpc_bid" label="默认 CPC 出价 (USD)">
            <InputNumber min={0.01} max={100} step={0.1} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="default_daily_budget" label="默认日预算 (USD)">
            <InputNumber min={1} max={10000} step={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Alert
            type="info"
            message="网络投放设置"
            description="以下设置决定广告在哪些 Google 网络上展示"
            style={{ marginBottom: 12, fontSize: 12 }}
          />
          <Form.Item name="target_google_search" label="Google 搜索"
            extra="在 Google 搜索结果中展示广告"
          >
            <Select options={[{ value: true, label: '开启' }, { value: false, label: '关闭' }]} />
          </Form.Item>
          <Form.Item name="target_search_network" label="搜索合作伙伴网络"
            extra="在 Google 搜索合作伙伴网站上展示广告"
          >
            <Select options={[{ value: true, label: '开启' }, { value: false, label: '关闭' }]} />
          </Form.Item>
          <Form.Item name="target_content_network" label="展示广告网络"
            extra="在 Google 展示广告网络上展示广告（通常不建议搜索广告开启）"
          >
            <Select options={[{ value: true, label: '开启' }, { value: false, label: '关闭' }]} />
          </Form.Item>
          <Alert
            type="info"
            message="地理位置与政策设置"
            style={{ marginBottom: 12, fontSize: 12 }}
          />
          <Form.Item name="geo_target_type" label="地理位置定位方式"
            extra="「所在地」仅定位实际位于目标地区的用户；「所在地或兴趣」还包含对目标地区感兴趣的用户"
          >
            <Select options={[
              { value: 'PRESENCE', label: '所在地（Presence）' },
              { value: 'PRESENCE_OR_INTEREST', label: '所在地或兴趣（Presence or Interest）' },
            ]} />
          </Form.Item>
          <Form.Item name="eu_political_ads" label="欧盟政治广告">
            <Select options={[
              { value: false, label: '不投放' },
              { value: true, label: '投放' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>
      {/* 在投人数详情弹窗 */}
      <Modal
        title={activeAdvMerchant ? `在投详情 — ${activeAdvMerchant.merchant_name}` : '在投详情'}
        open={activeAdvModalOpen}
        onCancel={() => setActiveAdvModalOpen(false)}
        footer={null}
        width={700}
      >
        <Spin spinning={activeAdvLoading}>
          {activeAdvList.length === 0 && !activeAdvLoading ? (
            <Alert message="当前无员工在投该商家" type="info" />
          ) : (
            <Table
              dataSource={activeAdvList}
              rowKey="user_id"
              size="small"
              pagination={false}
              columns={[
                { title: '员工', dataIndex: 'display_name', width: 100, render: (v, r) => v || r.username },
                { title: '广告系列数', dataIndex: 'campaign_count', width: 100, align: 'center' },
                { title: '总花费', dataIndex: 'total_cost', width: 120, align: 'right', render: v => `$${(v || 0).toFixed(2)}` },
                { title: '点击', dataIndex: 'total_clicks', width: 90, align: 'right', render: v => (v || 0).toLocaleString() },
                { title: '展示', dataIndex: 'total_impressions', width: 100, align: 'right', render: v => (v || 0).toLocaleString() },
              ]}
            />
          )}
        </Spin>
      </Modal>
    </div>
  )
}

export default MerchantManagement
