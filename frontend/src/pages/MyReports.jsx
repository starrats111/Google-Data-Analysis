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

  // 渲染格式化的报告内容 - 简洁版
  const renderFormattedReport = (content) => {
    if (!content) return null

    // 简单的格式化渲染
    const formatContent = (text) => {
      // 处理标题行（# 开头）
      let formatted = text
        // 大标题
        .replace(/^### (.+)$/gm, '<div style="font-size:16px;font-weight:bold;color:#1890ff;margin:16px 0 8px;padding-bottom:8px;border-bottom:1px solid #e8e8e8">$1</div>')
        .replace(/^## (.+)$/gm, '<div style="font-size:17px;font-weight:bold;color:#262626;margin:20px 0 12px">$1</div>')
        .replace(/^# (.+)$/gm, '<div style="font-size:18px;font-weight:bold;color:#141414;margin:24px 0 16px">$1</div>')
        // 分隔线
        .replace(/^═+$/gm, '<div style="border-top:2px solid #e8e8e8;margin:16px 0"></div>')
        .replace(/^---$/gm, '<div style="border-top:1px dashed #d9d9d9;margin:12px 0"></div>')
        // 表格行（简化处理）
        .replace(/^\|(.+)\|$/gm, (match, content) => {
          const cells = content.split('|').map(c => c.trim())
          return `<div style="display:flex;gap:8px;padding:4px 0;font-size:13px;border-bottom:1px solid #f0f0f0">${cells.map(c => `<span style="flex:1">${c}</span>`).join('')}</div>`
        })
        // 【标题】格式
        .replace(/【([^】]+)】/g, '<span style="font-weight:bold;color:#1890ff">【$1】</span>')
        // 高亮标记
        .replace(/✅/g, '<span style="color:#52c41a">✅</span>')
        .replace(/❌/g, '<span style="color:#ff4d4f">❌</span>')
        .replace(/⚠️/g, '<span style="color:#fa8c16">⚠️</span>')
        .replace(/🔴/g, '<span style="color:#ff4d4f">🔴</span>')
        .replace(/🟡/g, '<span style="color:#fa8c16">🟡</span>')
        .replace(/🟢/g, '<span style="color:#52c41a">🟢</span>')
        .replace(/🏆/g, '<span style="color:#faad14">🏆</span>')
        .replace(/\[✓\]/g, '<span style="color:#52c41a;font-weight:bold">[✓]</span>')
        .replace(/\[✗\]/g, '<span style="color:#ff4d4f;font-weight:bold">[✗]</span>')
        // 级别标签
        .replace(/级别[：:]\s*(S)/g, '<span>级别：</span><span style="background:#52c41a;color:white;padding:2px 8px;border-radius:4px;font-weight:bold">S</span>')
        .replace(/级别[：:]\s*(B)/g, '<span>级别：</span><span style="background:#fa8c16;color:white;padding:2px 8px;border-radius:4px;font-weight:bold">B</span>')
        .replace(/级别[：:]\s*(D)/g, '<span>级别：</span><span style="background:#ff4d4f;color:white;padding:2px 8px;border-radius:4px;font-weight:bold">D</span>')
        // 动作高亮（CPC/预算调整）
        .replace(/动作[：:]\s*(.+)/g, (match, action) => {
          if (action.includes('PAUSE') || action.includes('关停')) {
            return `<div style="background:#fff2f0;border:1px solid #ffccc7;padding:8px 12px;border-radius:6px;margin:4px 0"><strong style="color:#ff4d4f">动作：</strong>${action}</div>`
          } else if (action.includes('CPC') || action.includes('预算')) {
            return `<div style="background:#e6f7ff;border:1px solid #91d5ff;padding:8px 12px;border-radius:6px;margin:4px 0"><strong style="color:#1890ff">动作：</strong>${action}</div>`
          }
          return `<div style="margin:4px 0"><strong>动作：</strong>${action}</div>`
        })
        // 字段标签
        .replace(/^(检验|诊断|效果|验证|升降|D级检查)[：:]/gm, '<strong style="color:#595959">$1：</strong>')
        // 换行
        .replace(/\n/g, '<br/>')

      return formatted
    }

    return (
      <div 
        style={{ 
          fontSize: 14, 
          lineHeight: 1.9, 
          color: '#333',
          maxHeight: 'calc(100vh - 300px)',
          overflowY: 'auto',
          padding: '0 4px'
        }}
        dangerouslySetInnerHTML={{ __html: formatContent(content) }}
      />
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

