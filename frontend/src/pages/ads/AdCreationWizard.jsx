import React, { useState, useEffect, useRef } from 'react'
import { Steps, Card, Button, Space, Table, Input, InputNumber, Select, message, Spin, Typography, Tag, Alert, Row, Col, Divider, Collapse } from 'antd'
import { ThunderboltOutlined, SearchOutlined, RocketOutlined, LinkOutlined, BulbOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../services/api'

const { TextArea } = Input

const COUNTRIES = [
  { value: 'US', label: '美国' },
  { value: 'UK', label: '英国' },
  { value: 'CA', label: '加拿大' },
  { value: 'AU', label: '澳大利亚' },
]

export default function AdCreationWizard() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const assignmentId = searchParams.get('assignment_id')
  const merchantName = searchParams.get('merchant_name') || ''
  const merchantUrl = searchParams.get('merchant_url') || ''

  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)

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

  // Step 2: AI 素材
  const [adCopy, setAdCopy] = useState({ headlines: [], descriptions: [], thinking: '' })
  const [editHeadlines, setEditHeadlines] = useState([])
  const [editDescriptions, setEditDescriptions] = useState([])

  // Step 3: 预算设置
  const [dailyBudget, setDailyBudget] = useState(10)
  const [targetCountry, setTargetCountry] = useState('US')

  // Step 4: 确认 & 创建
  const [createResult, setCreateResult] = useState(null)

  // 加载 MCC 列表
  useEffect(() => {
    api.get('/api/ad-creation/mcc-accounts').then(res => {
      setMccList(res.data || [])
    }).catch(() => {})
  }, [])

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
      const detail = err?.response?.data?.detail || err?.message || '查找 CID 失败'
      setCidError(detail)
    } finally { setLoading(false) }
  }

  // 只有 1 个 MCC 时自动触发 CID 查找
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
            keywords: undefined,
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

  // Step 1: 手动关键词研究
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

  // Step 2: AI 生成素材
  const handleGenerateAdCopy = async () => {
    setLoading(true)
    try {
      const kwData = keywordResults.filter(k => selectedKeywords.includes(k.keyword))
      const res = await api.post('/api/ad-creation/generate-ad-copy', {
        merchant_name: merchantName,
        merchant_url: keywordUrl || merchantUrl,
        keywords: kwData,
        language: 'en',
      })
      setAdCopy(res.data)
      setEditHeadlines([...(res.data.headlines || [])])
      setEditDescriptions([...(res.data.descriptions || [])])
    } catch (err) {
      message.error(err?.response?.data?.detail || 'AI 素材生成失败')
    } finally { setLoading(false) }
  }

  // Step 4: 创建广告
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
        mode: 'test',
      })
      setCreateResult(res.data)
      message.success('广告创建成功！')
    } catch (err) {
      message.error(err?.response?.data?.detail || '广告创建失败')
    } finally { setLoading(false) }
  }

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
    { title: 'AI 素材' },
    { title: '预算设置' },
    { title: '确认创建' },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={4}>
        <ThunderboltOutlined /> 广告创建向导
        {merchantName && <Tag color="blue" style={{ marginLeft: 12 }}>{merchantName}</Tag>}
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
                        如果自动研究无结果，可将 SemRush 网页上的链接粘贴到这里，系统会自动解析并查询关键词
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
                    <Button type="primary" disabled={selectedKeywords.length === 0} onClick={() => { setStep(2); handleGenerateAdCopy() }}>
                      下一步：生成广告素材（已选 {selectedKeywords.length} 个关键词）
                    </Button>
                  </Space>
                </>
              )}
            </Space>
          </Card>
        )}

        {/* Step 2: AI 素材 */}
        {step === 2 && (
          <Card title="AI 广告素材">
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {adCopy.thinking && (
                <Alert
                  type="info"
                  icon={<BulbOutlined />}
                  showIcon
                  message="AI 分析思路"
                  description={
                    <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                      {adCopy.thinking}
                    </Typography.Paragraph>
                  }
                  style={{ background: '#f0f5ff', border: '1px solid #adc6ff' }}
                />
              )}
              <Alert
                type="warning"
                message="Google 政策提示"
                description="以下文案已按照 Google Ads 政策生成：避免夸大宣传、误导性承诺、全大写文字和过度标点。请在编辑时继续遵守这些规则，以防止广告被拒绝。"
                style={{ fontSize: 12 }}
              />
              <Divider style={{ margin: '4px 0' }} />
              <Typography.Text strong>标题（最多 15 个，每个 ≤ 30 字符）</Typography.Text>
              {editHeadlines.map((h, i) => (
                <Input
                  key={`h-${i}`}
                  value={h}
                  maxLength={30}
                  suffix={`${h.length}/30`}
                  onChange={e => {
                    const arr = [...editHeadlines]
                    arr[i] = e.target.value
                    setEditHeadlines(arr)
                  }}
                />
              ))}
              <Typography.Text strong>描述（最多 4 个，每个 ≤ 90 字符）</Typography.Text>
              {editDescriptions.map((d, i) => (
                <TextArea
                  key={`d-${i}`}
                  value={d}
                  maxLength={90}
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  onChange={e => {
                    const arr = [...editDescriptions]
                    arr[i] = e.target.value
                    setEditDescriptions(arr)
                  }}
                />
              ))}
              <Space>
                <Button onClick={() => setStep(1)}>上一步</Button>
                <Button type="primary" onClick={() => setStep(3)}>下一步：预算设置</Button>
                <Button onClick={handleGenerateAdCopy}>重新生成</Button>
              </Space>
            </Space>
          </Card>
        )}

        {/* Step 3: 预算设置 */}
        {step === 3 && (
          <Card title="预算设置">
            <Space direction="vertical" size={16}>
              <div>
                <Typography.Text strong>日预算（USD）</Typography.Text>
                <InputNumber min={1} max={1000} value={dailyBudget} onChange={setDailyBudget} style={{ marginLeft: 12, width: 120 }} />
              </div>
              <div>
                <Typography.Text strong>投放国家</Typography.Text>
                <Select value={targetCountry} onChange={setTargetCountry} style={{ marginLeft: 12, width: 200 }} options={COUNTRIES} />
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
                <Typography.Text>关键词：{selectedKeywords.length} 个</Typography.Text>
                <Typography.Text>标题：{editHeadlines.length} 个</Typography.Text>
                <Typography.Text>描述：{editDescriptions.length} 个</Typography.Text>
                <Typography.Text>日预算：${dailyBudget}</Typography.Text>
                <Typography.Text>投放国家：{targetCountry}</Typography.Text>
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
