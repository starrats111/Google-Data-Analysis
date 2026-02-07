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

  // 解析操作指令
  const parseInstructions = (content) => {
    if (!content) return []
    
    // 匹配类似 "CPC 0.10→0.08" 或 "预算 $10.00→$15.00(+50%)" 的模式
    const regex = /(\w+)\s*([\d$.]+)\s*→\s*([\d$.]+)(\([+-]?\d+%\))?/g
    const instructions = []
    let match
    
    while ((match = regex.exec(content)) !== null) {
      instructions.push({
        type: match[1],
        from: match[2],
        to: match[3],
        change: match[4] || ''
      })
    }
    
    return instructions
  }

  const columns = [
    {
      title: '日期',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 120,
      render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: '广告系列数',
      dataIndex: 'campaign_count',
      key: 'campaign_count',
      width: 100,
      align: 'center',
      render: (v) => <Tag color="blue">{v || 0}</Tag>
    },
    {
      title: '执行指令预览',
      dataIndex: 'summary',
      key: 'summary',
      ellipsis: true,
      render: (_, record) => {
        const instructions = parseInstructions(record.content)
        if (instructions.length === 0) {
          return <Text type="secondary">-</Text>
        }
        return (
          <Space size={4} wrap>
            {instructions.slice(0, 3).map((inst, idx) => (
              <Tag key={idx} color={inst.type === 'CPC' ? 'orange' : 'green'}>
                {inst.type} {inst.from}→{inst.to}{inst.change}
              </Tag>
            ))}
            {instructions.length > 3 && <Text type="secondary">+{instructions.length - 3}条</Text>}
          </Space>
        )
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="查看报告">
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

  return (
    <div className="analysis-page">
      <div className="analysis-page__header">
        <div>
          <Title level={3} className="analysis-page__title">
            <FileTextOutlined style={{ marginRight: 8 }} />
            我的报告
          </Title>
          <Text className="analysis-page__subtitle">
            查看 AI 生成的广告分析报告，包含可执行的操作指令
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
                <Tag color="blue">📊 广告系列: {selectedReport.campaign_count}</Tag>
              </Space>
            </div>
            
            {/* 执行指令摘要 */}
            <Card 
              title="📋 执行指令摘要" 
              size="small" 
              style={{ marginBottom: 16 }}
              styles={{ body: { padding: 12 } }}
            >
              <Space wrap>
                {parseInstructions(selectedReport.content).map((inst, idx) => (
                  <Tag 
                    key={idx} 
                    color={inst.type === 'CPC' ? 'orange' : inst.type === '预算' ? 'green' : 'blue'}
                    style={{ fontSize: 13, padding: '4px 8px' }}
                  >
                    {inst.type} {inst.from}→{inst.to}{inst.change}
                  </Tag>
                ))}
              </Space>
            </Card>

            {/* 完整报告 */}
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

