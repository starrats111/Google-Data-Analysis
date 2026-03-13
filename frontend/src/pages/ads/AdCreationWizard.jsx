import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Steps, Card, Button, Space, Table, Input, InputNumber, Select, message, Spin, Typography, Tag, Alert, Row, Col, Divider, Collapse } from 'antd'
import { ThunderboltOutlined, SearchOutlined, RocketOutlined, LinkOutlined, BulbOutlined, LoadingOutlined, CheckCircleOutlined, GlobalOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../services/api'
import { getToken } from '../../services/tokenHolder'

const { TextArea } = Input

const COUNTRY_LABELS = {
  US: '美国', UK: '英国', CA: '加拿大', AU: '澳大利亚',
  DE: '德国', FR: '法国', JP: '日本', BR: '巴西',
}

export default function AdCreationWizard() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const assignmentId = searchParams.get('assignment_id')
  const merchantName = searchParams.get('merchant_name') || ''
  const merchantUrl = searchParams.get('merchant_url') || ''

  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)

  // Assignment details (from claim)
  const [targetCountry, setTargetCountry] = useState('US')
  const [assignmentMode, setAssignmentMode] = useState('test')

  // Step 0: MCC 选择
  const [mccList, setMccList] = useState([])
  const [selectedMcc, setSelectedMcc] = useState(null)
  const [availableCid, setAvailableCid] = useState('')
  const [allCids, setAllCids] = useState([])
  const [busyCids, setBusyCids] = useState([])
  const [cidError, setCidError] = useState('')

  // Step 1: 关键词研究
  const [keywordUrl, setKeywordUrl] = useState(merchantUrl)
  const [semrushUrl, setSemrushUrl] = useState('')
  const [seedKeywords, setSeedKeywords] = useState('')
  const [keywordResults, setKeywordResults] = useState([])
  const [selectedKeywords, setSelectedKeywords] = useState([])
  const autoResearchDone = useRef(false)

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

  // Step 3: 预算设置
  const [dailyBudget, setDailyBudget] = useState(10)

  // Step 4: 确认 & 创建
  const [createResult, setCreateResult] = useState(null)

  // 加载 MCC 列表
  useEffect(() => {
    api.get('/api/ad-creation/mcc-accounts').then(res => {
      setMccList(res.data || [])
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
    setLoading(true)
    try {
      const res = await api.post('/api/ad-creation/find-available-cid', { mcc_id: mccId })
      const data = res.data || {}
      const cidList = data.all_cids || []
      const busyList = data.busy_cids || []
      const recommended = data.customer_id || cidList[0] || ''
      setAllCids(cidList)
      setBusyCids(busyList)
      setAvailableCid(recommended)
      if (mccList.length === 1 && cidList.length <= 1 && recommended) setStep(1)
    } catch (err) {
      setCidError(err?.response?.data?.detail || err?.message || '查找 CID 失败')
    } finally { setLoading(false) }
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
      setKeywordResults(res.data.keywords || [])
      const top10 = (res.data.keywords || []).slice(0, 10).map(k => k.keyword)
      setSelectedKeywords(top10)
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
                setDailyBudget(r.recommended_budget)
              }
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
      const res = await api.post('/api/ad-creation/create-campaign', {
        assignment_id: parseInt(assignmentId),
        mcc_id: selectedMcc,
        customer_id: availableCid,
        merchant_name: merchantName,
        merchant_url: keywordUrl || merchantUrl,
        keywords: selectedKeywords,
        headlines: editHeadlines,
        descriptions: editDescriptions,
        daily_budget: dailyBudget,
        target_country: targetCountry,
        mode: assignmentMode,
      })
      setCreateResult(res.data)
      message.success('广告创建成功！')
    } catch (err) {
      message.error(err?.response?.data?.detail || '广告创建失败')
    } finally { setLoading(false) }
  }

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
    { title: '选择 MCC' },
    { title: '关键词研究' },
    { title: 'AI 智能文案' },
    { title: '日预算' },
    { title: '确认创建' },
  ]

  return (
    <div style={{ padding: 24 }}>
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
      </Typography.Title>

      <Steps current={step} items={steps} style={{ marginBottom: 24 }} />

      <Spin spinning={loading}>
        {/* Step 0: 选择 MCC */}
        {step === 0 && (
          <Card title="选择 MCC 账号">
            {mccList.length === 0 ? (
              <Alert type="warning" message="您还没有绑定 MCC 账号，请先在设置中添加" />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <div>
                  <Typography.Text strong style={{ marginRight: 8 }}>MCC 账号</Typography.Text>
                  <Select
                    style={{ width: 400 }}
                    placeholder="选择 MCC 账号"
                    value={selectedMcc}
                    onChange={handleSelectMcc}
                    options={mccList.map(m => ({ value: m.id, label: `${m.name} (${m.mcc_id})` }))}
                  />
                </div>
                {cidError && (
                  <Alert
                    type="error"
                    message="CID 查找失败"
                    description={cidError}
                    action={<Button size="small" onClick={() => handleSelectMcc(selectedMcc)}>重试</Button>}
                  />
                )}
                {allCids.length > 0 && (
                  <div>
                    <Typography.Text strong style={{ marginRight: 8 }}>客户账号 (CID)</Typography.Text>
                    <Select
                      style={{ width: 400 }}
                      placeholder="选择客户账号"
                      value={availableCid || undefined}
                      onChange={(v) => { setAvailableCid(v); setCidError(''); }}
                      options={allCids.map(cid => ({
                        value: cid,
                        label: busyCids.includes(cid) ? `${cid}（有广告运行中）` : `${cid}（空闲）`,
                      }))}
                    />
                    {availableCid && busyCids.includes(availableCid) && (
                      <Alert type="info" message="该 CID 已有广告系列在运行，新广告将在同一客户账号下创建" style={{ marginTop: 8 }} />
                    )}
                    {availableCid && !busyCids.includes(availableCid) && (
                      <Alert type="success" message={`CID ${availableCid} 为空闲状态`} style={{ marginTop: 8 }} />
                    )}
                  </div>
                )}
                <Button type="primary" disabled={!availableCid} onClick={() => setStep(1)}>下一步</Button>
              </Space>
            )}
          </Card>
        )}

        {/* Step 1: 关键词研究 */}
        {step === 1 && (
          <Card title="关键词研究">
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
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
              <Button type="primary" icon={<SearchOutlined />} onClick={handleKeywordResearch}>研究关键词</Button>
              {keywordResults.length > 0 && (
                <>
                  <Table
                    dataSource={keywordResults}
                    columns={keywordColumns}
                    rowKey="keyword"
                    size="small"
                    pagination={{ pageSize: 20 }}
                    rowSelection={{
                      selectedRowKeys: selectedKeywords,
                      onChange: setSelectedKeywords,
                    }}
                  />
                  <Space>
                    <Button onClick={() => setStep(0)}>上一步</Button>
                    <Button type="primary" disabled={selectedKeywords.length === 0} onClick={() => { setStep(2); handleGenerateAdCopyStream() }}>
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
          <Card title="AI 智能文案生成">
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
                     streamPhase === 'analyzing' ? '正在分析历史数据...' :
                     streamPhase === 'history' ? '历史数据分析完成' :
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
                  <Alert
                    type="warning"
                    message="Google 政策提示"
                    description="以下文案已按照 Google Ads 政策生成。请在编辑时继续遵守规则，避免广告被拒绝。"
                    style={{ fontSize: 12 }}
                  />
                  <Divider style={{ margin: '4px 0' }} />
                  <Typography.Text strong>标题（最多 15 个，每个 ≤ 30 字符）</Typography.Text>
                  {editHeadlines.map((h, i) => (
                    <div key={`h-${i}`} style={{ marginBottom: 4 }}>
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
                        <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 12 }}>
                          译：{headlineTranslations[i]}
                        </Typography.Text>
                      )}
                    </div>
                  ))}
                  <Divider style={{ margin: '8px 0' }} />
                  <Typography.Text strong>描述（最多 4 个，每个 ≤ 90 字符）</Typography.Text>
                  {editDescriptions.map((d, i) => (
                    <div key={`d-${i}`} style={{ marginBottom: 4 }}>
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
                        <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 12 }}>
                          译：{descTranslations[i]}
                        </Typography.Text>
                      )}
                    </div>
                  ))}
                  <Space>
                    <Button onClick={() => setStep(1)}>上一步</Button>
                    <Button type="primary" onClick={() => setStep(3)}>
                      下一步：设置日预算{recommendedBudget ? `（AI 建议 $${recommendedBudget}）` : ''}
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

        {/* Step 3: 日预算 */}
        {step === 3 && (
          <Card title="日预算设置">
            <Space direction="vertical" size={16}>
              <div>
                <Typography.Text strong>日预算（USD）</Typography.Text>
                <InputNumber min={1} max={1000} value={dailyBudget} onChange={setDailyBudget} style={{ marginLeft: 12, width: 120 }} />
                {recommendedBudget && (
                  <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
                    AI 建议: ${recommendedBudget}
                  </Typography.Text>
                )}
              </div>
              <div>
                <Typography.Text strong>投放国家: </Typography.Text>
                <Tag color="cyan">{COUNTRY_LABELS[targetCountry] || targetCountry}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>（领取商家时已确定）</Typography.Text>
              </div>
              <Space>
                <Button onClick={() => setStep(2)}>上一步</Button>
                <Button type="primary" onClick={() => setStep(4)}>下一步：确认创建</Button>
              </Space>
            </Space>
          </Card>
        )}

        {/* Step 4: 确认 & 创建 */}
        {step === 4 && (
          <Card title="确认创建">
            {createResult ? (
              <Alert
                type="success"
                message="广告创建成功！"
                description={`广告系列 ID: ${createResult.campaign_id}，数据将在次日同步后显示。`}
                action={<Button type="primary" onClick={() => navigate('/ads/test-dashboard')}>查看测试看板</Button>}
              />
            ) : (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Typography.Text>商家：<Tag color="blue">{merchantName}</Tag></Typography.Text>
                <Typography.Text>MCC：{mccList.find(m => m.id === selectedMcc)?.mcc_id}</Typography.Text>
                <Typography.Text>CID：{availableCid}</Typography.Text>
                <Typography.Text>投放国家：<Tag color="cyan">{COUNTRY_LABELS[targetCountry] || targetCountry}</Tag></Typography.Text>
                <Typography.Text>模式：<Tag color={assignmentMode === 'test' ? 'orange' : 'green'}>{assignmentMode === 'test' ? '测试' : '正式'}</Tag></Typography.Text>
                <Typography.Text>关键词：{selectedKeywords.length} 个</Typography.Text>
                <Typography.Text>标题：{editHeadlines.length} 个</Typography.Text>
                <Typography.Text>描述：{editDescriptions.length} 个</Typography.Text>
                <Typography.Text>日预算：${dailyBudget}</Typography.Text>
                <Space>
                  <Button onClick={() => setStep(3)}>上一步</Button>
                  <Button type="primary" icon={<RocketOutlined />} onClick={handleCreateAd}>创建广告</Button>
                </Space>
              </Space>
            )}
          </Card>
        )}
      </Spin>
    </div>
  )
}
