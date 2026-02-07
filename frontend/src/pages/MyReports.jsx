import React, { useState, useEffect } from 'react'
import { Card, Table, Space, message, Tag, Typography, Button, Modal, Spin, Empty, Tooltip, Input, Collapse, Divider } from 'antd'
import { FileTextOutlined, RobotOutlined, DeleteOutlined, CopyOutlined, SettingOutlined, RocketOutlined, LineChartOutlined, BulbOutlined, CalendarOutlined, WarningOutlined, TrophyOutlined, ArrowLeftOutlined, CloseOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import './Analysis.css'

const { Title, Text, Paragraph } = Typography

const MyReports = () => {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedReport, setSelectedReport] = useState(null)
  const [reportModalOpen, setReportModalOpen] = useState(false)
  
  // 提示词编辑
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [customPrompt, setCustomPrompt] = useState('')
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [loadingPrompt, setLoadingPrompt] = useState(false)

  // 获取报告列表
  const fetchReports = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/gemini/reports')
      setReports(response.data || [])
    } catch (error) {
      console.error('获取报告列表失败', error)
      // 如果 API 不存在，显示空列表
      setReports([])
    } finally {
      setLoading(false)
    }
  }

  // 查看报告详情
  const viewReport = (report) => {
    setSelectedReport(report)
    setReportModalOpen(true)
  }

  // 删除报告
  const deleteReport = async (reportId) => {
    try {
      await api.delete(`/api/gemini/reports/${reportId}`)
      message.success('删除成功')
      fetchReports()
    } catch (error) {
      message.error('删除失败')
    }
  }

  // 复制报告内容
  const copyReport = () => {
    if (selectedReport?.content) {
      navigator.clipboard.writeText(selectedReport.content)
      message.success('已复制到剪贴板')
    }
  }

  // 加载用户自定义提示词
  const loadCustomPrompt = async () => {
    setLoadingPrompt(true)
    try {
      const response = await api.get('/api/gemini/user-prompt')
      setCustomPrompt(response.data?.prompt || '')
    } catch (error) {
      // 如果没有自定义提示词，使用默认的
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

  useEffect(() => {
    fetchReports()
  }, [])

  // 渲染格式化的报告内容
  const renderFormattedReport = (content) => {
    if (!content) return null

    // 图标映射
    const sectionIcons = {
      '阶段评价': <TrophyOutlined style={{ color: '#faad14' }} />,
      '市场洞察': <LineChartOutlined style={{ color: '#1890ff' }} />,
      '数据': <LineChartOutlined style={{ color: '#52c41a' }} />,
      '节日': <CalendarOutlined style={{ color: '#eb2f96' }} />,
      '优化建议': <BulbOutlined style={{ color: '#722ed1' }} />,
      '风险': <WarningOutlined style={{ color: '#ff4d4f' }} />,
      '诊断': <SettingOutlined style={{ color: '#13c2c2' }} />,
      '动作': <RocketOutlined style={{ color: '#52c41a' }} />,
      '效果': <LineChartOutlined style={{ color: '#1890ff' }} />,
      '验证': <CalendarOutlined style={{ color: '#722ed1' }} />,
      '升降': <TrophyOutlined style={{ color: '#fa8c16' }} />,
      '检验': <SettingOutlined style={{ color: '#1890ff' }} />,
      '级别': <TrophyOutlined style={{ color: '#52c41a' }} />,
    }

    const getIcon = (title) => {
      for (const [key, icon] of Object.entries(sectionIcons)) {
        if (title.includes(key)) return icon
      }
      return <RocketOutlined style={{ color: '#1890ff' }} />
    }

    // 按广告系列分割
    // 支持 ###【系列名】 或 ### 系列名 或 ---\n【系列名】 格式
    const campaignPattern = /(?=###\s*【)|(?=###\s*\d)|(?=---\s*\n【)|(?=【[^\n]+】\s*\n级别)/g
    let sections = content.split(campaignPattern).filter(s => s.trim())
    
    // 如果没有找到分隔符，尝试按 --- 分割
    if (sections.length <= 1 && content.includes('---')) {
      sections = content.split(/---/).filter(s => s.trim() && s.length > 50)
    }
    
    // 提取概述部分（在第一个广告系列之前的内容）
    let overview = ''
    const firstCampaignIdx = content.search(/###\s*【|【[^\n]+】\s*\n级别/)
    if (firstCampaignIdx > 50) {
      overview = content.substring(0, firstCampaignIdx).trim()
      sections = sections.filter(s => !overview.includes(s.trim()))
    }

    // 解析单个广告系列的内容
    const parseCampaignContent = (text) => {
      const lines = text.split('\n').filter(l => l.trim())
      const result = []
      
      // 提取标题
      const titleMatch = text.match(/【([^\n】]+)】/)
      if (titleMatch) {
        result.push({ title: '系列名称', content: titleMatch[1], isTitle: true })
      }
      
      // 解析各个字段
      lines.forEach((line) => {
        const trimmedLine = line.trim()
        // 匹配 "字段：内容" 或 "字段: 内容" 格式
        const fieldMatch = trimmedLine.match(/^(级别|检验|D级检查|诊断|动作|效果|验证|升降)[：:]\s*(.+)$/i)
        if (fieldMatch) {
          result.push({
            title: fieldMatch[1],
            content: fieldMatch[2],
            isField: true
          })
        }
      })
      
      // 如果没有解析出字段，返回原始内容
      if (result.length <= 1) {
        return [{ title: '详情', content: text, isRaw: true }]
      }
      
      return result
    }

    // 渲染单个字段内容
    const renderFieldContent = (content, title) => {
      if (!content) return null
      
      // 高亮特定内容
      const highlightPatterns = [
        { pattern: /\[✓\]/g, color: '#52c41a', bg: '#f6ffed' },
        { pattern: /\[✗\]/g, color: '#ff4d4f', bg: '#fff2f0' },
        { pattern: /✅/g, color: '#52c41a', bg: '#f6ffed' },
        { pattern: /⚠️/g, color: '#fa8c16', bg: '#fffbe6' },
        { pattern: /❌/g, color: '#ff4d4f', bg: '#fff2f0' },
        { pattern: /🔴/g, color: '#ff4d4f', bg: '' },
        { pattern: /🟡/g, color: '#fa8c16', bg: '' },
        { pattern: /🟢/g, color: '#52c41a', bg: '' },
      ]
      
      // 特殊处理动作行（CPC/预算调整）
      if (title === '动作' && (content.includes('CPC') || content.includes('预算'))) {
        return (
          <div style={{ 
            background: 'linear-gradient(135deg, #e6f7ff 0%, #bae7ff 100%)', 
            padding: '12px 16px', 
            borderRadius: 8,
            border: '1px solid #91d5ff',
            fontWeight: 500
          }}>
            {content}
          </div>
        )
      }
      
      // 格式化内容
      let formattedContent = content
      highlightPatterns.forEach(({ pattern }) => {
        formattedContent = formattedContent.replace(pattern, (match) => match)
      })
      
      return (
        <div style={{ 
          fontSize: 13, 
          lineHeight: 1.8, 
          color: '#262626',
          wordBreak: 'break-word'
        }}>
          {formattedContent}
        </div>
      )
    }

    return (
      <div>
        {/* 概述部分 */}
        {overview && (
          <Card 
            style={{ marginBottom: 20, borderRadius: 12, background: '#fafafa' }}
            styles={{ body: { padding: '16px 20px' } }}
          >
            <Text style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {overview}
            </Text>
          </Card>
        )}

        {/* 广告系列分析 */}
        {sections.length > 0 ? (
          <Collapse 
            defaultActiveKey={['0']}
            style={{ background: 'transparent', border: 'none' }}
            items={sections.map((section, idx) => {
              const parsedContent = parseCampaignContent(section)
              const titleItem = parsedContent.find(p => p.isTitle)
              const campaignTitle = titleItem?.content || `广告系列 ${idx + 1}`
              const levelItem = parsedContent.find(p => p.title === '级别')
              
              // 根据级别设置颜色
              let levelColor = 'blue'
              if (levelItem?.content?.includes('S')) levelColor = 'green'
              else if (levelItem?.content?.includes('D')) levelColor = 'red'
              else if (levelItem?.content?.includes('B')) levelColor = 'orange'

              return {
                key: String(idx),
                label: (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
                    <Tag color="blue" style={{ margin: 0, fontWeight: 600 }}>{idx + 1}</Tag>
                    <Text strong style={{ fontSize: 14, flex: 1 }}>{campaignTitle}</Text>
                    {levelItem && (
                      <Tag color={levelColor} style={{ margin: 0 }}>
                        {levelItem.content}
                      </Tag>
                    )}
                  </div>
                ),
                children: (
                  <div style={{ padding: '8px 0' }}>
                    {parsedContent.filter(p => !p.isTitle).map((part, pIdx) => {
                      // 原始内容直接显示
                      if (part.isRaw) {
                        return (
                          <div key={pIdx} style={{ 
                            whiteSpace: 'pre-wrap', 
                            lineHeight: 1.8,
                            fontSize: 13,
                            color: '#595959',
                            padding: '8px 12px',
                            background: '#fafafa',
                            borderRadius: 8
                          }}>
                            {part.content}
                          </div>
                        )
                      }
                      
                      return (
                        <div key={pIdx} style={{ 
                          display: 'flex', 
                          marginBottom: 12,
                          alignItems: 'flex-start',
                          gap: 12
                        }}>
                          <div style={{ 
                            minWidth: 80, 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: 6,
                            paddingTop: 2
                          }}>
                            {getIcon(part.title)}
                            <Text strong style={{ fontSize: 13, color: '#595959' }}>
                              {part.title}
                            </Text>
                          </div>
                          <div style={{ flex: 1 }}>
                            {renderFieldContent(part.content, part.title)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ),
                style: {
                  marginBottom: 12,
                  background: 'white',
                  borderRadius: 12,
                  border: '1px solid #e8e8e8',
                  overflow: 'hidden'
                }
              }
            })}
          />
        ) : (
          // 如果没有解析出广告系列，直接显示原始内容
          <Card style={{ borderRadius: 12 }}>
            <div style={{ 
              whiteSpace: 'pre-wrap', 
              lineHeight: 1.8, 
              fontSize: 13,
              color: '#595959'
            }}>
              {content}
            </div>
          </Card>
        )}
      </div>
    )
  }

  const columns = [
    {
      title: '日期',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '广告系列数',
      dataIndex: 'campaign_count',
      key: 'campaign_count',
      width: 120,
      align: 'center',
      render: (v) => <Tag color="blue">{v || 0} 个系列</Tag>
    },
    {
      title: '报告摘要',
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (content) => {
        if (!content) return <Text type="secondary">-</Text>
        // 提取第一段作为摘要
        const firstLine = content.split('\n').find(line => line.trim() && !line.startsWith('#'))
        return <Text type="secondary">{firstLine?.substring(0, 80) || '-'}...</Text>
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="查看完整报告">
            <Button 
              type="primary" 
              ghost 
              size="small" 
              icon={<FileTextOutlined />}
              onClick={() => viewReport(record)}
            >
              查看
            </Button>
          </Tooltip>
          <Tooltip title="删除">
            <Button 
              danger 
              size="small" 
              icon={<DeleteOutlined />}
              onClick={() => deleteReport(record.id)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  // 默认提示词模板（基于 excel/分析提示词.txt）
  const defaultPromptTemplate = `# Google Ads 品牌词套利审计提示词（v5 强制完整版）

你是资深 Google Ads 品牌词直连套利操盘手。对表格中每个广告系列做全量审计与分级，输出可执行方案。

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
【分级规则】
══════════════════════════════════════
▶ S级：必须同时满足
  ① ROI ≥ 3.0  ② 不倒挂  ③ 出单天数 ≥ 5  ④ 样本🟢

▶ D级：满足任一
  ① ROI ≤ 0 且 样本🟢
  ② 倒挂幅度 ≥ 0.05 且 ROI < 1.0 且 样本🟢
  ③ L7D点击 ≥ 100 且 出单 = 0
  ④ 保守EPC = 0

▶ B级：不满足S也不触发D

══════════════════════════════════════
【动作规则】
══════════════════════════════════════
▶ S级：Budget丢失>60%预算×2.0，40-60%预算×1.3，Rank丢失>60%加CPC至红线×0.9
▶ B级：倒挂→降CPC至红线；样本🔴🟡→预算×1.3
▶ D级：立即PAUSE

══════════════════════════════════════
【输出格式】
══════════════════════════════════════
对每个系列输出以下字段：
---
【系列名称】
级别：S / B / D
检验：ROI=X.XX[✓/✗] | 不倒挂[✓/✗] | 出单≥5[✓/✗] | 样本🟢[✓/✗]
诊断：日均X.X(🔴/🟡/🟢) | 红线$X.XX | 倒挂幅度$X.XX | Budget丢失X%/Rank丢失X%
动作：CPC $X.XX→$X.XX | 预算 $X.XX→$X.XX(+X%)
效果：预期日点击=X | 预期ROI:X.XX
---

上图表格是待审计的广告系列数据，请开始审计：`

  return (
    <div className="analysis-page">
      <div className="analysis-page__header">
        <div>
          <Title level={3} className="analysis-page__title">
            <FileTextOutlined style={{ marginRight: 8 }} />
            我的报告
          </Title>
          <Text className="analysis-page__subtitle">
            查看 AI 生成的专业广告分析报告，包含阶段评价、市场洞察和优化建议
          </Text>
        </div>
        <Space>
          <Button 
            icon={<SettingOutlined />} 
            onClick={openPromptEditor}
          >
            自定义提示词
          </Button>
        </Space>
      </div>

      <Card styles={{ body: { paddingTop: 14 } }}>
        {reports.length === 0 && !loading ? (
          <Empty
            image={<RobotOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
            description={
              <span>
                暂无报告<br/>
                <Text type="secondary">在 L7D 分析页面点击"生成报告"按钮生成</Text>
              </span>
            }
          />
        ) : (
          <Table
            columns={columns}
            dataSource={reports}
            loading={loading}
            rowKey="id"
            size="middle"
            bordered
            pagination={{ 
              pageSize: 10, 
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`
            }}
          />
        )}
      </Card>

      {/* 报告详情 Modal */}
      <Modal
        title={null}
        open={reportModalOpen}
        onCancel={() => setReportModalOpen(false)}
        width={1100}
        footer={null}
        styles={{ 
          body: { padding: 0 },
          content: { borderRadius: 16, overflow: 'hidden' }
        }}
      >
        {selectedReport ? (
          <div>
            {/* 报告头部 */}
            <div style={{ 
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              padding: '24px 32px',
              color: 'white'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  {/* 返回按钮 */}
                  <Button 
                    type="text"
                    icon={<ArrowLeftOutlined style={{ fontSize: 20 }} />}
                    onClick={() => setReportModalOpen(false)}
                    style={{ 
                      color: 'white', 
                      width: 40, 
                      height: 40,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  />
                  <div>
                    <Title level={3} style={{ color: 'white', margin: 0, marginBottom: 8 }}>
                      <RobotOutlined style={{ marginRight: 12 }} />
                      AI 智能分析报告
                    </Title>
                    <Space size="middle">
                      <Tag color="rgba(255,255,255,0.2)" style={{ color: 'white', border: 'none' }}>
                        📊 {selectedReport.campaign_count} 个广告系列
                      </Tag>
                      <Tag color="rgba(255,255,255,0.2)" style={{ color: 'white', border: 'none' }}>
                        📅 {dayjs(selectedReport.created_at).format('YYYY-MM-DD HH:mm')}
                      </Tag>
                    </Space>
                  </div>
                </div>
                <Space>
                  <Button 
                    type="primary"
                    ghost
                    icon={<CopyOutlined />}
                    onClick={copyReport}
                    style={{ borderColor: 'white', color: 'white' }}
                  >
                    复制报告
                  </Button>
                  {/* 关闭按钮 */}
                  <Button 
                    type="text"
                    icon={<CloseOutlined style={{ fontSize: 18 }} />}
                    onClick={() => setReportModalOpen(false)}
                    style={{ 
                      color: 'white', 
                      width: 40, 
                      height: 40,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  />
                </Space>
              </div>
            </div>

            {/* 报告内容 */}
            <div style={{ 
              padding: '24px 32px', 
              maxHeight: '65vh', 
              overflow: 'auto',
              background: '#fafafa'
            }}>
              {renderFormattedReport(selectedReport.content)}
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
                onClick={() => setReportModalOpen(false)}
                size="large"
              >
                返回列表
              </Button>
              <Space>
                <Button 
                  icon={<CopyOutlined />}
                  onClick={copyReport}
                >
                  复制报告
                </Button>
                <Button 
                  onClick={() => setReportModalOpen(false)}
                >
                  关闭
                </Button>
              </Space>
            </div>
          </div>
        ) : (
          <Empty description="暂无报告内容" style={{ padding: 60 }} />
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
              提示：可以使用变量 {'{campaigns}'} 代表广告系列数据
            </Text>
          </div>
        </Spin>
      </Modal>
    </div>
  )
}

export default MyReports

