import React, { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Table,
  Button,
  Select,
  Space,
  Tag,
  message,
  Modal,
  Tooltip,
  Typography,
  Alert,
  Spin,
  InputNumber,
  Popconfirm,
  Collapse,
  Badge,
} from 'antd'
import {
  SyncOutlined,
  SettingOutlined,
  DollarOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  QuestionCircleOutlined,
  RightOutlined,
} from '@ant-design/icons'
import api from '../utils/api'
import './BidManagement.css'

const { Title, Text, Paragraph } = Typography
const { Panel } = Collapse

const BidManagement = () => {
  const [loading, setLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [mccList, setMccList] = useState([])
  const [selectedMcc, setSelectedMcc] = useState(null)
  const [strategies, setStrategies] = useState([])
  const [keywords, setKeywords] = useState([])
  const [selectedCampaign, setSelectedCampaign] = useState(null)
  const [changeToManualLoading, setChangeToManualLoading] = useState({})
  const [setCpcModalVisible, setSetCpcModalVisible] = useState(false)
  const [selectedKeyword, setSelectedKeyword] = useState(null)
  const [newCpcValue, setNewCpcValue] = useState(null)
  const [setCpcLoading, setSetCpcLoading] = useState(false)

  // 加载MCC列表
  const loadMccList = useCallback(async () => {
    try {
      const response = await api.get('/api/mcc/accounts')
      setMccList(response.data || [])
      if (response.data?.length > 0 && !selectedMcc) {
        setSelectedMcc(response.data[0].id)
      }
    } catch (error) {
      console.error('加载MCC列表失败:', error)
    }
  }, [selectedMcc])

  // 加载出价策略
  const loadStrategies = useCallback(async () => {
    if (!selectedMcc) return
    setLoading(true)
    try {
      const response = await api.get('/api/bids/strategies', {
        params: { mcc_id: selectedMcc }
      })
      setStrategies(response.data || [])
    } catch (error) {
      console.error('加载出价策略失败:', error)
      message.error('加载出价策略失败')
    } finally {
      setLoading(false)
    }
  }, [selectedMcc])

  // 加载关键词出价
  const loadKeywords = useCallback(async (campaignId) => {
    if (!selectedMcc) return
    setLoading(true)
    try {
      const response = await api.get('/api/bids/keywords', {
        params: { 
          mcc_id: selectedMcc,
          campaign_id: campaignId || undefined
        }
      })
      setKeywords(response.data || [])
    } catch (error) {
      console.error('加载关键词出价失败:', error)
      message.error('加载关键词出价失败')
    } finally {
      setLoading(false)
    }
  }, [selectedMcc])

  useEffect(() => {
    loadMccList()
  }, [loadMccList])

  useEffect(() => {
    if (selectedMcc) {
      loadStrategies()
      loadKeywords()
    }
  }, [selectedMcc, loadStrategies, loadKeywords])

  // 同步出价数据
  const handleSync = async () => {
    if (!selectedMcc) {
      message.warning('请先选择MCC账号')
      return
    }
    setSyncLoading(true)
    try {
      await api.post('/api/bids/sync', { mcc_id: selectedMcc })
      message.success('同步任务已启动，请稍后刷新查看')
    } catch (error) {
      console.error('同步失败:', error)
      message.error('同步失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setSyncLoading(false)
    }
  }

  // 改为人工出价
  const handleChangeToManual = async (record) => {
    setChangeToManualLoading({ ...changeToManualLoading, [record.campaign_id]: true })
    try {
      await api.post('/api/bids/change-to-manual', {
        mcc_id: selectedMcc,
        customer_id: record.customer_id,
        campaign_id: record.campaign_id
      })
      message.success('出价策略已切换为人工CPC')
      loadStrategies()
    } catch (error) {
      console.error('切换失败:', error)
      message.error('切换失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setChangeToManualLoading({ ...changeToManualLoading, [record.campaign_id]: false })
    }
  }

  // 设置关键词CPC
  const handleSetCpc = async () => {
    if (!selectedKeyword || !newCpcValue) return
    setSetCpcLoading(true)
    try {
      await api.post('/api/bids/set-keyword-cpc', {
        mcc_id: selectedMcc,
        customer_id: selectedKeyword.customer_id,
        ad_group_id: selectedKeyword.ad_group_id,
        criterion_id: selectedKeyword.criterion_id,
        cpc_amount: newCpcValue
      })
      message.success(`CPC已设置为 ${newCpcValue}`)
      setSetCpcModalVisible(false)
      setSelectedKeyword(null)
      setNewCpcValue(null)
      loadKeywords(selectedCampaign)
    } catch (error) {
      console.error('设置CPC失败:', error)
      message.error('设置CPC失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setSetCpcLoading(false)
    }
  }

  // 出价策略表格列
  const strategyColumns = [
    {
      title: '广告系列',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      width: 250,
      ellipsis: true,
    },
    {
      title: '出价策略',
      dataIndex: 'bidding_strategy_name',
      key: 'bidding_strategy_name',
      width: 200,
      render: (text, record) => (
        <Space>
          {record.is_manual_cpc ? (
            <Tag color="green">
              <CheckCircleOutlined /> {text || '人工CPC'}
            </Tag>
          ) : (
            <Tag color="orange">
              <SettingOutlined /> {text || record.bidding_strategy_type}
            </Tag>
          )}
        </Space>
      )
    },
    {
      title: '智能点击付费',
      dataIndex: 'enhanced_cpc_enabled',
      key: 'enhanced_cpc_enabled',
      width: 120,
      align: 'center',
      render: (enabled) => (
        enabled ? <Tag color="blue">已启用</Tag> : <Tag>已关闭</Tag>
      )
    },
    {
      title: '平均CPC',
      dataIndex: 'avg_cpc',
      key: 'avg_cpc',
      width: 100,
      align: 'right',
      render: (value) => value ? `$${value.toFixed(2)}` : '-'
    },
    {
      title: '出价上限',
      dataIndex: 'max_cpc_limit',
      key: 'max_cpc_limit',
      width: 100,
      align: 'right',
      render: (value) => value ? `$${value.toFixed(2)}` : '-'
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button
            size="small"
            onClick={() => {
              setSelectedCampaign(record.campaign_id)
              loadKeywords(record.campaign_id)
            }}
          >
            查看关键词
          </Button>
          {!record.is_manual_cpc && (
            <Popconfirm
              title="确认切换为人工CPC出价？"
              description="切换后需要手动设置每个关键词的出价"
              onConfirm={() => handleChangeToManual(record)}
              okText="确认"
              cancelText="取消"
            >
              <Button
                size="small"
                type="primary"
                danger
                loading={changeToManualLoading[record.campaign_id]}
              >
                改人工出价
              </Button>
            </Popconfirm>
          )}
        </Space>
      )
    }
  ]

  // 关键词出价表格列
  const keywordColumns = [
    {
      title: '广告系列',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      width: 180,
      ellipsis: true,
    },
    {
      title: '广告组',
      dataIndex: 'ad_group_name',
      key: 'ad_group_name',
      width: 150,
      ellipsis: true,
    },
    {
      title: '关键词',
      dataIndex: 'keyword_text',
      key: 'keyword_text',
      width: 200,
      render: (text, record) => (
        <Space>
          <Text>{text}</Text>
          <Tag>{record.match_type}</Tag>
        </Space>
      )
    },
    {
      title: '最高CPC',
      dataIndex: 'max_cpc',
      key: 'max_cpc',
      width: 100,
      align: 'right',
      render: (value) => (
        value > 0 ? (
          <Text strong style={{ color: '#1890ff' }}>${value.toFixed(2)}</Text>
        ) : (
          <Text type="secondary">自动出价</Text>
        )
      )
    },
    {
      title: '有效CPC',
      dataIndex: 'effective_cpc',
      key: 'effective_cpc',
      width: 100,
      align: 'right',
      render: (value) => value ? `$${value.toFixed(2)}` : '-'
    },
    {
      title: '平均CPC',
      dataIndex: 'avg_cpc',
      key: 'avg_cpc',
      width: 100,
      align: 'right',
      render: (value) => value ? `$${value.toFixed(2)}` : '-'
    },
    {
      title: '质量得分',
      dataIndex: 'quality_score',
      key: 'quality_score',
      width: 90,
      align: 'center',
      render: (value) => {
        if (!value) return '-'
        const color = value >= 7 ? 'green' : value >= 5 ? 'orange' : 'red'
        return <Badge count={value} style={{ backgroundColor: color }} />
      }
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (status) => (
        status === 'ENABLED' ? (
          <Tag color="green">启用</Tag>
        ) : (
          <Tag>{status}</Tag>
        )
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Button
          size="small"
          type="primary"
          icon={<DollarOutlined />}
          onClick={() => {
            setSelectedKeyword(record)
            setNewCpcValue(record.max_cpc || record.avg_cpc || 0.10)
            setSetCpcModalVisible(true)
          }}
        >
          设置CPC
        </Button>
      )
    }
  ]

  const selectedMccObj = mccList.find(m => m.id === selectedMcc)

  return (
    <div className="bid-management">
      <Card className="page-header-card">
        <Title level={3} style={{ marginBottom: 8 }}>出价管理</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          管理广告系列出价策略，查看和设置关键词最高CPC出价
        </Paragraph>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <Space style={{ marginBottom: 16 }}>
          <Select
            placeholder="选择MCC账号"
            value={selectedMcc}
            onChange={setSelectedMcc}
            style={{ width: 250 }}
            options={mccList.map(m => ({
              value: m.id,
              label: m.mcc_name || m.mcc_id
            }))}
          />
          <Button
            type="primary"
            icon={<SyncOutlined spin={syncLoading} />}
            onClick={handleSync}
            loading={syncLoading}
          >
            同步出价数据
          </Button>
        </Space>

        {strategies.length === 0 && !loading && (
          <Alert
            message="暂无出价数据"
            description="请点击【同步出价数据】按钮从Google Ads获取最新的出价策略和关键词CPC数据"
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        <Collapse
          defaultActiveKey={['strategies']}
          expandIconPosition="end"
          style={{ marginBottom: 16 }}
        >
          <Panel
            header={
              <Space>
                <SettingOutlined />
                <Text strong>广告系列出价策略</Text>
                <Tag>{strategies.length} 个广告系列</Tag>
              </Space>
            }
            key="strategies"
          >
            <Alert
              message="智能出价 vs 人工出价"
              description={
                <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                  <li><strong>人工CPC出价</strong>：您完全控制每个关键词的最高CPC，可逐个设置</li>
                  <li><strong>智能出价（最大化点击）</strong>：Google自动调整出价，无法手动设置关键词CPC</li>
                  <li>如需手动调整CPC，请先将广告系列改为"人工CPC出价"</li>
                </ul>
              }
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
            <Table
              columns={strategyColumns}
              dataSource={strategies}
              rowKey="id"
              loading={loading}
              pagination={{ pageSize: 10 }}
              scroll={{ x: 1100 }}
              size="small"
            />
          </Panel>

          <Panel
            header={
              <Space>
                <DollarOutlined />
                <Text strong>关键词CPC出价</Text>
                <Tag>{keywords.length} 个关键词</Tag>
                {selectedCampaign && (
                  <Tag color="blue">
                    已筛选广告系列
                    <Button 
                      type="link" 
                      size="small" 
                      style={{ padding: 0, marginLeft: 8 }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedCampaign(null)
                        loadKeywords()
                      }}
                    >
                      清除筛选
                    </Button>
                  </Tag>
                )}
              </Space>
            }
            key="keywords"
          >
            <Table
              columns={keywordColumns}
              dataSource={keywords}
              rowKey="id"
              loading={loading}
              pagination={{ pageSize: 20 }}
              scroll={{ x: 1200 }}
              size="small"
            />
          </Panel>
        </Collapse>

        {/* 教程折叠面板 */}
        <Collapse style={{ marginTop: 16 }}>
          <Panel
            header={
              <Space>
                <QuestionCircleOutlined />
                <Text>如何在 Google Ads 中查看"最高CPC"列？</Text>
              </Space>
            }
            key="tutorial"
          >
            <div className="tutorial-content">
              <Title level={5}>在 Google Ads 中添加"最高CPC"自定义列</Title>
              <ol>
                <li>登录 Google Ads 后台，进入<strong>关键字</strong>页面</li>
                <li>点击表格右上角的<strong>列</strong>图标（三条横线）</li>
                <li>选择<strong>修改列</strong></li>
                <li>在左侧找到<strong>竞价与预算</strong>类别</li>
                <li>勾选<strong>最高每次点击费用</strong>（Max. CPC）</li>
                <li>点击<strong>应用</strong>保存</li>
              </ol>
              <Alert
                message="注意"
                description="只有使用【人工CPC出价】策略的广告系列，才会显示关键词级别的最高CPC。智能出价策略下，CPC由Google自动调整。"
                type="warning"
                showIcon
                style={{ marginTop: 16 }}
              />
            </div>
          </Panel>
        </Collapse>
      </Card>

      {/* 设置CPC弹窗 */}
      <Modal
        title={`设置关键词CPC - ${selectedKeyword?.keyword_text}`}
        open={setCpcModalVisible}
        onCancel={() => {
          setSetCpcModalVisible(false)
          setSelectedKeyword(null)
          setNewCpcValue(null)
        }}
        onOk={handleSetCpc}
        confirmLoading={setCpcLoading}
        okText="确认设置"
        cancelText="取消"
      >
        {selectedKeyword && (
          <div>
            <Paragraph>
              <Text type="secondary">广告系列：</Text>
              <Text>{selectedKeyword.campaign_name}</Text>
            </Paragraph>
            <Paragraph>
              <Text type="secondary">广告组：</Text>
              <Text>{selectedKeyword.ad_group_name}</Text>
            </Paragraph>
            <Paragraph>
              <Text type="secondary">当前最高CPC：</Text>
              <Text strong>
                {selectedKeyword.max_cpc > 0 
                  ? `$${selectedKeyword.max_cpc.toFixed(2)}` 
                  : '自动出价'}
              </Text>
            </Paragraph>
            <Paragraph>
              <Text type="secondary">平均CPC：</Text>
              <Text>
                {selectedKeyword.avg_cpc 
                  ? `$${selectedKeyword.avg_cpc.toFixed(2)}` 
                  : '-'}
              </Text>
            </Paragraph>
            <div style={{ marginTop: 16 }}>
              <Text>新的最高CPC：</Text>
              <InputNumber
                prefix="$"
                value={newCpcValue}
                onChange={setNewCpcValue}
                min={0.01}
                max={100}
                step={0.01}
                precision={2}
                style={{ width: 150, marginLeft: 8 }}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default BidManagement

