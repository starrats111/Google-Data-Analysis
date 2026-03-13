import React, { useEffect, useMemo, useState, useCallback } from 'react'
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
  Popconfirm,
  InputNumber,
  Statistic,
  Row,
  Col,
  Tooltip,
  Badge,
  DatePicker,
  Spin,
  Upload,
  Alert,
  Popover,
} from 'antd'
import { ReloadOutlined, SearchOutlined, UserSwitchOutlined, SyncOutlined, CheckCircleOutlined, CloudSyncOutlined, UploadOutlined, WarningOutlined, InboxOutlined, ThunderboltOutlined, SettingOutlined } from '@ant-design/icons'
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
const { RangePicker } = DatePicker

const statusColorMap = {
  active: 'green',
  inactive: 'default',
  completed: 'blue',
  cancelled: 'red',
}

const priorityColorMap = {
  high: 'red',
  normal: 'blue',
  low: 'default',
}

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

  const [assignments, setAssignments] = useState([])
  const [assignmentTotal, setAssignmentTotal] = useState(0)
  const [assignmentPage, setAssignmentPage] = useState(1)
  const [assignmentPageSize, setAssignmentPageSize] = useState(20)

  const [stats, setStats] = useState({
    total: 0,
    assigned: 0,
    unassigned: 0,
    missing_mid_total: 0,
    discovery_rate: 100,
    missing_mid_rate: 0,
    by_platform: {},
    missing_mid_by_platform: {},
  })
  const [platformOptions, setPlatformOptions] = useState([])
  const [userOptions, setUserOptions] = useState([])

  const [merchantFilters, setMerchantFilters] = useState({
    platform: undefined,
    category: undefined,
    status: undefined,
    assigned: undefined,
    missing_mid: undefined,
    relationship_status: undefined,
    search: '',
  })
  const [assignmentFilters, setAssignmentFilters] = useState({
    user_id: undefined,
    status: undefined,
  })

  const [selectedMerchantIds, setSelectedMerchantIds] = useState([])
  const [selectedAssignmentIds, setSelectedAssignmentIds] = useState([])

  const [assignModalOpen, setAssignModalOpen] = useState(false)
  const [transferModalOpen, setTransferModalOpen] = useState(false)
  const [editMerchantModalOpen, setEditMerchantModalOpen] = useState(false)
  const [editAssignmentModalOpen, setEditAssignmentModalOpen] = useState(false)
  const [commissionModalOpen, setCommissionModalOpen] = useState(false)
  const [commissionData, setCommissionData] = useState(null)
  const [commissionMerchant, setCommissionMerchant] = useState(null)
  const [commissionType, setCommissionType] = useState('self_run')
  const [commissionLoading, setCommissionLoading] = useState(false)

  const [currentMerchant, setCurrentMerchant] = useState(null)
  const [currentAssignment, setCurrentAssignment] = useState(null)

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

  // 分配弹窗 - 商家详情
  const [campaignDetails, setCampaignDetails] = useState([])
  const [campaignDetailsLoading, setCampaignDetailsLoading] = useState(false)

  const [assignForm] = Form.useForm()
  const [transferForm] = Form.useForm()
  const [editMerchantForm] = Form.useForm()
  const [editAssignmentForm] = Form.useForm()

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

  const missingMidTags = useMemo(() => {
    const entries = Object.entries(stats.missing_mid_by_platform || {})
    if (!entries.length) return <Tag>暂无</Tag>
    return entries
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => (
        <Tag key={k} color="orange" style={{ cursor: 'default' }}>
          {k} <Badge count={v} style={{ backgroundColor: '#fa8c16', marginLeft: 4, boxShadow: 'none' }} overflowCount={99999} />
        </Tag>
      ))
  }, [stats.missing_mid_by_platform])

  useEffect(() => {
    fetchUsers()
    fetchStats()
    fetchMerchants(1, merchantPageSize)
    loadAdDefaults()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tabKey === 'assignments') {
      fetchAssignments(1, assignmentPageSize)
    } else if (tabKey === 'missing_mid') {
      setMerchantFilters((s) => ({ ...s, missing_mid: true }))
      setTimeout(() => fetchMerchants(1, merchantPageSize), 0)
    } else if (tabKey === 'violations') {
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
      const resp = await api.get('/api/merchants/stats')
      setStats(resp.data || {
        total: 0,
        assigned: 0,
        unassigned: 0,
        missing_mid_total: 0,
        discovery_rate: 100,
        missing_mid_rate: 0,
        by_platform: {},
        missing_mid_by_platform: {},
      })
      setPlatformOptions(Object.keys(resp.data?.by_platform || {}))
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
      if (merchantFilters.category) params.category = merchantFilters.category
      if (merchantFilters.status) params.status = merchantFilters.status
      if (merchantFilters.assigned !== undefined) params.assigned = merchantFilters.assigned
      if (merchantFilters.missing_mid !== undefined) params.missing_mid = merchantFilters.missing_mid
      if (merchantFilters.relationship_status) params.relationship_status = merchantFilters.relationship_status
      if (merchantFilters.search) params.search = merchantFilters.search

      const resp = await api.get('/api/merchants', { params })
      const data = resp.data || {}
      setMerchants(data.items || [])
      setMerchantTotal(data.total || 0)
      setMerchantPage(page)
      setMerchantPageSize(pageSize)
      setSelectedMerchantIds([])
    } catch (error) {
      message.error(error.response?.data?.detail || '获取商家列表失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchAssignments = async (page = assignmentPage, pageSize = assignmentPageSize) => {
    setLoading(true)
    try {
      const params = {
        page,
        page_size: pageSize,
      }
      if (assignmentFilters.user_id) params.user_id = assignmentFilters.user_id
      if (assignmentFilters.status) params.status = assignmentFilters.status

      const resp = await api.get('/api/merchant-assignments', { params })
      const data = resp.data || {}
      setAssignments(data.items || [])
      setAssignmentTotal(data.total || 0)
      setAssignmentPage(page)
      setAssignmentPageSize(pageSize)
      setSelectedAssignmentIds([])
    } catch (error) {
      message.error(error.response?.data?.detail || '获取分配记录失败')
    } finally {
      setLoading(false)
    }
  }

  const [discoverLoading, setDiscoverLoading] = useState(false)

  const handleDiscover = async () => {
    setDiscoverLoading(true)
    try {
      const resp = await api.post('/api/merchants/discover')
      message.success(resp.data?.message || '商家同步完成')
      await Promise.all([fetchStats(), fetchMerchants(1, merchantPageSize)])
    } catch (error) {
      message.error(error.response?.data?.detail || '商家同步失败')
    } finally {
      setDiscoverLoading(false)
    }
  }

  const handleMidRepair = async () => {
    setMidRepairLoading(true)
    try {
      const resp = await api.post('/api/merchants/repair-all-mid')
      message.info(resp.data?.message || 'MID补齐已在后台启动')
      setTimeout(async () => {
        setMidRepairLoading(false)
        await Promise.all([fetchStats(), fetchMerchants(1, merchantPageSize)])
      }, 10000)
    } catch (error) {
      message.error(error.response?.data?.detail || 'MID补齐失败')
      setMidRepairLoading(false)
    }
  }

  const handlePlatformSync = async () => {
    setPlatformSyncLoading(true)
    try {
      const resp = await api.post('/api/merchants/sync-platforms')
      const d = resp.data || {}
      if (d.status === 'started') {
        message.info(d.message || '同步已在后台启动，请稍后刷新查看结果')
        setTimeout(async () => {
          setPlatformSyncLoading(false)
          await Promise.all([fetchStats(), fetchMerchants(1, merchantPageSize)])
        }, 5000)
        return
      }
      message.success(`平台同步完成：同步 ${d.synced_accounts || 0}/${d.total_accounts || 0} 账号，新增 ${d.new_merchants || 0} 商家，状态变更 ${d.status_changes || 0}`)
      await Promise.all([fetchStats(), fetchMerchants(1, merchantPageSize)])
    } catch (error) {
      message.error(error.response?.data?.detail || '平台同步失败')
    } finally {
      setPlatformSyncLoading(false)
    }
  }

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

  const handleAssignSubmit = async () => {
    try {
      const values = await assignForm.validateFields()
      if (!selectedMerchantIds.length) {
        message.warning('请先选择商家')
        return
      }
      await api.post('/api/merchant-assignments', {
        merchant_ids: selectedMerchantIds,
        user_id: values.user_id,
        priority: values.priority || 'normal',
        monthly_target: values.monthly_target,
        notes: values.notes,
      })
      message.success('分配成功')
      setAssignModalOpen(false)
      assignForm.resetFields()
      setCampaignDetails([])
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(1, assignmentPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '分配失败')
    }
  }

  const handleTransferSubmit = async () => {
    try {
      const values = await transferForm.validateFields()
      if (!selectedAssignmentIds.length) {
        message.warning('请先选择分配记录')
        return
      }
      await api.post('/api/merchant-assignments/transfer', {
        assignment_ids: selectedAssignmentIds,
        new_user_id: values.new_user_id,
      })
      message.success('转移成功')
      setTransferModalOpen(false)
      transferForm.resetFields()
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(assignmentPage, assignmentPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '转移失败')
    }
  }

  const handleCancelAssignment = async (assignmentId) => {
    try {
      await api.delete(`/api/merchant-assignments/${assignmentId}`)
      message.success('已取消分配')
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(assignmentPage, assignmentPageSize)])
    } catch (error) {
      message.error(error.response?.data?.detail || '取消分配失败')
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

  const openEditAssignmentModal = (assignment) => {
    setCurrentAssignment(assignment)
    editAssignmentForm.setFieldsValue({
      priority: assignment.priority,
      monthly_target: assignment.monthly_target,
      status: assignment.status,
      notes: assignment.notes,
    })
    setEditAssignmentModalOpen(true)
  }

  const handleEditAssignmentSubmit = async () => {
    try {
      const values = await editAssignmentForm.validateFields()
      await api.put(`/api/merchant-assignments/${currentAssignment.id}`, values)
      message.success('分配更新成功')
      setEditAssignmentModalOpen(false)
      setCurrentAssignment(null)
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(assignmentPage, assignmentPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '分配更新失败')
    }
  }

  const merchantColumns = [
    {
      title: '商家名称',
      dataIndex: 'merchant_name',
      key: 'merchant_name',
      width: 200,
      fixed: 'left',
      render: (text, record) => (
        <span style={{ fontWeight: 600 }}>
          {text || '-'}
          {record.violation_status === 'violated' && (
            <Tag color="red" style={{ marginLeft: 6, fontSize: 11 }}>违规</Tag>
          )}
          {record.recommendation_status === 'recommended' && (
            <Tag color="green" style={{ marginLeft: 6, fontSize: 11 }}>推荐</Tag>
          )}
        </span>
      ),
    },
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 90,
      render: (val) => <Tag color={PLATFORM_COLORS[val] || 'blue'}>{val || '-'}</Tag>,
    },
    {
      title: 'MID',
      dataIndex: 'merchant_id',
      key: 'merchant_id',
      width: 120,
      render: (val, record) => (
        editingMidId === record.id ? (
          <Space size={4}>
            <Input
              size="small"
              style={{ width: 100 }}
              value={editingMidValue}
              onChange={(e) => setEditingMidValue(e.target.value)}
              onPressEnter={() => handleInlineMidSave(record.id)}
              placeholder="输入MID"
            />
            <Button type="link" size="small" loading={midSaving} onClick={() => handleInlineMidSave(record.id)}>
              <CheckCircleOutlined />
            </Button>
            <Button type="link" size="small" onClick={() => { setEditingMidId(null); setEditingMidValue('') }}>
              取消
            </Button>
          </Space>
        ) : (
          <Space size={4}>
            <span style={{ color: val ? undefined : '#faad14', fontSize: 12 }}>{val || '待补'}</span>
            {record.missing_mid && isManager && (
              <Button
                type="link"
                size="small"
                style={{ padding: 0, fontSize: 12 }}
                onClick={() => { setEditingMidId(record.id); setEditingMidValue(record.merchant_id || '') }}
              >
                补录
              </Button>
            )}
          </Space>
        )
      ),
    },
    {
      title: '申请状态',
      dataIndex: 'relationship_status',
      key: 'relationship_status',
      width: 90,
      render: (val) => {
        const cfg = relationshipStatusMap[val] || relationshipStatusMap.unknown
        return <Tag color={cfg.color}>{cfg.label}</Tag>
      },
    },
    {
      title: '类别',
      dataIndex: 'category',
      key: 'category',
      width: 100,
      render: (val) => <Tooltip title={val}>{translateCategory(val)}</Tooltip>,
    },
    {
      title: '佣金率',
      dataIndex: 'commission_rate',
      key: 'commission_rate',
      width: 100,
      render: (val) => val || '-',
    },
    {
      title: '在投人数',
      dataIndex: 'active_advertiser_count',
      key: 'in_tou_count',
      width: 100,
      align: 'center',
      sorter: (a, b) => (a.active_advertiser_count || 0) - (b.active_advertiser_count || 0),
      render: (count) => {
        const n = count || 0
        if (n === 0) return <Tag>0</Tag>
        return <Tag color="blue">{n}</Tag>
      },
    },
    {
      title: '订单',
      dataIndex: 'orders_30d',
      key: 'orders_30d',
      width: 80,
      align: 'right',
      sorter: (a, b) => (a.orders_30d || 0) - (b.orders_30d || 0),
      render: (val) => (val || 0).toLocaleString(),
    },
    {
      title: '佣金',
      dataIndex: 'commission_30d',
      key: 'commission_30d',
      width: 110,
      align: 'right',
      sorter: (a, b) => (a.commission_30d || 0) - (b.commission_30d || 0),
      render: (val, record) => (
        <a style={{ color: '#1890ff' }} onClick={() => handleCommissionClick(record, 'self_run')}>
          ${(val || 0).toFixed(2)}
        </a>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: canManage ? 180 : 80,
      fixed: 'right',
      render: (_, record) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            style={{ padding: '0 4px', color: '#722ed1' }}
            onClick={() => openClaimModal(record)}
          >
            领取
          </Button>
          {canManage && (
            <>
              <Button size="small" onClick={() => openEditMerchantModal(record)}>
                编辑
              </Button>
              {record.recommendation_status !== 'recommended' ? (
                <Button
                  size="small"
                  type="link"
                  style={{ color: '#52c41a', padding: '0 4px' }}
                  onClick={() => handleToggleTag(record, 'recommendation_status', 'recommended')}
                >
                  推荐
                </Button>
              ) : (
                <Button
                  size="small"
                  type="link"
                  style={{ color: '#999', padding: '0 4px' }}
                  onClick={() => handleToggleTag(record, 'recommendation_status', 'normal')}
                >
                  取消推荐
                </Button>
              )}
              {record.violation_status !== 'violated' ? (
                <Button
                  size="small"
                  type="link"
                  danger
                  style={{ padding: '0 4px' }}
                  onClick={() => handleToggleTag(record, 'violation_status', 'violated')}
                >
                  违规
                </Button>
              ) : (
                <Button
                  size="small"
                  type="link"
                  style={{ color: '#999', padding: '0 4px' }}
                  onClick={() => handleToggleTag(record, 'violation_status', 'normal')}
                >
                  取消违规
                </Button>
              )}
            </>
          )}
        </Space>
      ),
    },
  ]

  // CR-048: 领取商家 — 先弹窗选择国家+模式
  const [claimModalOpen, setClaimModalOpen] = useState(false)
  const [claimRecord, setClaimRecord] = useState(null)
  const [claimCountry, setClaimCountry] = useState('US')
  const [claimMode, setClaimMode] = useState('test')
  const [claimLoading, setClaimLoading] = useState(false)

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

  const CLAIM_COUNTRIES = [
    { value: 'US', label: '美国 (English)' },
    { value: 'UK', label: '英国 (English)' },
    { value: 'CA', label: '加拿大 (English)' },
    { value: 'AU', label: '澳大利亚 (English)' },
    { value: 'DE', label: '德国 (German)' },
    { value: 'FR', label: '法国 (French)' },
    { value: 'JP', label: '日本 (Japanese)' },
    { value: 'BR', label: '巴西 (Portuguese)' },
  ]

  const loadAdDefaults = async () => {
    try {
      const res = await api.get('/api/merchants/ad-defaults')
      setAdDefaults(res.data)
      adDefaultsForm.setFieldsValue(res.data)
    } catch {}
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
    setClaimCountry('US')
    setClaimMode('test')
    setClaimModalOpen(true)
  }

  const handleClaimConfirm = async () => {
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
        fetchMerchants(merchantPage, merchantPageSize)
        fetchAssignments(assignmentPage, assignmentPageSize)
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
        message.info(res.data?.message || '该商家你已经领取过了')
        setClaimModalOpen(false)
      }
    } catch (err) {
      console.error('Claim error:', err)
      const detail = err?.response?.data?.detail || err?.message || '未知错误'
      message.error(`领取失败: ${detail}`)
    } finally {
      setClaimLoading(false)
    }
  }

  const assignmentColumns = [
    {
      title: '商家',
      key: 'merchant',
      width: 220,
      fixed: 'left',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{record.merchant?.merchant_name || '-'}</span>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>
            {record.merchant?.platform || '-'} / {record.merchant?.merchant_id || '-'}
          </span>
        </Space>
      ),
    },
    canManage && {
      title: '负责人',
      key: 'owner',
      width: 140,
      render: (_, record) => record.display_name || record.username || '-',
    },
    {
      title: '分配人',
      dataIndex: 'assigned_by_name',
      key: 'assigned_by_name',
      width: 120,
      render: (val) => val || '-',
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (val) => <Tag color={priorityColorMap[val] || 'default'}>{val || '-'}</Tag>,
    },
    {
      title: '月目标佣金',
      dataIndex: 'monthly_target',
      key: 'monthly_target',
      width: 140,
      align: 'right',
      render: (val) => (val ? `$${Number(val).toFixed(2)}` : '-'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (val) => <Tag color={statusColorMap[val] || 'default'}>{val || '-'}</Tag>,
    },
    {
      title: '分配时间',
      dataIndex: 'assigned_at',
      key: 'assigned_at',
      width: 180,
      render: (val) => (val ? new Date(val).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '备注',
      dataIndex: 'notes',
      key: 'notes',
      width: 180,
      render: (val) => val || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: canManage ? 250 : 120,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          {!record.google_campaign_id && (
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                const params = new URLSearchParams({
                  assignment_id: record.id,
                  merchant_name: record.merchant?.merchant_name || '',
                })
                navigate(`/ads/create?${params.toString()}`)
              }}
            >
              创建广告
            </Button>
          )}
          {record.google_campaign_id && (
            <Tag color="green">已创建</Tag>
          )}
          {canManage && (
            <>
              <Button size="small" onClick={() => openEditAssignmentModal(record)}>
                编辑
              </Button>
              <Popconfirm
                title="确认取消该分配吗？"
                onConfirm={() => handleCancelAssignment(record.id)}
                okText="确认"
                cancelText="取消"
              >
                <Button size="small" danger>
                  取消
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ].filter(Boolean)

  const merchantRowSelection = canManage
    ? {
        selectedRowKeys: selectedMerchantIds,
        onChange: (keys) => setSelectedMerchantIds(keys),
      }
    : undefined

  const assignmentRowSelection = canManage
    ? {
        selectedRowKeys: selectedAssignmentIds,
        onChange: (keys) => setSelectedAssignmentIds(keys),
      }
    : undefined

  // 员工视角的简化统计
  const myAssignmentStats = useMemo(() => {
    const activeCount = assignments.filter(a => a.status === 'active').length
    return { activeCount }
  }, [assignments])

  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 16 }}>
          {/* 左侧：商家概览统计 */}
          <Col xs={24} md={6}>
            <Card size="small" style={{ height: '100%' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Statistic title="商家总数" value={stats.total || 0} valueStyle={{ fontSize: 20 }} />
                <div style={{ display: 'flex', gap: 16 }}>
                  <Statistic title="已分配" value={stats.assigned || 0} valueStyle={{ fontSize: 16, color: '#1677ff' }} />
                  <Statistic title="待补MID" value={stats.missing_mid_total || 0} valueStyle={{ fontSize: 16, color: '#d46b08' }} />
                </div>
                <div>
                  <span style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>平台分布</span>
                  <Space wrap size={4}>{platformTags}</Space>
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

          {/* 绿框：测试广告数量 */}
          <Col xs={24} md={4}>
            <Card size="small" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Statistic
                title="测试广告"
                value={stats.test_campaign_count || 0}
                suffix="个"
                valueStyle={{ fontSize: 24, color: '#52c41a' }}
              />
            </Card>
          </Col>

          {/* 蓝框：待定 */}
          <Col xs={24} md={4}>
            <Card size="small" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center', color: '#bfbfbf' }}>
                <span style={{ fontSize: 12 }}>更多功能</span>
                <br />
                <span style={{ fontSize: 11 }}>待定</span>
              </div>
            </Card>
          </Col>
        </Row>

      <Tabs
        activeKey={tabKey}
        onChange={setTabKey}
        items={[
          {
            key: 'merchants',
            label: '商家目录',
            children: (
              <Card
                title="商家目录"
                extra={
                  <Space>
                    <Tooltip title="重新加载数据">
                      <Button icon={<ReloadOutlined />} onClick={() => fetchMerchants(merchantPage, merchantPageSize)} />
                    </Tooltip>
                    <Button icon={<SyncOutlined />} loading={discoverLoading} onClick={handleDiscover}>交易同步</Button>
                    <Button loading={midRepairLoading} onClick={handleMidRepair}>补齐MID</Button>
                    {isManager && (
                      <Button icon={<CloudSyncOutlined />} loading={platformSyncLoading} onClick={handlePlatformSync}>平台同步</Button>
                    )}
                    {canManage && (
                      <Button
                        type="primary"
                        icon={<UserSwitchOutlined />}
                        disabled={!selectedMerchantIds.length}
                        onClick={() => {
                          setAssignModalOpen(true)
                          assignForm.setFieldsValue({ priority: 'normal' })
                        }}
                      >
                        分配给员工
                      </Button>
                    )}
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
                    placeholder="搜索商家名/MID/slug"
                    style={{ width: 240 }}
                    value={merchantFilters.search}
                    prefix={<SearchOutlined />}
                    onChange={(e) => setMerchantFilters((s) => ({ ...s, search: e.target.value }))}
                    onPressEnter={() => fetchMerchants(1, merchantPageSize)}
                  />

                  <Select
                    allowClear
                    placeholder="状态"
                    style={{ width: 120 }}
                    value={merchantFilters.status}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, status: v }))}
                  >
                    <Option value="active">active</Option>
                    <Option value="inactive">inactive</Option>
                  </Select>

                  <Select
                    allowClear
                    placeholder="分配状态"
                    style={{ width: 140 }}
                    value={merchantFilters.assigned}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, assigned: v }))}
                  >
                    <Option value={true}>已分配</Option>
                    <Option value={false}>未分配</Option>
                  </Select>

                  <Select
                    allowClear
                    placeholder="MID状态"
                    style={{ width: 120 }}
                    value={merchantFilters.missing_mid}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, missing_mid: v }))}
                  >
                    <Option value={true}>待补MID</Option>
                    <Option value={false}>MID完整</Option>
                  </Select>

                  <Select
                    allowClear
                    placeholder="申请状态"
                    style={{ width: 120 }}
                    value={merchantFilters.relationship_status}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, relationship_status: v }))}
                  >
                    <Option value="joined">通过</Option>
                    <Option value="pending">审核中</Option>
                    <Option value="rejected">已拒绝</Option>
                  </Select>

                  <Button type="primary" onClick={() => fetchMerchants(1, merchantPageSize)}>查询</Button>
                  <Button
                    onClick={() => {
                      setMerchantFilters({
                        platform: undefined,
                        category: undefined,
                        status: undefined,
                        assigned: undefined,
                        missing_mid: undefined,
                        relationship_status: undefined,
                        search: '',
                      })
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
                  rowSelection={merchantRowSelection}
                  scroll={{ x: 1600 }}
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
          {
            key: 'assignments',
            label: '分配记录',
            children: (
              <Card
                title="分配记录"
                extra={
                  <Space>
                    <Button icon={<ReloadOutlined />} onClick={() => fetchAssignments(assignmentPage, assignmentPageSize)} />
                    {isManager && (
                      <Button
                        type="primary"
                        disabled={!selectedAssignmentIds.length}
                        onClick={() => setTransferModalOpen(true)}
                      >
                        批量转移
                      </Button>
                    )}
                  </Space>
                }
              >
                <Space wrap style={{ marginBottom: 12 }}>
                  {canManage && (
                    <Select
                      allowClear
                      placeholder="负责人"
                      style={{ width: 180 }}
                      value={assignmentFilters.user_id}
                      onChange={(v) => setAssignmentFilters((s) => ({ ...s, user_id: v }))}
                    >
                      {userOptions.map((u) => (
                        <Option key={u.id} value={u.id}>
                          {u.display_name || u.username}
                        </Option>
                      ))}
                    </Select>
                  )}

                  <Select
                    allowClear
                    placeholder="状态"
                    style={{ width: 140 }}
                    value={assignmentFilters.status}
                    onChange={(v) => setAssignmentFilters((s) => ({ ...s, status: v }))}
                  >
                    <Option value="active">active</Option>
                    <Option value="completed">completed</Option>
                    <Option value="cancelled">cancelled</Option>
                  </Select>

                  <Button type="primary" onClick={() => fetchAssignments(1, assignmentPageSize)}>查询</Button>
                  <Button
                    onClick={() => {
                      setAssignmentFilters({ user_id: undefined, status: undefined })
                      setTimeout(() => fetchAssignments(1, assignmentPageSize), 0)
                    }}
                  >
                    重置
                  </Button>
                </Space>

                <Table
                  rowKey="id"
                  loading={loading && tabKey === 'assignments'}
                  columns={assignmentColumns}
                  dataSource={assignments}
                  rowSelection={canManage ? assignmentRowSelection : undefined}
                  scroll={{ x: canManage ? 1400 : 1000 }}
                  pagination={{
                    current: assignmentPage,
                    pageSize: assignmentPageSize,
                    total: assignmentTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (page, size) => fetchAssignments(page, size),
                  }}
                />
              </Card>
            ),
          },
          {
            key: 'missing_mid',
            label: '待补MID',
            children: (
              <Card
                title="待补 MID 商家"
                extra={
                  <Button icon={<ReloadOutlined />} onClick={() => {
                    setMerchantFilters((s) => ({ ...s, missing_mid: true }))
                    setTimeout(() => fetchMerchants(1, merchantPageSize), 0)
                  }}>
                    刷新
                  </Button>
                }
              >
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={merchants.filter((m) => m.missing_mid)}
                  scroll={{ x: 1000 }}
                  pagination={false}
                  columns={[
                    {
                      title: '平台', dataIndex: 'platform', key: 'platform', width: 80,
                      render: (val) => <Tag color={PLATFORM_COLORS[val] || 'blue'}>{val}</Tag>,
                    },
                    { title: '商家名', dataIndex: 'merchant_name', key: 'merchant_name', width: 200 },
                    { title: 'Slug', dataIndex: 'slug', key: 'slug', width: 200, render: (v) => v || '-' },
                    {
                      title: '申请状态', dataIndex: 'relationship_status', key: 'rs', width: 90,
                      render: (val) => {
                        const cfg = relationshipStatusMap[val] || relationshipStatusMap.unknown
                        return <Tag color={cfg.color}>{cfg.label}</Tag>
                      },
                    },
                    {
                      title: '操作', key: 'action', width: 220,
                      render: (_, record) => {
                        if (editingMidId === record.id) {
                          return (
                            <Space>
                              <Input
                                size="small"
                                style={{ width: 120 }}
                                value={editingMidValue}
                                onChange={(e) => setEditingMidValue(e.target.value)}
                                onPressEnter={() => handleInlineMidSave(record.id)}
                                placeholder="输入MID"
                              />
                              <Button type="primary" size="small" loading={midSaving} onClick={() => handleInlineMidSave(record.id)}>确认</Button>
                              <Button size="small" onClick={() => { setEditingMidId(null); setEditingMidValue('') }}>取消</Button>
                            </Space>
                          )
                        }
                        return isManager ? (
                          <Button size="small" onClick={() => { setEditingMidId(record.id); setEditingMidValue('') }}>填写 MID</Button>
                        ) : <span style={{ color: '#aaa' }}>—</span>
                      },
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
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
          },
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

      <Modal
        title={`批量分配商家（${selectedMerchantIds.length}个）`}
        open={assignModalOpen}
        onOk={handleAssignSubmit}
        onCancel={() => {
          setAssignModalOpen(false)
          assignForm.resetFields()
        }}
        destroyOnHidden
      >
        <Form form={assignForm} layout="vertical">
          <Form.Item name="user_id" label="分配给员工" rules={[{ required: true, message: '请选择员工' }]}> 
            <Select placeholder="选择员工" onChange={async (uid) => {
              if (!selectedMerchantIds.length || !uid) return
              setCampaignDetailsLoading(true)
              try {
                const details = await Promise.all(
                  selectedMerchantIds.slice(0, 10).map(mid =>
                    api.get(`/api/merchants/${mid}/campaign-detail`, { params: { user_id: uid } }).then(r => r.data).catch(() => null)
                  )
                )
                setCampaignDetails(details.filter(Boolean))
              } catch { setCampaignDetails([]) }
              finally { setCampaignDetailsLoading(false) }
            }}>
              {userOptions.map((u) => (
                <Option key={u.id} value={u.id}>{u.display_name || u.username}</Option>
              ))}
            </Select>
          </Form.Item>

          {campaignDetailsLoading && <Spin size="small" style={{ marginBottom: 12 }} />}
          {campaignDetails.length > 0 && (
            <div style={{ marginBottom: 16, maxHeight: 260, overflowY: 'auto' }}>
              {campaignDetails.map((d, idx) => (
                <Card key={idx} size="small" style={{ marginBottom: 8 }} bodyStyle={{ padding: '8px 12px' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    {d.merchant_name || '-'}
                    <Tag color={PLATFORM_COLORS[d.platform] || 'blue'} style={{ marginLeft: 6 }}>{d.platform}</Tag>
                    {d.cache_found && <Tag color="green" style={{ fontSize: 10 }}>缓存</Tag>}
                  </div>
                  {d.site_url && <div style={{ fontSize: 12, color: '#666' }}>网址: <a href={d.site_url} target="_blank" rel="noreferrer">{d.site_url}</a></div>}
                  {d.categories && <div style={{ fontSize: 12, color: '#666' }}>品类: {translateCategory(d.categories)}</div>}
                  {d.commission_rate && <div style={{ fontSize: 12, color: '#666' }}>佣金率: {d.commission_rate}</div>}
                  {d.support_regions?.length > 0 && (
                    <div style={{ fontSize: 12, color: '#666' }}>区域: {d.support_regions.map(r => r.code || r).join(', ')}</div>
                  )}
                  {d.recommendation && (
                    <div style={{ fontSize: 12, color: '#52c41a', marginTop: 4 }}>
                      推荐数据 — EPC: {d.recommendation.epc ?? '-'} | 佣金上限: {d.recommendation.commission_cap ?? '-'} | 平均佣金率: {d.recommendation.avg_commission_rate ? (d.recommendation.avg_commission_rate * 100).toFixed(2) + '%' : '-'}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}

          <Form.Item name="priority" label="优先级">
            <Select>
              <Option value="high">high</Option>
              <Option value="normal">normal</Option>
              <Option value="low">low</Option>
            </Select>
          </Form.Item>
          <Form.Item name="monthly_target" label="月度目标佣金($)">
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`批量转移分配（${selectedAssignmentIds.length}条）`}
        open={transferModalOpen}
        onOk={handleTransferSubmit}
        onCancel={() => {
          setTransferModalOpen(false)
          transferForm.resetFields()
        }}
        destroyOnHidden
      >
        <Form form={transferForm} layout="vertical">
          <Form.Item name="new_user_id" label="转移给员工" rules={[{ required: true, message: '请选择员工' }]}> 
            <Select placeholder="选择员工">
              {userOptions.map((u) => (
                <Option key={u.id} value={u.id}>{u.display_name || u.username}</Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
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

      <Modal
        title="编辑分配"
        open={editAssignmentModalOpen}
        onOk={handleEditAssignmentSubmit}
        onCancel={() => {
          setEditAssignmentModalOpen(false)
          setCurrentAssignment(null)
        }}
        destroyOnHidden
      >
        <Form form={editAssignmentForm} layout="vertical">
          <Form.Item name="priority" label="优先级">
            <Select>
              <Option value="high">high</Option>
              <Option value="normal">normal</Option>
              <Option value="low">low</Option>
            </Select>
          </Form.Item>
          <Form.Item name="monthly_target" label="月度目标佣金($)">
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select>
              <Option value="active">active</Option>
              <Option value="completed">completed</Option>
              <Option value="cancelled">cancelled</Option>
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
        onOk={handleClaimConfirm}
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
              options={CLAIM_COUNTRIES}
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
    </div>
  )
}

export default MerchantManagement
