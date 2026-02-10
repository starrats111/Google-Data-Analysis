import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { Card, Table, Select, DatePicker, Space, message, Tag, Badge, Typography, Tooltip, Button, Popconfirm, Collapse, Modal, Spin, Input, Alert } from 'antd'
import { RobotOutlined, SettingOutlined, CopyOutlined, ArrowLeftOutlined, CloseOutlined, DollarOutlined, ThunderboltOutlined, RocketOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import api from '../services/api'
import ExportButton from '../components/Export/ExportButton'
import ReportViewer from '../components/ReportViewer/ReportViewer'
import CpcDeployModal from '../components/CpcDeployModal'
import AiGeneratingOverlay from '../components/AiGeneratingOverlay'
import { useAuth } from '../store/authStore'
import './Analysis.css'

const { RangePicker } = DatePicker
const { Option } = Select
const { Title, Text } = Typography

// 缓存key生成函数
const getCacheKey = (accountId, dateRange) => {
  const dateStr = dateRange && dateRange.length === 2 
    ? `${dateRange[0].format('YYYY-MM-DD')}_${dateRange[1].format('YYYY-MM-DD')}`
    : 'all'
  return `analysis_cache_l7d_${accountId || 'all'}_${dateStr}`
}

// L7D 分析页面
const Analysis = () => {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  const isInitialMount = useRef(true)
  const lastFetchParams = useRef(null)

  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [dateRange, setDateRange] = useState(null)
  const [generatingFromApi, setGeneratingFromApi] = useState(false)
  
  // AI 分析状态
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiAnalysisResult, setAiAnalysisResult] = useState(null)
  const [selectedResultForAi, setSelectedResultForAi] = useState(null)
  
  // 提示词编辑状态
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [loadingPrompt, setLoadingPrompt] = useState(false)
  
  // 单条广告系列分析状态
  const [singleCampaignModalOpen, setSingleCampaignModalOpen] = useState(false)
  const [singleCampaignAnalyzing, setSingleCampaignAnalyzing] = useState(false)
  const [singleCampaignResult, setSingleCampaignResult] = useState(null)
  const [selectedCampaignRow, setSelectedCampaignRow] = useState(null)
  
  // 出价策略状态
  const [bidStrategies, setBidStrategies] = useState({})  // {campaign_id: strategy_info}
  const [changingToManual, setChangingToManual] = useState({})  // {campaign_id: loading}
  
  // CPC部署弹窗状态
  const [cpcDeployModalOpen, setCpcDeployModalOpen] = useState(false)

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/api/affiliate/accounts')
      setAccounts(response.data)
    } catch (error) {
      // 如果是请求被取消，不显示错误
      if (error.isCanceled || error.name === 'CanceledError' || error.name === 'AbortError') {
        return
      }
      console.error('获取账号列表失败', error)
    }
  }
  
  // 获取出价策略信息
  const fetchBidStrategies = async () => {
    try {
      const response = await api.get('/api/bids/strategies')
      const strategiesMap = {}
      for (const s of response.data || []) {
        strategiesMap[s.campaign_id] = s
      }
      setBidStrategies(strategiesMap)
    } catch (error) {
      console.error('获取出价策略失败', error)
    }
  }
  
  // 改为人工出价
  const handleChangeToManualCpc = async (row) => {
    const campaignId = row['campaign_id'] || row['广告系列ID']
    if (!campaignId) {
      message.warning('无法获取广告系列ID')
      return
    }
    
    const strategy = bidStrategies[campaignId]
    if (!strategy) {
      message.warning('请先同步出价数据')
      return
    }
    
    setChangingToManual({ ...changingToManual, [campaignId]: true })
    try {
      await api.post('/api/bids/change-to-manual', {
        mcc_id: strategy.mcc_id,
        customer_id: strategy.customer_id,
        campaign_id: campaignId
      })
      message.success('出价策略已切换为人工CPC')
      // 更新本地状态
      setBidStrategies({
        ...bidStrategies,
        [campaignId]: {
          ...strategy,
          is_manual_cpc: true,
          bidding_strategy_type: 'MANUAL_CPC',
          bidding_strategy_name: '每次点击费用人工出价'
        }
      })
    } catch (error) {
      console.error('切换失败:', error)
      message.error('切换失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setChangingToManual({ ...changingToManual, [campaignId]: false })
    }
  }


  const fetchResults = async (useCache = true) => {
    // 生成当前请求的参数key
    const paramsKey = JSON.stringify({
      account: selectedAccount,
      dateRange: dateRange ? [dateRange[0].format('YYYY-MM-DD'), dateRange[1].format('YYYY-MM-DD')] : null
    })

    // 如果参数没变化且不是初始挂载，跳过请求
    if (useCache && lastFetchParams.current === paramsKey && !isInitialMount.current) {
      return
    }

    // 检查缓存
    const cacheKey = getCacheKey(selectedAccount, dateRange)
    if (useCache) {
      try {
        const cached = sessionStorage.getItem(cacheKey)
        if (cached) {
          const { data, timestamp } = JSON.parse(cached)
          // 缓存有效期5分钟
          if (Date.now() - timestamp < 5 * 60 * 1000) {
            setResults(data)
            lastFetchParams.current = paramsKey
            return
          }
        }
      } catch (e) {
        // 缓存读取失败，继续请求
      }
    }

    setLoading(true)
    try {
      const params = {}
      if (selectedAccount) params.account_id = selectedAccount
      if (dateRange && dateRange.length === 2) {
        params.start_date = dateRange[0].format('YYYY-MM-DD')
        params.end_date = dateRange[1].format('YYYY-MM-DD')
      }

      const response = await api.get('/api/analysis/results', { params })
      const all = response.data || []
      
      // 调试日志（仅在开发环境输出，避免生产环境性能影响）
      if (process.env.NODE_ENV === 'development' && all.length > 0) {
        console.log(`[Analysis] 获取到 ${all.length} 条分析结果`)
      }
      
      // 保存到缓存
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({
          data: all,
          timestamp: Date.now()
        }))
      } catch (e) {
        // 缓存写入失败，忽略
      }

      setResults(all)
      lastFetchParams.current = paramsKey
    } catch (error) {
      // 如果是请求被取消，不显示错误提示
      if (error.isCanceled || error.name === 'CanceledError' || error.name === 'AbortError') {
        return
      }
      message.error('获取分析结果失败')
    } finally {
      setLoading(false)
      isInitialMount.current = false
    }
  }

  // 从API数据生成L7D分析
  const handleGenerateFromApi = async () => {
    setGeneratingFromApi(true)
    try {
      const endDate = dateRange && dateRange.length === 2 
        ? dateRange[1].format('YYYY-MM-DD')
        : null
      
      const params = {}
      if (endDate) {
        params.end_date = endDate
      }
      
      const response = await api.post('/api/analysis/l7d', null, { params })
      
      if (response.data.success) {
        message.success(`成功生成 ${response.data.total_records} 条L7D分析记录`)
        // 刷新数据
        fetchResults(false)
      } else {
        message.error(response.data.message || '生成失败')
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '生成失败')
    } finally {
      setGeneratingFromApi(false)
    }
  }

  // 生成 AI 分析报告
  const handleGenerateReport = async (record) => {
    const data = record?.result_data?.data
    if (!Array.isArray(data) || data.length === 0) {
      message.warning('该记录没有可分析的数据')
      return
    }
    
    setSelectedResultForAi(record)
    setAiAnalyzing(true)
    setAiModalOpen(true)
    setAiAnalysisResult(null)
    
    try {
      // 辅助函数：安全解析数字
      const safeFloat = (val) => {
        const num = parseFloat(val)
        return isNaN(num) ? 0 : num
      }
      const safeInt = (val) => {
        const num = parseInt(val)
        return isNaN(num) ? 0 : num
      }
      
      const campaigns = data.map(row => ({
        campaign_name: String(row['广告系列名'] || row['广告系列'] || row['系列名'] || ''),
        cost: safeFloat(row['L7D花费'] || row['费用'] || row['花费']),
        clicks: safeInt(row['L7D点击'] || row['点击']),
        impressions: safeInt(row['L7D展示'] || row['展示']),
        cpc: safeFloat(row['CPC'] || row['L7D_CPC']),
        budget: safeFloat(row['预算'] || row['日预算']),
        conservative_epc: safeFloat(row['保守EPC'] || row['L7D保守EPC']),
        is_budget_lost: safeFloat(row['Budget丢失'] || row['IS Budget丢失'] || row['预算丢失']),
        is_rank_lost: safeFloat(row['Rank丢失'] || row['IS Rank丢失'] || row['排名丢失']),
        orders: safeInt(row['L7D订单'] || row['订单'] || row['出单']),
        order_days: safeInt(row['L7D出单天数'] || row['出单天数']),
        commission: safeFloat(row['L7D佣金'] || row['佣金'])
      })).filter(c => c.campaign_name)
      
      if (campaigns.length === 0) {
        message.warning('没有找到有效的广告系列数据')
        setAiAnalyzing(false)
        return
      }
      
      // 生成报告并保存
      const response = await api.post('/api/gemini/generate-report', {
        campaigns,
        analysis_result_id: record.id,
        model_type: 'thinking'
      })
      
      if (response.data.success) {
        setAiAnalysisResult(response.data)
        message.success('报告生成成功！已保存到"我的报告"')
      } else {
        message.error(response.data.message || '报告生成失败')
      }
    } catch (error) {
      console.error('报告生成错误:', error)
      let errMsg = '报告生成失败'
      if (error.response?.data?.detail) {
        const detail = error.response.data.detail
        errMsg = typeof detail === 'string' ? detail : JSON.stringify(detail)
      } else if (error.response?.data?.message) {
        errMsg = error.response.data.message
      } else if (error.message) {
        errMsg = error.message
      }
      message.error(errMsg)
    } finally {
      setAiAnalyzing(false)
    }
  }

  // 默认提示词模板（基于 excel/分析提示词.txt - 品牌词套利审计 v5 完整版）
  const defaultPromptTemplate = `# Google Ads 品牌词套利审计提示词（v5 强制完整版）

你是资深 Google Ads 品牌词直连套利操盘手。对表格中每个广告系列做全量审计与分级，输出可执行方案。

══════════════════════════════════════
【团队节奏】
══════════════════════════════════════
分析日：每天

══════════════════════════════════════
【口径】
══════════════════════════════════════
- 保守EPC/ROI 已含0.72系数，禁止重复乘
- L7D = D-1至D-8滚动累计
- 日均点击 = L7D点击 ÷ 7
- 红线CPC = 保守EPC × 0.7

══════════════════════════════════════
【样本量判定】
══════════════════════════════════════
| 日均点击 | 判定 | 约束 |
|---------|------|------|
| < 10 | 🔴 | 禁判D（除非EPC=0） |
| 10-25 | 🟡 | 禁判S |
| > 25 | 🟢 | 正常判定 |

══════════════════════════════════════
【瓶颈判定】
══════════════════════════════════════
- Budget瓶颈：Budget丢失 ≥ 40% 且 > Rank丢失
- Rank瓶颈：Rank丢失 ≥ 40% 且 > Budget丢失
- 混合：两者都 ≥ 40%
- 正常：两者都 < 40%

══════════════════════════════════════
【分级规则】
══════════════════════════════════════
▶ S级：必须同时满足
  ① ROI ≥ 3.0  ② 不倒挂  ③ 出单天数 ≥ 5  ④ 样本🟢
  任一不满足 → B级

▶ D级：满足任一
  ① ROI ≤ 0 且 样本🟢
  ② 倒挂幅度 ≥ 0.05 且 ROI < 1.0 且 样本🟢
  ③ L7D点击 ≥ 100 且 出单 = 0
  ④ 保守EPC = 0

▶ B级：不满足S也不触发D

══════════════════════════════════════
【动作规则】
══════════════════════════════════════
预算上限：默认+30%；S级且Budget丢失>60%时允许+100%

▶ S级：Budget丢失>60%预算×2.0，40-60%预算×1.3，Rank丢失>60%加CPC至红线×0.9
▶ B级：倒挂→降CPC至红线；样本🔴🟡→预算×1.3
▶ D级：立即PAUSE
▶ 周五：S级额外+20%

══════════════════════════════════════
【效果预测公式（必算）】
══════════════════════════════════════
预期日点击 = 新预算 ÷ 新CPC
预期ROI = (保守EPC - 新CPC) ÷ 新CPC

方案可行性判定：
- 预期日点击 > 25 → ✅可达🟢
- 预期日点击 ≤ 25 → ⚠️无法达🟢
- 若无法达🟢：最低达标预算 = 26 × 新CPC

══════════════════════════════════════
【输出格式】
══════════════════════════════════════

A) 节奏面板
📅 今日：YYYY-MM-DD 周X（✅/⚠️）| 上次：周X | 下次：周X

B) 概览
总系列：X | S级：X | B级：X | D级：X

C) 审计总表
| # | 系列名 | 级别 | 日均点击 | 样本 | 红线 | MaxCPC | 倒挂 | ROI | 瓶颈 | 预期日点击 | 可行性 |

══════════════════════════════════════
D) 逐系列完整分析
══════════════════════════════════════
【统一模板 - 每个系列必须包含以下全部10行】：
---
【系列名称】
级别：S / B / D
检验：ROI=X.XX[✓/✗] | 不倒挂[✓/✗] | 出单≥5[✓/✗] | 样本🟢[✓/✗] → [4✓=S / 否则B / 触发D规则=D]
D级检查：①ROI≤0且🟢[是/否] ②倒挂≥0.05且ROI<1且🟢[是/否] ③点击≥100且出单=0[是/否] ④EPC=0[是/否] → 触发：[无/规则X]
诊断：日均X.X(🔴/🟡/🟢) | 红线$X.XX | 倒挂幅度$X.XX | Budget丢失X%/Rank丢失X% → [瓶颈类型]
动作：CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%) | [S/B/D特定动作说明]
效果：预期日点击=$X.XX÷$X.XX=X.X | 可行性[✅可达🟢/⚠️仅🟡/❌仍🔴] | 若⚠️❌:达🟢需$X.XX,缺口$X.XX | 预期ROI:X.XX→X.XX
验证：MM-DD周X | 届时预期状态 | 检查项 | 未达标处置
升降：升级条件 | 降级触发 | 维持观察点
---

E) 执行清单
| 优先级 | 系列 | 动作 | 操作 | 预期效果 | 可行性 | 验证日 |
| 🔴 | xxx | 暂停 | PAUSE | 止损 | - | - |
| 🟡 | xxx | 调价 | CPC X→X | ROI X→X | ✅ | MM-DD |
| 🟢 | xxx | 加预算 | $X→$X | 日点击X→X | ⚠️ | MM-DD |

F) 专项名单
1. 潜力股：[系列] - 原因
2. 吸血鬼：[系列] - 触发规则X
3. 样本不足：[系列] - 可行性[✅/⚠️]，若⚠️达🟢需$X.XX
4. 受限系列：[系列] - 需X次+30%调整达🟢

G) 综述
关键发现 | 下次重点 | [周五]周末策略

══════════════════════════════════════
上图表格是待审计的广告系列数据，请开始审计：`

  // 加载用户自定义提示词
  const loadCustomPrompt = async () => {
    setLoadingPrompt(true)
    try {
      const response = await api.get('/api/gemini/user-prompt')
      setCustomPrompt(response.data?.prompt || '')
    } catch (error) {
      setCustomPrompt('')
    } finally {
      setLoadingPrompt(false)
    }
  }

  // 保存自定义提示词
  const saveCustomPrompt = async () => {
    setSavingPrompt(true)
    try {
      await api.post('/api/gemini/user-prompt', { prompt: customPrompt })
      message.success('提示词保存成功')
      setPromptModalOpen(false)
    } catch (error) {
      message.error('保存失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setSavingPrompt(false)
    }
  }

  // 打开提示词编辑
  const openPromptEditor = () => {
    loadCustomPrompt()
    setPromptModalOpen(true)
  }
  
  // 查看单条广告系列的 AI 分析报告（从已存储的数据中读取）
  const handleViewCampaignReport = useCallback((row) => {
    if (!row) return
    
    const campaignName = String(row['广告系列名'] || row['广告系列'] || row['系列名'] || '')
    let aiReport = row['ai_report'] || ''
    
    setSelectedCampaignRow(row)
    setSingleCampaignAnalyzing(false)
    setSingleCampaignModalOpen(true)
    
    if (aiReport) {
      // 清理报告：如果报告以"该广告系列的分析报告可能包含在完整报告中"开头，说明匹配失败
      // 尝试从完整报告中提取该广告系列的部分
      if (aiReport.includes('该广告系列的分析报告可能包含在完整报告中')) {
        // 尝试从报告中找到该广告系列的段落
        const extractedReport = extractCampaignSection(aiReport, campaignName)
        if (extractedReport) {
          aiReport = extractedReport
        } else {
          // 如果还是找不到，显示简化的提示
          aiReport = `### 📊 ${campaignName}\n\n该广告系列的详细分析暂时无法单独提取。\n\n请点击主表格上方的「生成报告」按钮查看完整的 AI 分析报告。`
        }
      }
      
      setSingleCampaignResult({
        campaign_name: campaignName,
        analysis: aiReport,
        analysis_date: dayjs().format('YYYY-MM-DD')
      })
    } else {
      // 没有 AI 报告，显示提示
      setSingleCampaignResult({
        campaign_name: campaignName,
        analysis: `### 📊 ${campaignName}\n\n该广告系列暂无 AI 分析报告。\n\n**可能的原因：**\n- 该分析是在 AI 报告功能上线前生成的\n- AI 报告生成过程中出现错误\n\n**建议：** 点击"从API数据生成L7D分析"按钮重新生成分析。`,
        analysis_date: dayjs().format('YYYY-MM-DD')
      })
    }
  }, [])
  
  // 从完整报告中提取特定广告系列的段落
  const extractCampaignSection = (fullReport, campaignName) => {
    if (!fullReport || !campaignName) return null
    
    // 简化广告系列名用于匹配
    const simpleName = campaignName.toLowerCase().replace(/[^a-z0-9\-]/g, '')
    
    // 按 ### 分割报告
    const sections = fullReport.split(/(?=###\s)/)
    
    for (const section of sections) {
      const sectionLower = section.toLowerCase()
      // 检查该段落是否包含广告系列名
      if (sectionLower.includes(campaignName.toLowerCase()) || 
          sectionLower.replace(/[^a-z0-9\-]/g, '').includes(simpleName)) {
        // 检查是否是子标题（如 "### 1. 阶段评价"）
        const firstLine = section.split('\n')[0] || ''
        if (/###\s*\d+\./.test(firstLine)) continue
        // 检查是否是概览类标题
        if (/概览|总览|执行清单|综述|专项名单/.test(firstLine)) continue
        
        return section.trim()
      }
    }
    return null
  }

  const handleDeleteResult = async (resultId) => {
    try {
      // 乐观更新：立即从UI中移除，提升用户体验
      setResults(prev => prev.filter(r => r.id !== resultId))
      
      // 清除相关缓存，确保下次获取最新数据
      try {
        const cacheKeys = Object.keys(sessionStorage).filter(key => key.startsWith('analysis_cache_'))
        cacheKeys.forEach(key => sessionStorage.removeItem(key))
      } catch (e) {
        // 忽略缓存清除错误
      }
      
      // 重置lastFetchParams，强制下次刷新
      lastFetchParams.current = null
      
      // 执行删除操作
      await api.delete(`/api/analysis/results/${resultId}`)
      message.success('删除成功')
      
      // 强制刷新数据（不使用缓存）
      fetchResults(false)
    } catch (error) {
      // 如果是请求被取消，不显示错误提示
      if (error.isCanceled || error.name === 'CanceledError' || error.name === 'AbortError') {
        return
      }
      // 如果删除失败，恢复数据
      fetchResults(false)
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  useEffect(() => {
    fetchAccounts()
    fetchBidStrategies()
    // 初始加载时不使用缓存，确保获取最新数据
    fetchResults(false)
  }, [])

  // 当筛选条件变化时，重新获取数据（非初始加载时使用缓存）
  useEffect(() => {
    // 跳过初始加载
    if (isInitialMount.current) return
    fetchResults(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccount, dateRange])

  const columns = useMemo(
    () => [
      {
        title: '日期',
        dataIndex: 'analysis_date',
        key: 'analysis_date',
        width: 120,
        render: (v) => (v ? String(v).slice(0, 10) : '-'),
      },
      ...(isManager
        ? [
            {
              title: '员工',
              dataIndex: 'username',
              key: 'username',
              width: 120,
              render: (v) => v || '-',
            },
          ]
        : []),
      // 联盟账号列已移除
      {
        title: '数据行数',
        key: 'rows',
        width: 110,
        align: 'right',
        render: (_, record) => {
          const data = record.result_data?.data || []
          const count = Array.isArray(data) ? data.length : 0
          return <Badge count={count} color={count > 0 ? '#1677ff' : '#d9d9d9'} />
        },
      },
      {
        title: '操作',
        key: 'action',
        width: 160,
        fixed: 'right',
        render: (_, record) => (
          <Space size="small">
            <Tooltip title="生成 AI 分析报告">
              <Button 
                type="primary"
                ghost
                size="small"
                icon={<RobotOutlined />}
                onClick={() => handleGenerateReport(record)}
              >
                生成报告
              </Button>
            </Tooltip>
            <Popconfirm
              title="确定删除该分析结果吗？"
              description="删除后无法恢复"
              okText="确定"
              cancelText="取消"
              onConfirm={() => handleDeleteResult(record.id)}
            >
              <Button danger size="small">删除</Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [isManager]
  )

  return (
    <div className="analysis-page">
      {/* AI 分析全屏loading */}
      <AiGeneratingOverlay 
        visible={aiAnalyzing && !aiModalOpen}
        title="AI 分析中..."
        description={`正在分析 ${selectedResultForAi?.result_data?.data?.length || 0} 个广告系列，请稍候`}
      />
      
      <div className="analysis-page__header">
        <div>
          <Title level={3} className="analysis-page__title">
            L7D分析结果
          </Title>
          <Text className="analysis-page__subtitle">
            每天自动生成的 L7D 分析结果；支持按联盟账号与日期筛选；展开行可查看每条分析明细
          </Text>
        </div>
        <Space>
          <Button 
            icon={<SettingOutlined />} 
            onClick={openPromptEditor}
          >
            自定义提示词
          </Button>
          <Button
            type="primary"
            onClick={handleGenerateFromApi}
            loading={generatingFromApi}
          >
            从API数据生成L7D分析
          </Button>
        </Space>
      </div>

      {/* 移动端表格滚动提示 */}
      <div className="table-scroll-hint">👆 左右滑动查看完整表格 👆</div>

      {/* AI 分析结果 Modal */}
      <Modal
        title={null}
        open={aiModalOpen}
        onCancel={() => setAiModalOpen(false)}
        width={1100}
        footer={null}
        styles={{ 
          body: { padding: 0 },
          content: { borderRadius: 16, overflow: 'hidden' }
        }}
      >
        {aiAnalyzing ? (
          <div style={{ textAlign: 'center', padding: 80 }}>
            <Spin size="large" />
            <p style={{ marginTop: 20, fontSize: 16, color: '#1a1a2e', fontWeight: 500 }}>
              AI 正在分析 {selectedResultForAi?.result_data?.data?.length || 0} 个广告系列...
            </p>
            <p style={{ color: '#8c8c8c', fontSize: 14 }}>使用 Gemini 深度分析模型，预计需要 30-60 秒</p>
          </div>
        ) : aiAnalysisResult ? (
          <div>
            {/* 报告头部 */}
            <div style={{ 
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              padding: '24px 32px',
              color: 'white'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <Button 
                    type="text"
                    icon={<ArrowLeftOutlined style={{ fontSize: 20 }} />}
                    onClick={() => setAiModalOpen(false)}
                    style={{ color: 'white', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  />
                  <div>
                    <Title level={3} style={{ color: 'white', margin: 0, marginBottom: 8 }}>
                      <RobotOutlined style={{ marginRight: 12 }} />
                      AI 智能分析报告
                    </Title>
                    <Space size="middle">
                      <Tag color="rgba(255,255,255,0.2)" style={{ color: 'white', border: 'none' }}>
                📊 {aiAnalysisResult.campaign_count} 个广告系列
              </Tag>
                      <Tag color="rgba(255,255,255,0.2)" style={{ color: 'white', border: 'none' }}>
                        📅 {aiAnalysisResult.analysis_date}
                      </Tag>
          </Space>
                  </div>
                </div>
                <Space>
          <Button 
            type="primary"
                    ghost
                    icon={<CopyOutlined />}
            onClick={() => {
              if (aiAnalysisResult?.analysis) {
                navigator.clipboard.writeText(aiAnalysisResult.analysis)
                message.success('已复制到剪贴板')
              }
            }}
                    style={{ borderColor: 'white', color: 'white' }}
          >
            复制报告
          </Button>
                  <Button 
                    type="text"
                    icon={<CloseOutlined style={{ fontSize: 18 }} />}
                    onClick={() => setAiModalOpen(false)}
                    style={{ color: 'white', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  />
              </Space>
            </div>
            </div>

            {/* 报告内容 */}
            <div style={{ 
              padding: '24px 32px', 
              maxHeight: '65vh', 
              overflow: 'auto',
              background: '#f5f7fa'
            }}>
              <ReportViewer 
                content={aiAnalysisResult.analysis}
                campaignCount={aiAnalysisResult.campaign_count}
                analysisDate={aiAnalysisResult.analysis_date}
              />
            </div>

            {/* 底部操作栏 */}
            <div style={{ 
              padding: '16px 32px', 
              background: 'white',
              borderTop: '1px solid #f0f0f0',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <Button 
                type="primary"
                icon={<ArrowLeftOutlined />}
                onClick={() => setAiModalOpen(false)}
                size="large"
              >
                返回列表
              </Button>
              <Space>
                <Button 
                  type="primary"
                  icon={<RocketOutlined />}
                  onClick={() => setCpcDeployModalOpen(true)}
                  style={{ background: '#52c41a', borderColor: '#52c41a' }}
                >
                  一键部署CPC
                </Button>
                <Button 
                  icon={<CopyOutlined />}
                  onClick={() => {
                    if (aiAnalysisResult?.analysis) {
                      navigator.clipboard.writeText(aiAnalysisResult.analysis)
                      message.success('已复制到剪贴板')
                    }
                  }}
                >
                  复制报告
                </Button>
                <Button onClick={() => setAiModalOpen(false)}>
                  关闭
                </Button>
              </Space>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 80, color: '#999' }}>
            <RobotOutlined style={{ fontSize: 56, marginBottom: 16, color: '#d9d9d9' }} />
            <p style={{ fontSize: 15 }}>选择一条 L7D 分析结果，点击"生成报告"按钮</p>
          </div>
        )}
      </Modal>

      {/* 提示词编辑 Modal */}
      <Modal
        title={
          <Space>
            <SettingOutlined />
            <span>自定义分析提示词</span>
          </Space>
        }
        open={promptModalOpen}
        onCancel={() => setPromptModalOpen(false)}
        width={800}
        footer={[
          <Button key="reset" onClick={() => setCustomPrompt(defaultPromptTemplate)}>
            恢复默认
          </Button>,
          <Button key="cancel" onClick={() => setPromptModalOpen(false)}>
            取消
          </Button>,
          <Button 
            key="save" 
            type="primary"
            loading={savingPrompt}
            onClick={saveCustomPrompt}
          >
            保存
          </Button>
        ]}
        styles={{ body: { padding: '16px 24px' } }}
      >
        <Spin spinning={loadingPrompt}>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">
              自定义 AI 分析提示词，用于生成广告优化报告。留空则使用默认提示词。
            </Text>
          </div>
          <Input.TextArea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder={defaultPromptTemplate}
            rows={18}
            style={{ 
              fontFamily: 'monospace', 
              fontSize: 13,
              lineHeight: 1.5
            }}
          />
          <div style={{ marginTop: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              提示：生成报告时会自动附上广告系列数据。你可以自定义分析规则和输出格式。
            </Text>
          </div>
        </Spin>
      </Modal>

      {/* 单条广告系列分析 Modal */}
      <Modal
        title={null}
        open={singleCampaignModalOpen}
        onCancel={() => setSingleCampaignModalOpen(false)}
        width={1000}
        footer={null}
        styles={{ 
          body: { padding: 0 },
          content: { borderRadius: 16, overflow: 'hidden' }
        }}
      >
        {singleCampaignResult ? (
          <div>
            {/* 报告头部 */}
            <div style={{ 
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              padding: '20px 28px',
              color: 'white'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <Button 
                    type="text"
                    icon={<ArrowLeftOutlined style={{ fontSize: 18 }} />}
                    onClick={() => setSingleCampaignModalOpen(false)}
                    style={{ color: 'white', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  />
                  <div>
                    <Title level={4} style={{ color: 'white', margin: 0, marginBottom: 4 }}>
                      <RobotOutlined style={{ marginRight: 10 }} />
                      广告系列分析报告
                    </Title>
                    <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>
                      {singleCampaignResult.campaign_name}
                    </Text>
                  </div>
                </div>
                <Space>
                  <Button 
                    type="primary"
                    ghost
                    icon={<CopyOutlined />}
                    onClick={() => {
                      if (singleCampaignResult?.analysis) {
                        navigator.clipboard.writeText(singleCampaignResult.analysis)
                        message.success('已复制到剪贴板')
                      }
                    }}
                    style={{ borderColor: 'white', color: 'white' }}
                  >
                    复制
                  </Button>
                  <Button 
                    type="text"
                    icon={<CloseOutlined style={{ fontSize: 16 }} />}
                    onClick={() => setSingleCampaignModalOpen(false)}
                    style={{ color: 'white', width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  />
                </Space>
              </div>
            </div>

            {/* 报告内容 */}
            <div style={{ 
              padding: '20px 28px', 
              maxHeight: '60vh', 
              overflow: 'auto',
              background: '#f5f7fa'
            }}>
              <ReportViewer 
                content={singleCampaignResult.analysis}
                campaignCount={1}
                analysisDate={singleCampaignResult.analysis_date}
                singleMode={true}
              />
            </div>

            {/* 底部操作栏 */}
            <div style={{ 
              padding: '12px 28px', 
              background: 'white',
              borderTop: '1px solid #f0f0f0',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 12
            }}>
              <Button 
                icon={<CopyOutlined />}
                onClick={() => {
                  if (singleCampaignResult?.analysis) {
                    navigator.clipboard.writeText(singleCampaignResult.analysis)
                    message.success('已复制到剪贴板')
                  }
                }}
              >
                复制报告
              </Button>
              <Button onClick={() => setSingleCampaignModalOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
            <RobotOutlined style={{ fontSize: 48, marginBottom: 16, color: '#d9d9d9' }} />
            <p>点击操作指令查看 AI 分析报告</p>
          </div>
        )}
      </Modal>

      <Card className="analysis-table" styles={{ body: { paddingTop: 14 } }}>
        <div className="analysis-filters">
          <Select
            placeholder="选择联盟账号"
            style={{ width: 260 }}
            value={selectedAccount}
            onChange={setSelectedAccount}
            allowClear
            showSearch
            optionFilterProp="children"
          >
            {accounts.map(acc => (
              <Option key={acc.id} value={acc.id}>
                {acc.platform?.platform_name || '-'} - {acc.account_name || '-'}
              </Option>
            ))}
          </Select>
          <RangePicker
            value={dateRange}
            onChange={setDateRange}
            format="YYYY-MM-DD"
            allowEmpty={[true, true]}
          />
          <ExportButton
            type="analysis"
            accountId={selectedAccount}
            dateRange={dateRange}
          />
        </div>

        {isManager ? (
          // 经理账号：按员工分组显示
          (() => {
            const groupedByUser = results.reduce((acc, result) => {
              const username = result.username || `用户ID: ${result.user_id}`
              if (!acc[username]) {
                acc[username] = []
              }
              acc[username].push(result)
              return acc
            }, {})

            const collapseItems = Object.entries(groupedByUser).map(([username, userResults]) => ({
              key: username,
              label: (
                <Space>
                  <Text strong>{username}</Text>
                  <Badge count={userResults.length} color="#1677ff" />
                </Space>
              ),
              children: (
                <Table
                  columns={columns}
                  dataSource={userResults}
                  loading={loading}
                  rowKey="id"
                  size="middle"
                  bordered
                  sticky
                  scroll={{ x: 800 }}
                  pagination={{ 
                    pageSize: 10, 
                    showSizeChanger: true,
                    showQuickJumper: false,
                    showTotal: (total) => `共 ${total} 条`
                  }}
                  expandable={{
                    expandedRowRender: (record) => {
                      const data = record.result_data?.data || []
                      if (!Array.isArray(data) || data.length === 0) return <Text type="secondary">暂无数据</Text>

                      // 获取所有键，过滤掉不需要显示的列
                      const allKeys = Object.keys(data[0])
                      const keysToShow = allKeys.filter(key => !['ROI', '点击', '订单', 'ai_report'].includes(key))
                      
                      const dataColumns = keysToShow.map((key) => {
                        const column = {
                          title: key,
                          dataIndex: key,
                          key,
                          ellipsis: true,
                          render: (text) => {
                            if (text === null || text === undefined || text === '') return '-'
                            return <Tooltip title={String(text)}>{String(text)}</Tooltip>
                          },
                        }

                        // 为"状态"列添加颜色渲染（健康/观察/暂停）
                        if (key === '状态') {
                          column.width = 80
                          column.ellipsis = false
                          column.render = (text) => {
                            if (!text) return '-'
                            const t = String(text)
                            let color = 'default'
                            if (t === '健康') color = 'green'
                            else if (t === '观察') color = 'orange'
                            else if (t === '暂停') color = 'red'
                            return <Tag color={color}>{t}</Tag>
                          }
                        }

                        // 为处理动作列添加特殊渲染
                        if (key === '处理动作') {
                          column.width = 110
                          column.ellipsis = false
                          column.render = (text) => {
                            if (!text) return '-'
                            const t = String(text)
                            let color = 'default'
                            if (t.includes('暂停')) color = 'red'
                            else if (t.includes('加预算') || t.includes('增加')) color = 'green'
                            else if (t.includes('维持') || t.includes('保持')) color = 'blue'
                            return <Tag color={color}>{t}</Tag>
                          }
                        }

                        // 为操作指令列添加特殊渲染 - 可点击查看AI报告（经理视图）
                        if (key === '操作指令') {
                          column.width = 260
                          column.ellipsis = false
                          column.render = (text, row) => {
                            if (!text || text === '-') return '-'
                            const t = String(text)
                            let color = 'default'
                            // 根据操作指令内容设置颜色（支持新格式：CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%)）
                            if (t.includes('关停') || t === 'PAUSE') {
                              color = 'red'
                            } else if (t.includes('样本不足')) {
                              color = 'default'
                            } else if (t.includes('稳定运行') || (t.includes('(+0%)') && !t.includes('(+2') && !t.includes('(+3'))) {
                              color = 'blue'
                            } else if (t.includes('(+30%)') || t.includes('(+20%)')) {
                              color = 'green'
                            } else if (t.includes('→') && t.includes('CPC') && !t.includes('预算')) {
                              // 只有CPC变化，可能是降价
                              const cpcMatch = t.match(/CPC \$(\d+\.?\d*)\u2192\$(\d+\.?\d*)/)
                              if (cpcMatch) {
                                const oldCpc = parseFloat(cpcMatch[1])
                                const newCpc = parseFloat(cpcMatch[2])
                                color = newCpc < oldCpc ? 'orange' : 'cyan'
                              } else {
                                color = 'cyan'
                              }
                            } else if (t.includes('→')) {
                              color = 'cyan'
                            }
                            return (
                              <Tooltip title="点击查看该广告系列的 AI 分析报告">
                                <Tag 
                                  color={color} 
                                  style={{ fontSize: '12px', cursor: 'pointer', maxWidth: '240px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                  onClick={(e) => {
                                    e.stopPropagation() // 阻止冒泡到行展开
                                    handleViewCampaignReport(row)
                                  }}
                                >
                                  {t}
                                </Tag>
                              </Tooltip>
                            )
                          }
                        }

                        // 为阶段标签列添加特殊渲染（可点击跳转）
                        if (key === '阶段标签') {
                          column.width = 120
                          column.ellipsis = false
                          column.render = (text) => {
                            if (!text) return '-'
                            const t = String(text)
                            let color = 'default'
                            if (t.includes('K1') || t.includes('关停')) color = 'red'
                            else if (t.includes('S1') || t.includes('成熟')) color = 'green'
                            else if (t.includes('P1') || t.includes('候选')) color = 'cyan'
                            else if (t.includes('T2') || t.includes('观察')) color = 'orange'
                            else if (t.includes('T1') || t.includes('试水')) color = 'blue'
                            return (
                              <Tag 
                                color={color}
                                style={{ cursor: 'pointer' }}
                                onClick={() => navigate(`/stage-label/${encodeURIComponent(t)}`)}
                              >
                                {t}
                              </Tag>
                            )
                          }
                        }

                        // 为异常类型列添加特殊渲染（P0红色，P1黄色）
                        if (key === '异常类型') {
                          column.width = 120
                          column.ellipsis = false
                          column.render = (text) => {
                            if (!text || text === '-' || text === null || text === undefined) return '-'
                            const t = String(text).trim()
                            if (!t) return '-'
                            // 检查优先级：P0显示红色，P1显示黄色
                            let color = 'default'
                            if (t.startsWith('P0') || t.includes('P0-') || /^P0\s/.test(t)) {
                              color = 'red'
                            } else if (t.startsWith('P1') || t.includes('P1-') || /^P1\s/.test(t)) {
                              color = 'gold'
                            }
                            return <Tag color={color} style={{ fontWeight: color !== 'default' ? 'bold' : 'normal' }}>{t}</Tag>
                          }
                        }

                        // 将"表1状态"列名改为"谷歌状态"（兼容旧数据）
                        if (key === '表1状态') {
                          column.title = '谷歌状态'
                        }

                        // 动作相关列更宽 + tooltip
                        if (['投放动作', '数据动作', '风控动作', '使用场景', '动作原因'].includes(key)) {
                          column.width = 260
                        }

                        // 数值列格式化：默认保留两位小数（点击/订单保持整数）
                        if (['保守ROI', '保守EPC', 'CPC', '费用', '费用($)', '佣金', '回传佣金', '回传佣金($)', '保守佣金', '保守佣金($)', '预算', '点击', '订单'].some(col => key.includes(col))) {
                          column.align = 'right'
                          column.render = (text) => {
                            if (text === null || text === undefined || text === '') return '-'
                            const num = Number(text)
                            if (Number.isNaN(num)) return String(text)
                            // 后端按"原始值"返回保守ROI（如 0.4838），这里不做 *100 或加% 等转换
                            if (key.includes('ROI')) return num.toFixed(2)
                            if (key.includes('点击') || key.includes('订单')) return num.toFixed(0)
                            return num.toFixed(2)
                          }
                        }

                        return column
                      })

                      // 将"账号=CID、广告系列名、阶段标签"置于前三列并冻结在左侧（兼容旧字段"广告系列"）
                      const pinnedLeft = ['账号=CID', '广告系列名', '广告系列', '阶段标签']
                      const leftCols = []
                      for (const colName of pinnedLeft) {
                        const idx = dataColumns.findIndex((c) => c.key === colName)
                        if (idx > -1) {
                          const col = dataColumns.splice(idx, 1)[0]
                          col.fixed = 'left'
                          // 合理列宽
                          if (colName === '账号=CID') col.width = col.width || 140
                          if (colName === '广告系列名' || colName === '广告系列') col.width = col.width || 260
                          if (colName === '阶段标签') col.width = col.width || 120
                          leftCols.push(col)
                        }
                      }
                      dataColumns.unshift(...leftCols)

                      const dataWithKeys = data.map((r, idx) => ({
                        ...r,
                        __rowKey: `${record.id}-${idx}`,
                      }))

                      return (
                        <div className="analysis-subtable">
                  <Table
                    columns={dataColumns}
                    dataSource={dataWithKeys}
                    rowKey="__rowKey"
                    pagination={dataWithKeys.length > 100 ? { 
                      pageSize: 50, 
                      size: 'small', 
                      hideOnSinglePage: false,
                      showQuickJumper: true,
                      showSizeChanger: true,
                      pageSizeOptions: ['20', '50', '100'],
                      showTotal: (total) => `共 ${total} 条`
                    } : { 
                      pageSize: 20, 
                      size: 'small', 
                      hideOnSinglePage: true,
                      showQuickJumper: false,
                      showSizeChanger: false
                    }}
                    size="small"
                    bordered
                    sticky
                    scroll={{ x: 'max-content', y: 500 }}
                    virtual={dataWithKeys.length > 200}
                  />
                        </div>
                      )
                    },
                  }}
                />
              ),
            }))

            return (
              <Collapse
                items={collapseItems}
                defaultActiveKey={Object.keys(groupedByUser)}
                style={{ background: '#fff' }}
              />
            )
          })()
        ) : (
          // 员工账号：直接显示表格
          <Table
            columns={columns}
            dataSource={results}
            loading={loading}
            rowKey="id"
            size="middle"
            bordered
            sticky
            scroll={{ x: 800 }}
            pagination={{ 
              pageSize: 10, 
              showSizeChanger: true,
              showQuickJumper: false,
              showTotal: (total) => `共 ${total} 条`
            }}
            expandable={{
            expandedRowRender: (record) => {
              const data = record.result_data?.data || []
              if (!Array.isArray(data) || data.length === 0) return <Text type="secondary">暂无数据</Text>

              // 获取所有键，过滤掉不需要显示的列
              const allKeys = Object.keys(data[0])
              const keysToShow = allKeys.filter(key => !['ROI', '点击', '订单', 'ai_report'].includes(key))

              const dataColumns = keysToShow.map((key) => {
                const column = {
                  title: key,
                  dataIndex: key,
                  key,
                  ellipsis: true,
                  render: (text) => {
                    if (text === null || text === undefined || text === '') return '-'
                    return <Tooltip title={String(text)}>{String(text)}</Tooltip>
                  },
                }

                // 为"状态"列添加颜色渲染（健康/观察/暂停）
                if (key === '状态') {
                  column.width = 80
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text) return '-'
                    const t = String(text)
                    let color = 'default'
                    if (t === '健康') color = 'green'
                    else if (t === '观察') color = 'orange'
                    else if (t === '暂停') color = 'red'
                    return <Tag color={color}>{t}</Tag>
                  }
                }

                // 为处理动作列添加特殊渲染
                if (key === '处理动作') {
                  column.width = 110
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text) return '-'
                    const t = String(text)
                    let color = 'default'
                    if (t.includes('暂停')) color = 'red'
                    else if (t.includes('加预算') || t.includes('增加')) color = 'green'
                    else if (t.includes('维持') || t.includes('保持')) color = 'blue'
                    return <Tag color={color}>{t}</Tag>
                  }
                }

                // 为操作指令列添加特殊渲染 - 可点击查看AI报告
                if (key === '操作指令') {
                  column.width = 260
                  column.ellipsis = false
                  column.render = (text, row) => {
                    if (!text || text === '-') return '-'
                    const t = String(text)
                    let color = 'default'
                    // 根据操作指令内容设置颜色（支持新格式：CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%)）
                    if (t.includes('关停') || t === 'PAUSE') {
                      color = 'red'
                    } else if (t.includes('样本不足')) {
                      color = 'default'
                    } else if (t.includes('稳定运行') || (t.includes('(+0%)') && !t.includes('(+2') && !t.includes('(+3'))) {
                      color = 'blue'
                    } else if (t.includes('(+30%)') || t.includes('(+20%)')) {
                      color = 'green'
                    } else if (t.includes('→') && t.includes('CPC') && !t.includes('预算')) {
                      // 只有CPC变化，可能是降价
                      const cpcMatch = t.match(/CPC \$(\d+\.?\d*)\u2192\$(\d+\.?\d*)/)
                      if (cpcMatch) {
                        const oldCpc = parseFloat(cpcMatch[1])
                        const newCpc = parseFloat(cpcMatch[2])
                        color = newCpc < oldCpc ? 'orange' : 'cyan'
                      } else {
                        color = 'cyan'
                      }
                    } else if (t.includes('→')) {
                      color = 'cyan'
                    }
                    return (
                      <Tooltip title="点击查看该广告系列的 AI 分析报告">
                        <Tag 
                          color={color} 
                          style={{ fontSize: '12px', cursor: 'pointer', maxWidth: '240px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                          onClick={(e) => {
                            e.stopPropagation() // 阻止冒泡到行展开
                            handleViewCampaignReport(row)
                          }}
                        >
                          {t}
                        </Tag>
                      </Tooltip>
                    )
                  }
                }
                
                // 为当前Max CPC列添加出价策略显示和操作按钮
                if (key === '当前Max CPC') {
                  column.width = 180
                  column.render = (text, row) => {
                    const campaignId = row['campaign_id']
                    const strategy = campaignId ? bidStrategies[campaignId] : null
                    const isManual = strategy?.is_manual_cpc
                    const isLoading = changingToManual[campaignId]
                    
                    return (
                      <Space size={4} direction="vertical" style={{ width: '100%' }}>
                        <Text strong>${(parseFloat(text) || 0).toFixed(2)}</Text>
                        {strategy ? (
                          isManual ? (
                            <Tag color="green" style={{ fontSize: 11 }}>人工出价</Tag>
                          ) : (
                            <Popconfirm
                              title="确认切换为人工CPC出价？"
                              description="切换后需手动设置每个关键词的出价"
                              onConfirm={() => handleChangeToManualCpc(row)}
                              okText="确认"
                              cancelText="取消"
                            >
                              <Button 
                                size="small" 
                                type="primary" 
                                danger
                                loading={isLoading}
                                icon={<ThunderboltOutlined />}
                                style={{ fontSize: 11, padding: '0 6px', height: 22 }}
                              >
                                改人工
                              </Button>
                            </Popconfirm>
                          )
                        ) : (
                          <Tag color="default" style={{ fontSize: 10 }}>-</Tag>
                        )}
                      </Space>
                    )
                  }
                }

                // 为阶段标签列添加特殊渲染（可点击跳转）
                if (key === '阶段标签') {
                  column.width = 120
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text) return '-'
                    const t = String(text)
                    let color = 'default'
                    if (t.includes('K1') || t.includes('关停')) color = 'red'
                    else if (t.includes('S1') || t.includes('成熟')) color = 'green'
                    else if (t.includes('P1') || t.includes('候选')) color = 'cyan'
                    else if (t.includes('T2') || t.includes('观察')) color = 'orange'
                    else if (t.includes('T1') || t.includes('试水')) color = 'blue'
                    return (
                      <Tag 
                        color={color}
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/stage-label/${encodeURIComponent(t)}`)}
                      >
                        {t}
                      </Tag>
                    )
                  }
                }

                // 为异常类型列添加特殊渲染（P0红色，P1黄色）
                if (key === '异常类型') {
                  column.width = 120
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text || text === '-' || text === null || text === undefined) return '-'
                    const t = String(text).trim()
                    if (!t) return '-'
                    // 检查优先级：P0显示红色，P1显示黄色
                    let color = 'default'
                    if (t.startsWith('P0') || t.includes('P0-') || /^P0\s/.test(t)) {
                      color = 'red'
                    } else if (t.startsWith('P1') || t.includes('P1-') || /^P1\s/.test(t)) {
                      color = 'gold'
                    }
                    return <Tag color={color} style={{ fontWeight: color !== 'default' ? 'bold' : 'normal' }}>{t}</Tag>
                  }
                }

                // 将"表1状态"列名改为"谷歌状态"（兼容旧数据）
                if (key === '表1状态') {
                  column.title = '谷歌状态'
                }

                // 动作相关列更宽 + tooltip
                if (['投放动作', '数据动作', '风控动作', '使用场景', '动作原因'].includes(key)) {
                  column.width = 260
                }

                // 数值列格式化：默认保留两位小数（点击/订单保持整数）
                if (['保守ROI', '保守EPC', 'CPC', '费用', '费用($)', '佣金', '回传佣金', '回传佣金($)', '保守佣金', '保守佣金($)', '预算', '点击', '订单'].some(col => key.includes(col))) {
                  column.align = 'right'
                  column.render = (text) => {
                    if (text === null || text === undefined || text === '') return '-'
                    const num = Number(text)
                    if (Number.isNaN(num)) return String(text)
                    // 后端按“原始值”返回保守ROI（如 0.4838），这里不做 *100 或加% 等转换
                    if (key.includes('ROI')) return num.toFixed(2)
                    if (key.includes('点击') || key.includes('订单')) return num.toFixed(0)
                    return num.toFixed(2)
                  }
                }

                return column
              })

              // 将“账号=CID、广告系列名、阶段标签”置于前三列并冻结在左侧（兼容旧字段“广告系列”）
              const pinnedLeft = ['账号=CID', '广告系列名', '广告系列', '阶段标签']
              const leftCols = []
              for (const colName of pinnedLeft) {
                const idx = dataColumns.findIndex((c) => c.key === colName)
                if (idx > -1) {
                  const col = dataColumns.splice(idx, 1)[0]
                  col.fixed = 'left'
                  // 合理列宽
                  if (colName === '账号=CID') col.width = col.width || 140
                  if (colName === '广告系列名' || colName === '广告系列') col.width = col.width || 260
                  if (colName === '阶段标签') col.width = col.width || 120
                  leftCols.push(col)
                }
              }
              dataColumns.unshift(...leftCols)

              const dataWithKeys = data.map((r, idx) => ({
                ...r,
                __rowKey: `${record.id}-${idx}`,
              }))

              return (
                <div className="analysis-subtable">
                  <Table
                    columns={dataColumns}
                    dataSource={dataWithKeys}
                    rowKey="__rowKey"
                    pagination={{ 
                      pageSize: 20, 
                      size: 'small', 
                      hideOnSinglePage: true,
                      showQuickJumper: false,
                      showSizeChanger: false
                    }}
                    size="small"
                    bordered
                    sticky
                    scroll={{ x: 'max-content', y: 420 }}
                    virtual={false}
                  />
                </div>
              )
            },
          }}
        />
        )}
      </Card>

      {/* CPC部署弹窗 */}
      <CpcDeployModal
        visible={cpcDeployModalOpen}
        onClose={() => setCpcDeployModalOpen(false)}
        aiReport={aiAnalysisResult?.analysis || ''}
        onSuccess={() => {
          setCpcDeployModalOpen(false)
          message.success('CPC部署成功！')
        }}
      />
    </div>
  )
}

export default Analysis




