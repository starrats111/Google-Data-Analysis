import React, { useState, useEffect } from 'react'
import { Steps, Card, Button, Space, Table, Input, InputNumber, Select, message, Spin, Typography, Tag, Alert, Row, Col } from 'antd'
import { ThunderboltOutlined, SearchOutlined, RocketOutlined } from '@ant-design/icons'
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

  // Step 1: 关键词研究
  const [keywordUrl, setKeywordUrl] = useState(merchantUrl)
  const [seedKeywords, setSeedKeywords] = useState('')
  const [keywordResults, setKeywordResults] = useState([])
  const [selectedKeywords, setSelectedKeywords] = useState([])

  // Step 2: AI 素材
  const [adCopy, setAdCopy] = useState({ headlines: [], descriptions: [] })
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
      const list = res.data || []
      setMccList(list)
      if (list.length === 1) {
        setSelectedMcc(list[0].id)
      }
    }).catch(() => {})
  }, [])

  // Step 0: 选择 MCC 后自动查找空闲 CID
  const handleSelectMcc = async (mccId) => {
    setSelectedMcc(mccId)
    setLoading(true)
    try {
      const res = await api.post('/api/ad-creation/find-available-cid', { mcc_id: mccId })
      setAvailableCid(res.data.customer_id)
      // 只有 1 个 MCC 时自动跳到下一步
      if (mccList.length === 1) setStep(1)
    } catch (err) {
      message.error(err?.response?.data?.detail || '查找 CID 失败')
    } finally { setLoading(false) }
  }

  // 自动触发（只有 1 个 MCC）
  useEffect(() => {
    if (mccList.length === 1 && mccList[0].id && !selectedMcc) {
      handleSelectMcc(mccList[0].id)
    }
  }, [mccList])

  // Step 1: 关键词研究
  const handleKeywordResearch = async () => {
    if (!keywordUrl && !seedKeywords) { message.warning('请输入网址或关键词'); return }
    setLoading(true)
    try {
      const res = await api.post('/api/ad-creation/keyword-ideas', {
        mcc_id: selectedMcc,
        customer_id: availableCid,
        url: keywordUrl || undefined,
        keywords: seedKeywords ? seedKeywords.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      })
      setKeywordResults(res.data.keywords || [])
      // 自动选择前 10 个
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
        merchant_url: merchantUrl,
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
        merchant_url: merchantUrl,
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
              <Space direction="vertical" style={{ width: '100%' }}>
                <Select
                  style={{ width: 400 }}
                  placeholder="选择 MCC 账号"
                  value={selectedMcc}
                  onChange={handleSelectMcc}
                  options={mccList.map(m => ({ value: m.id, label: `${m.name} (${m.mcc_id})` }))}
                />
                {availableCid && (
                  <Alert type="success" message={`空闲 CID: ${availableCid}`} />
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
                  <Input placeholder="商家网址" value={keywordUrl} onChange={e => setKeywordUrl(e.target.value)} />
                </Col>
                <Col span={12}>
                  <Input placeholder="种子关键词（逗号分隔）" value={seedKeywords} onChange={e => setSeedKeywords(e.target.value)} />
                </Col>
              </Row>
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
