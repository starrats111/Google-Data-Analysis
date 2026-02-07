import React, { useState, useEffect } from 'react'
import { Card, Table, Space, message, Tag, Typography, Button, Modal, Spin, Empty, Tooltip, Input, Collapse, Divider } from 'antd'
import { FileTextOutlined, RobotOutlined, DeleteOutlined, CopyOutlined, SettingOutlined, RocketOutlined, LineChartOutlined, BulbOutlined, CalendarOutlined, WarningOutlined, TrophyOutlined } from '@ant-design/icons'
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

    // 按广告系列分割（以 ### 开头的行）
    const sections = content.split(/(?=###\s)/g).filter(s => s.trim())
    
    // 第一部分是概述
    const overview = sections[0]?.startsWith('###') ? null : sections.shift()
    
    // 图标映射
    const sectionIcons = {
      '阶段评价': <TrophyOutlined style={{ color: '#faad14' }} />,
      '市场洞察': <LineChartOutlined style={{ color: '#1890ff' }} />,
      '数据': <LineChartOutlined style={{ color: '#52c41a' }} />,
      '节日': <CalendarOutlined style={{ color: '#eb2f96' }} />,
      '优化建议': <BulbOutlined style={{ color: '#722ed1' }} />,
      '风险': <WarningOutlined style={{ color: '#ff4d4f' }} />,
    }

    const getIcon = (title) => {
      for (const [key, icon] of Object.entries(sectionIcons)) {
        if (title.includes(key)) return icon
      }
      return <RocketOutlined style={{ color: '#1890ff' }} />
    }

    // 解析单个广告系列的内容
    const parseCampaignContent = (text) => {
      const lines = text.split('\n')
      const result = []
      let currentSection = null
      let currentContent = []

      lines.forEach((line, idx) => {
        if (line.startsWith('####')) {
          // 保存之前的section
          if (currentSection) {
            result.push({ title: currentSection, content: currentContent.join('\n') })
          }
          currentSection = line.replace(/^#+\s*/, '').trim()
          currentContent = []
        } else if (currentSection) {
          currentContent.push(line)
        } else if (line.trim() && !line.startsWith('###')) {
          // 广告系列描述
          result.push({ title: '_intro', content: line })
        }
      })
      
      // 保存最后一个section
      if (currentSection) {
        result.push({ title: currentSection, content: currentContent.join('\n') })
      }

      return result
    }

    return (
      <div>
        {/* 概述部分 */}
        {overview && (
          <Card 
            style={{ marginBottom: 20, borderRadius: 12 }}
            styles={{ body: { padding: '16px 20px' } }}
          >
            <Text style={{ fontSize: 15, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {overview.trim()}
            </Text>
          </Card>
        )}

        {/* 广告系列分析 */}
        <Collapse 
          accordion 
          defaultActiveKey={['0']}
          style={{ background: 'transparent', border: 'none' }}
          items={sections.map((section, idx) => {
            const titleMatch = section.match(/^###\s*(.+)/)
            const campaignTitle = titleMatch ? titleMatch[1].trim() : `广告系列 ${idx + 1}`
            const campaignContent = section.replace(/^###\s*.+\n?/, '')
            const parsedContent = parseCampaignContent(campaignContent)

            return {
              key: String(idx),
              label: (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <Tag color="blue" style={{ margin: 0 }}>{idx + 1}</Tag>
                  <Text strong style={{ fontSize: 15 }}>{campaignTitle}</Text>
                </div>
              ),
              children: (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
                  {parsedContent.filter(p => p.title !== '_intro').map((part, pIdx) => (
                    <Card 
                      key={pIdx}
                      size="small"
                      title={
                        <Space>
                          {getIcon(part.title)}
                          <span>{part.title}</span>
                        </Space>
                      }
                      style={{ 
                        borderRadius: 10,
                        gridColumn: part.title.includes('数据') || part.title.includes('优化') ? 'span 2' : 'auto'
                      }}
                      styles={{ 
                        header: { borderBottom: '1px solid #f0f0f0', minHeight: 40 },
                        body: { padding: '12px 16px' }
                      }}
                    >
                      <div style={{ 
                        fontSize: 13, 
                        lineHeight: 1.8, 
                        whiteSpace: 'pre-wrap',
                        color: '#595959'
                      }}>
                        {part.content.split('\n').map((line, lIdx) => {
                          // 高亮关键信息
                          if (line.includes('推荐预算') || line.includes('推荐CPC')) {
                            return (
                              <div key={lIdx} style={{ 
                                background: '#e6f7ff', 
                                padding: '4px 8px', 
                                borderRadius: 4,
                                marginBottom: 4,
                                borderLeft: '3px solid #1890ff'
                              }}>
                                {line.replace(/^\*\s*/, '').replace(/\*\*/g, '')}
                              </div>
                            )
                          }
                          if (line.includes('风险') || line.includes('注意') || line.includes('警告')) {
                            return (
                              <div key={lIdx} style={{ 
                                background: '#fff2e8', 
                                padding: '4px 8px', 
                                borderRadius: 4,
                                marginBottom: 4,
                                borderLeft: '3px solid #fa8c16'
                              }}>
                                {line.replace(/^\*\s*/, '').replace(/\*\*/g, '')}
                              </div>
                            )
                          }
                          return <div key={lIdx}>{line.replace(/^\*\s*/, '• ').replace(/\*\*/g, '')}</div>
                        })}
                      </div>
                    </Card>
                  ))}
                  {/* 如果只有intro，显示整体内容 */}
                  {parsedContent.length === 0 && (
                    <Card size="small" style={{ gridColumn: 'span 2', borderRadius: 10 }}>
                      <Text style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
                        {campaignContent.trim()}
                      </Text>
                    </Card>
                  )}
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

  // 默认提示词模板
  const defaultPromptTemplate = `你是一位资深的跨境电商 Google Ads 投放专家，拥有10年+品牌词套利经验。请对以下广告系列数据进行深度分析，生成一份专业的广告投放分析报告。

## 报告结构要求

对于每个广告系列，请输出以下内容：

### 1. 阶段评价
- 该广告系列目前处于什么阶段（冷启动/成长期/成熟期/衰退期）
- 过去7天的整体表现总结

### 2. 市场洞察
- 该商家在投放国家的市场竞争情况
- 同类品牌词的竞价强度分析

### 3. 数据深度分析
- CPC变化原因分析（为什么上升/下降）
- 费用变化原因分析
- 点击率和转化率趋势
- ROI健康度评估

### 4. 节日营销预判
- 未来2-4周是否有重要节日
- 是否需要提前布局节日营销
- 是否需要优化头图/广告素材

### 5. 优化建议
- 推荐预算：$XX（原因说明）
- 推荐CPC：$X.XX（原因说明）
- 其他优化建议

### 6. 风险提示
- 需要关注的潜在风险
- 建议的监控指标

请用专业、详实的语言输出报告，不要输出简单的操作指令。`

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
                <Button 
                  type="primary"
                  ghost
                  icon={<CopyOutlined />}
                  onClick={copyReport}
                  style={{ borderColor: 'white', color: 'white' }}
                >
                  复制报告
                </Button>
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
              justifyContent: 'flex-end'
            }}>
              <Button onClick={() => setReportModalOpen(false)}>
                关闭
              </Button>
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

