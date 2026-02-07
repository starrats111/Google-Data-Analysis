import React, { useState, useEffect } from 'react'
import { Card, Table, Space, message, Tag, Typography, Button, Modal, Spin, Empty, Tooltip, Input } from 'antd'
import { FileTextOutlined, RobotOutlined, DeleteOutlined, CopyOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons'
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
        title={
          <Space>
            <FileTextOutlined />
            <span>AI 分析报告</span>
            {selectedReport && (
              <Tag color="blue">
                {dayjs(selectedReport.created_at).format('YYYY-MM-DD HH:mm')}
              </Tag>
            )}
          </Space>
        }
        open={reportModalOpen}
        onCancel={() => setReportModalOpen(false)}
        width={1000}
        footer={[
          <Button key="close" onClick={() => setReportModalOpen(false)}>
            关闭
          </Button>,
          <Button 
            key="copy" 
            type="primary"
            icon={<CopyOutlined />}
            onClick={copyReport}
          >
            复制报告
          </Button>
        ]}
        styles={{ body: { maxHeight: '70vh', overflow: 'auto' } }}
      >
        {selectedReport ? (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Tag color="blue">📊 共 {selectedReport.campaign_count} 个广告系列</Tag>
                <Tag color="green">📅 {dayjs(selectedReport.created_at).format('YYYY-MM-DD HH:mm')}</Tag>
              </Space>
            </div>

            {/* 完整报告 */}
            <div 
              style={{ 
                background: 'linear-gradient(135deg, #667eea05 0%, #764ba205 100%)',
                border: '1px solid #e8e8e8',
                padding: 20, 
                borderRadius: 12,
                whiteSpace: 'pre-wrap',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
                fontSize: 14,
                lineHeight: 1.8
              }}
            >
              {selectedReport.content}
            </div>
          </div>
        ) : (
          <Empty description="暂无报告内容" />
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

