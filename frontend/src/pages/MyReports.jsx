import React, { useState, useEffect } from 'react'
import { Card, Table, Space, message, Tag, Typography, Button, Modal, Spin, Empty, Tooltip, Input } from 'antd'
import { FileTextOutlined, DeleteOutlined, CopyOutlined, SettingOutlined, ArrowLeftOutlined, CloseOutlined, RobotOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

// 启用时区插件，确保使用本地时间
dayjs.extend(utc)
dayjs.extend(timezone)
import api from '../services/api'
import ReportViewer from '../components/ReportViewer/ReportViewer'
import './Analysis.css'

const { Title, Text, Paragraph } = Typography

const MyReports = () => {
  const navigate = useNavigate()
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
      render: (v) => v ? dayjs.utc(v).local().format('YYYY-MM-DD HH:mm') : '-',
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

  // 默认提示词模板（基于 excel/报告生成词.txt）
  const defaultPromptTemplate = `你是一位资深的 Google Ads 广告投放专家，请对以下广告系列进行专业分析报告。

请对每个广告系列进行：

1. 【阶段评价】
   - 对这个广告系列的过去表现进行总结
   - 评估当前所处阶段（起步期/成长期/成熟期/衰退期）

2. 【市场洞察】
   - 分析这个广告系列的商家在该投放国家的市场情况
   - 评估竞争环境和市场趋势

3. 【数据分析】
   - 分析CPC变化原因（为什么升高或降低）
   - 分析费用变化原因
   - 分析转化率和ROI表现
   - 指出需要关注的异常数据

4. 【未来展望】
   - 判断是否处于节日营销期
   - 评估是否需要加强广告创意（头图等）
   - 预测未来趋势

5. 【优化建议】
   - 提供推荐预算
   - 提供推荐CPC
   - 其他可执行的优化建议

请以专业、清晰、可执行的方式输出报告。`

  return (
    <div className="analysis-page">
      {/* 顶部返回按钮 */}
      <div style={{ marginBottom: 16 }}>
        <Button 
          type="link" 
          icon={<ArrowLeftOutlined />} 
          onClick={() => navigate(-1)}
          style={{ padding: 0, fontSize: 14 }}
        >
          返回上一页
        </Button>
      </div>
      
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
                        📅 {dayjs.utc(selectedReport.created_at).local().format('YYYY-MM-DD HH:mm')}
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
              background: '#f5f7fa'
            }}>
              <ReportViewer 
                content={selectedReport.content}
                campaignCount={selectedReport.campaign_count}
                analysisDate={dayjs.utc(selectedReport.created_at).local().format('YYYY-MM-DD HH:mm')}
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

