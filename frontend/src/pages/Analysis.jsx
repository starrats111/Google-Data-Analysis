import React, { useMemo, useState, useEffect, useRef } from 'react'
import { Card, Table, Select, DatePicker, Space, message, Tag, Badge, Typography, Tooltip, Button, Popconfirm, Collapse, Modal, Upload, Spin, Input } from 'antd'
import { UploadOutlined, RobotOutlined, SettingOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import api from '../services/api'
import ExportButton from '../components/Export/ExportButton'
import { useAuth } from '../store/authStore'
import './Analysis.css'

const { RangePicker } = DatePicker
const { Option } = Select
const { Title, Text } = Typography

// 缓存key生成函数
const getCacheKey = (mode, accountId, dateRange) => {
  const dateStr = dateRange && dateRange.length === 2 
    ? `${dateRange[0].format('YYYY-MM-DD')}_${dateRange[1].format('YYYY-MM-DD')}`
    : 'all'
  return `analysis_cache_${mode}_${accountId || 'all'}_${dateStr}`
}

// props:
// - mode: 'l7d' | 'daily'
//   默认使用 'l7d'，用于 L7D 分析页面；'daily' 用于每日分析页面
const Analysis = ({ mode }) => {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isManager = user?.role === 'manager'
  const analysisMode = mode || 'l7d'
  const isInitialMount = useRef(true)
  const lastFetchParams = useRef(null)

  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [dateRange, setDateRange] = useState(null)
  const [generatingL7D, setGeneratingL7D] = useState(false)
  const [googleModalOpen, setGoogleModalOpen] = useState(false)
  const [googleFile, setGoogleFile] = useState(null)
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

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/api/affiliate/accounts')
      setAccounts(response.data)
    } catch (error) {
      console.error('获取账号列表失败', error)
    }
  }

  // 优化：使用useMemo缓存检测函数，避免每次渲染都重新创建
  const detectResultType = useMemo(() => {
    return (result) => {
      const data = result?.result_data?.data
      if (!Array.isArray(data) || data.length === 0) {
        return 'unknown'
      }
      
      // 只检查第一行（性能优化），如果第一行为空再检查其他行
      const firstRow = data[0]
      if (!firstRow || typeof firstRow !== 'object') {
        // 如果第一行无效，快速检查前几行
        for (let i = 1; i < Math.min(5, data.length); i++) {
          if (data[i] && typeof data[i] === 'object') {
            const keys = Object.keys(data[i])
            const hasL7D = keys.some(k => k.startsWith('L7D') || ['L7D点击', 'L7D佣金', 'L7D花费', 'L7D出单天数'].includes(k))
            const hasDailyWeekCols = keys.includes('本周ROI') || keys.includes('本周费用') || keys.includes('本周佣金')
            if (hasDailyWeekCols && !hasL7D) return 'daily'
            if (hasL7D && !hasDailyWeekCols) return 'l7d'
            if (hasDailyWeekCols && hasL7D) return 'daily'
          }
        }
        return 'unknown'
      }
      
      const keys = Object.keys(firstRow)
      const hasL7D = keys.some(k =>
        k.startsWith('L7D') ||
        ['L7D点击', 'L7D佣金', 'L7D花费', 'L7D出单天数'].includes(k)
      )
      const hasDailyWeekCols = keys.includes('本周ROI') || keys.includes('本周费用') || keys.includes('本周佣金')
      
      // 优先判断：如果有本周列且没有L7D列，肯定是每日分析
      if (hasDailyWeekCols && !hasL7D) return 'daily'
      // 如果有L7D列且没有本周列，肯定是L7D分析
      if (hasL7D && !hasDailyWeekCols) return 'l7d'
      // 如果同时有，优先判断为每日分析
      if (hasDailyWeekCols && hasL7D) return 'daily'
      
      return 'unknown'
    }
  }, [])

  // 使用useMemo缓存过滤结果，避免每次渲染都重新过滤
  const filteredResults = useMemo(() => {
    // 如果results为空，直接返回
    if (!results || results.length === 0) return []
    if (!analysisMode) return results || []
    return (results || []).filter(r => {
      const t = detectResultType(r)
      if (analysisMode === 'l7d') {
        return t === 'l7d' || t === 'unknown'
      }
      if (analysisMode === 'daily') {
        return t === 'daily' || t === 'unknown'
      }
      return true
    })
  }, [results, analysisMode])

  const fetchResults = async (useCache = true) => {
    // 生成当前请求的参数key
    const paramsKey = JSON.stringify({
      account: selectedAccount,
      dateRange: dateRange ? [dateRange[0].format('YYYY-MM-DD'), dateRange[1].format('YYYY-MM-DD')] : null,
      mode: analysisMode
    })

    // 如果参数没变化且不是初始挂载，跳过请求
    if (useCache && lastFetchParams.current === paramsKey && !isInitialMount.current) {
      return
    }

    // 检查缓存
    const cacheKey = getCacheKey(analysisMode, selectedAccount, dateRange)
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
      message.error('获取分析结果失败')
    } finally {
      setLoading(false)
      isInitialMount.current = false
    }
  }

  // 从API数据生成分析
  const handleGenerateFromApi = async () => {
    if (analysisMode === 'daily') {
      // 生成每日分析
      if (!dateRange || dateRange.length !== 2) {
        message.warning('请选择日期范围')
        return
      }
      
      setGeneratingFromApi(true)
      try {
        const beginDate = dateRange[0].format('YYYY-MM-DD')
        const endDate = dateRange[1].format('YYYY-MM-DD')
        const response = await api.post('/api/analysis/daily', null, {
          params: { begin_date: beginDate, end_date: endDate }
        })
        
        if (response.data.success) {
          message.success(`成功生成 ${response.data.total_records} 条每日分析记录`)
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
    } else {
      // 生成L7D分析
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
  }

  // 仅在“每日分析”页提供：上传谷歌表（过去7天）+ 从每日数据生成 L7D
  const handleOpenGenerate = () => {
    setGoogleFile(null)
    setGoogleModalOpen(true)
  }

  const handleGenerateL7DFromDaily = async () => {
    try {
      setGeneratingL7D(true)
      if (!googleFile) {
        message.error('请先上传过去7天的谷歌表1（含预算/排名错失份额两列）')
        return
      }

      const form = new FormData()
      if (selectedAccount) form.append('affiliate_account_id', String(selectedAccount))
      if (dateRange && dateRange.length === 2) {
        form.append('end_date', dateRange[1].format('YYYY-MM-DD'))
      }
      form.append('google_file', googleFile)

      await api.post('/api/analysis/from-daily-with-google', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      message.success('已基于每日数据生成一份 L7D 分析')
      setGoogleModalOpen(false)
    } catch (error) {
      message.error(error.response?.data?.detail || '生成 L7D 分析失败')
    } finally {
      setGeneratingL7D(false)
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

  // 默认提示词模板
  const defaultPromptTemplate = `你是一位资深的 Google Ads 品牌词套利专家。请根据以下广告系列数据生成操作报告。

## 输出格式要求

对于每个广告系列，输出以下格式的执行指令：

**[广告系列名]**
- CPC 当前值→建议值
- 预算 $当前值→$建议值(变化%)
- 状态: 维持/暂停/加预算

## 分析规则

1. ROI < 0.8 → 考虑降低CPC或暂停
2. ROI > 1.5 且 Budget丢失 > 30% → 加预算
3. Rank丢失 > 20% → 考虑提高CPC
4. 连续7天无订单 → 暂停

请基于数据生成简洁、可执行的操作指令。`

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
      // 如果删除失败，恢复数据
      fetchResults(false)
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  useEffect(() => {
    fetchAccounts()
  }, [])

  // 当筛选条件变化时，重新获取数据
  useEffect(() => {
    fetchResults(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccount, dateRange])

  // 当mode切换时，先尝试从缓存加载，如果没有缓存再请求
  useEffect(() => {
    const cacheKey = getCacheKey(analysisMode, selectedAccount, dateRange)
    try {
      const cached = sessionStorage.getItem(cacheKey)
      if (cached) {
        const { data, timestamp } = JSON.parse(cached)
        // 缓存有效期5分钟
        if (Date.now() - timestamp < 5 * 60 * 1000) {
          setResults(data)
          return
        }
      }
    } catch (e) {
      // 缓存读取失败，继续请求
    }
    // 如果没有缓存，才请求数据
    fetchResults(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisMode])

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
            {analysisMode === 'l7d' && (
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
            )}
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
    [isManager, analysisMode]
  )

  return (
    <div className="analysis-page">
      <div className="analysis-page__header">
        <div>
          <Title level={3} className="analysis-page__title">
            {analysisMode === 'daily' ? '每日数据分析' : 'L7D分析结果'}
          </Title>
          <Text className="analysis-page__subtitle">
            {analysisMode === 'daily'
              ? '仅展示“每日分析”产生的结果：按日期 + 联盟账号展开查看每个广告系列的每日表现'
              : '仅展示 L7D 分析结果：支持按联盟账号与日期筛选；展开行可查看每条分析明细'}
          </Text>
        </div>
        <Space>
          {analysisMode === 'l7d' && (
            <Button 
              icon={<SettingOutlined />} 
              onClick={openPromptEditor}
            >
              自定义提示词
            </Button>
          )}
          <Button
            type="primary"
            onClick={handleGenerateFromApi}
            loading={generatingFromApi}
          >
            {analysisMode === 'daily' ? '从API数据生成每日分析' : '从API数据生成L7D分析'}
          </Button>
          {analysisMode === 'daily' && (
            <Button
              onClick={handleOpenGenerate}
              loading={generatingL7D}
            >
              生成L7D分析（上传文件）
            </Button>
          )}
        </Space>
      </div>

      <Modal
        title="生成L7D：请上传过去7天谷歌表1"
        open={googleModalOpen}
        onCancel={() => setGoogleModalOpen(false)}
        onOk={handleGenerateL7DFromDaily}
        okText="开始生成"
        confirmLoading={generatingL7D}
      >
        <div style={{ marginBottom: 12, color: '#666' }}>
          说明：系统会从该表中提取 <b>IS Budget丢失 / IS Rank丢失</b> 两列，其余L7D字段仍从每日分析数据聚合。
        </div>
        <Upload
          beforeUpload={(file) => {
            setGoogleFile(file)
            return false
          }}
          maxCount={1}
          onRemove={() => setGoogleFile(null)}
          accept=".xlsx,.csv"
        >
          <Button icon={<UploadOutlined />}>选择谷歌表文件</Button>
        </Upload>
        <div style={{ marginTop: 10, color: '#999', fontSize: 12 }}>
          需要包含列：<b>在搜索网络中因预算而错失的展示次数份额</b>、<b>在搜索网络中因评级而错失的展示次数份额</b>（或对应英文列）。
        </div>
      </Modal>

      {/* AI 分析结果 Modal */}
      <Modal
        title={
          <Space>
            <RobotOutlined />
            <span>AI 分析报告</span>
            {aiAnalysisResult && (
              <Tag color="blue">
                📊 {aiAnalysisResult.campaign_count} 个广告系列
              </Tag>
            )}
          </Space>
        }
        open={aiModalOpen}
        onCancel={() => setAiModalOpen(false)}
        width={1200}
        footer={[
          <Button key="close" onClick={() => setAiModalOpen(false)}>
            关闭
          </Button>,
          <Button 
            key="copy" 
            type="primary"
            onClick={() => {
              if (aiAnalysisResult?.analysis) {
                navigator.clipboard.writeText(aiAnalysisResult.analysis)
                message.success('已复制到剪贴板')
              }
            }}
            disabled={!aiAnalysisResult?.analysis}
          >
            复制报告
          </Button>
        ]}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {aiAnalyzing ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" />
            <p style={{ marginTop: 16, fontSize: 16 }}>AI 正在分析 {selectedResultForAi?.result_data?.data?.length || 0} 个广告系列...</p>
            <p style={{ color: '#999' }}>使用 Gemini 深度分析模型，预计需要 30-60 秒</p>
          </div>
        ) : aiAnalysisResult ? (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Tag color="blue">📊 分析系列数: {aiAnalysisResult.campaign_count}</Tag>
                <Tag color="green">📅 分析日期: {aiAnalysisResult.analysis_date}</Tag>
              </Space>
            </div>
            <div 
              style={{ 
                background: '#f5f5f5', 
                padding: 16, 
                borderRadius: 8,
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
                fontSize: 13,
                lineHeight: 1.6
              }}
            >
              {aiAnalysisResult.analysis}
            </div>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
            <RobotOutlined style={{ fontSize: 48, marginBottom: 16 }} />
            <p>选择一条 L7D 分析结果，点击"生成报告"按钮</p>
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
            const groupedByUser = filteredResults.reduce((acc, result) => {
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

                      // 获取所有键，但在L7D分析中过滤掉"ROI"、"点击"、"订单"（操作指令之后的列）
                      const allKeys = Object.keys(data[0])
                      const keysToShow = analysisMode === 'l7d' 
                        ? allKeys.filter(key => !['ROI', '点击', '订单'].includes(key))
                        : allKeys
                      
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

                        // 为操作指令列添加特殊渲染
                        if (key === '操作指令') {
                          column.width = 200
                          column.ellipsis = false
                          column.render = (text) => {
                            if (!text || text === '-') return '-'
                            const t = String(text)
                            let color = 'default'
                            // 根据操作指令内容设置颜色
                            if (t.includes('关停') || t.includes('PAUSE')) {
                              color = 'red'
                            } else if (t.includes('降价')) {
                              color = 'orange'
                            } else if (t.includes('预算') || t.includes('加产')) {
                              color = 'green'
                            } else if (t.includes('CPC+') || t.includes('抢占')) {
                              color = 'cyan'
                            } else if (t.includes('稳定') || t.includes('维持')) {
                              color = 'blue'
                            } else if (t.includes('样本不足') || t.includes('观察')) {
                              color = 'default'
                            }
                            return <Tag color={color} style={{ fontSize: '13px' }}>{t}</Tag>
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
            dataSource={filteredResults}
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

              // 获取所有键，但在L7D分析中过滤掉"ROI"、"点击"、"订单"（操作指令之后的列）
              const allKeys = Object.keys(data[0])
              const keysToShow = analysisMode === 'l7d' 
                ? allKeys.filter(key => !['ROI', '点击', '订单'].includes(key))
                : allKeys

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

                // 为操作指令列添加特殊渲染
                if (key === '操作指令') {
                  column.width = 200
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text || text === '-') return '-'
                    const t = String(text)
                    let color = 'default'
                    // 根据操作指令内容设置颜色
                    if (t.includes('关停') || t.includes('PAUSE')) {
                      color = 'red'
                    } else if (t.includes('降价')) {
                      color = 'orange'
                    } else if (t.includes('预算') || t.includes('加产')) {
                      color = 'green'
                    } else if (t.includes('CPC+') || t.includes('抢占')) {
                      color = 'cyan'
                    } else if (t.includes('稳定') || t.includes('维持')) {
                      color = 'blue'
                    } else if (t.includes('样本不足') || t.includes('观察')) {
                      color = 'default'
                    }
                    return <Tag color={color} style={{ fontSize: '13px' }}>{t}</Tag>
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
    </div>
  )
}

export default Analysis




