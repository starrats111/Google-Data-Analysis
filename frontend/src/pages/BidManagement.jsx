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
  Switch,
  Input,
  Form,
} from 'antd'
import {
  SyncOutlined,
  SettingOutlined,
  DollarOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  QuestionCircleOutlined,
  RightOutlined,
  PlusOutlined,
  EditOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import api from '../services/api'
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
  
  // 新增功能状态
  const [addKeywordModalVisible, setAddKeywordModalVisible] = useState(false)
  const [editKeywordModalVisible, setEditKeywordModalVisible] = useState(false)
  const [keywordToEdit, setKeywordToEdit] = useState(null)
  const [toggleStatusLoading, setToggleStatusLoading] = useState({})
  const [addKeywordLoading, setAddKeywordLoading] = useState(false)
  const [editKeywordLoading, setEditKeywordLoading] = useState(false)
  const [adGroups, setAdGroups] = useState([])
  const [adGroupsLoading, setAdGroupsLoading] = useState(false)
  const [addKeywordForm] = Form.useForm()
  const [editKeywordForm] = Form.useForm()
  
  // 批量操作状态
  const [selectedStrategies, setSelectedStrategies] = useState([])
  const [batchChangeLoading, setBatchChangeLoading] = useState(false)
  
  // 预算管理状态
  const [setBudgetModalVisible, setSetBudgetModalVisible] = useState(false)
  const [selectedCampaignForBudget, setSelectedCampaignForBudget] = useState(null)
  const [newBudgetValue, setNewBudgetValue] = useState(null)
  const [setBudgetLoading, setSetBudgetLoading] = useState(false)
  const [batchBudgetModalVisible, setBatchBudgetModalVisible] = useState(false)
  const [batchBudgetValue, setBatchBudgetValue] = useState(null)

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

  // 设置广告系列预算
  const handleSetBudget = async () => {
    if (!selectedCampaignForBudget || !newBudgetValue) return
    setSetBudgetLoading(true)
    try {
      await api.post('/api/bids/set-budget', {
        mcc_id: selectedMcc,
        customer_id: selectedCampaignForBudget.customer_id,
        campaign_id: selectedCampaignForBudget.campaign_id,
        new_budget: newBudgetValue
      })
      message.success(`每日预算已设置为 $${newBudgetValue.toFixed(2)}`)
      setSetBudgetModalVisible(false)
      setSelectedCampaignForBudget(null)
      setNewBudgetValue(null)
      loadStrategies()
    } catch (error) {
      console.error('设置预算失败:', error)
      message.error('设置预算失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setSetBudgetLoading(false)
    }
  }

  // 批量设置预算
  const handleBatchSetBudget = async () => {
    if (selectedStrategies.length === 0 || !batchBudgetValue) return
    setSetBudgetLoading(true)
    try {
      const campaigns = selectedStrategies.map(s => ({
        campaign_id: s.campaign_id,
        new_budget: batchBudgetValue
      }))
      
      const response = await api.post('/api/bids/batch-set-budget', {
        mcc_id: selectedMcc,
        customer_id: selectedStrategies[0].customer_id,
        campaigns
      })
      
      message.success(response.data.message)
      setBatchBudgetModalVisible(false)
      setBatchBudgetValue(null)
      setSelectedStrategies([])
      loadStrategies()
    } catch (error) {
      console.error('批量设置预算失败:', error)
      message.error('批量设置预算失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setSetBudgetLoading(false)
    }
  }

  // 切换关键词状态（启用/暂停）
  const handleToggleKeywordStatus = async (record) => {
    const newStatus = record.status === 'ENABLED' ? 'PAUSED' : 'ENABLED'
    setToggleStatusLoading({ ...toggleStatusLoading, [record.criterion_id]: true })
    try {
      const response = await api.post('/api/bids/toggle-keyword-status', {
        mcc_id: selectedMcc,
        customer_id: record.customer_id,
        ad_group_id: record.ad_group_id,
        criterion_id: record.criterion_id,
        new_status: newStatus
      })
      
      if (response.data.success) {
        message.success(`关键词已${newStatus === 'ENABLED' ? '启用' : '暂停'}`)
        loadKeywords(selectedCampaign)
      } else {
        // 处理否定关键词等特殊情况
        message.warning(response.data.message || '操作失败')
      }
    } catch (error) {
      console.error('切换状态失败:', error)
      const errorMsg = error.response?.data?.detail || error.message
      // 对常见错误给出友好提示
      if (errorMsg.includes('CANT_UPDATE_NEGATIVE') || errorMsg.includes('Negative')) {
        message.error('否定关键词不能更改状态，只能删除后重新添加')
      } else {
        message.error('切换状态失败: ' + errorMsg)
      }
    } finally {
      setToggleStatusLoading({ ...toggleStatusLoading, [record.criterion_id]: false })
    }
  }

  // 加载广告组列表
  const loadAdGroups = async () => {
    if (!selectedMcc) return
    setAdGroupsLoading(true)
    try {
      const response = await api.get('/api/bids/ad-groups', {
        params: { mcc_id: selectedMcc }
      })
      setAdGroups(response.data || [])
    } catch (error) {
      console.error('加载广告组失败:', error)
    } finally {
      setAdGroupsLoading(false)
    }
  }

  // 打开添加关键词弹窗
  const handleOpenAddKeywordModal = () => {
    loadAdGroups()
    addKeywordForm.resetFields()
    setAddKeywordModalVisible(true)
  }

  // 添加关键词
  const handleAddKeyword = async () => {
    try {
      const values = await addKeywordForm.validateFields()
      setAddKeywordLoading(true)
      
      // 找到选中的广告组信息
      const selectedAdGroup = adGroups.find(ag => ag.ad_group_id === values.ad_group_id)
      if (!selectedAdGroup) {
        message.error('请选择广告组')
        return
      }
      
      await api.post('/api/bids/add-keyword', {
        mcc_id: selectedMcc,
        customer_id: selectedAdGroup.customer_id,
        ad_group_id: values.ad_group_id,
        keyword_text: values.keyword_text,
        match_type: values.match_type,
        cpc_bid_micros: values.cpc_bid ? Math.round(values.cpc_bid * 1000000) : null
      })
      message.success(`关键词 "${values.keyword_text}" 添加成功`)
      setAddKeywordModalVisible(false)
      loadKeywords(selectedCampaign)
    } catch (error) {
      console.error('添加关键词失败:', error)
      message.error('添加关键词失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setAddKeywordLoading(false)
    }
  }

  // 打开编辑关键词弹窗
  const handleOpenEditKeywordModal = (record) => {
    setKeywordToEdit(record)
    editKeywordForm.setFieldsValue({
      keyword_text: record.keyword_text,
      match_type: record.match_type,
      cpc_bid: record.max_cpc || 0.10
    })
    setEditKeywordModalVisible(true)
  }

  // 修改关键词
  const handleEditKeyword = async () => {
    if (!keywordToEdit) return
    try {
      const values = await editKeywordForm.validateFields()
      setEditKeywordLoading(true)
      
      await api.post('/api/bids/update-keyword', {
        mcc_id: selectedMcc,
        customer_id: keywordToEdit.customer_id,
        ad_group_id: keywordToEdit.ad_group_id,
        criterion_id: keywordToEdit.criterion_id,
        keyword_text: values.keyword_text !== keywordToEdit.keyword_text ? values.keyword_text : null,
        match_type: values.match_type !== keywordToEdit.match_type ? values.match_type : null,
        cpc_bid_micros: Math.round(values.cpc_bid * 1000000)
      })
      message.success('关键词修改成功')
      setEditKeywordModalVisible(false)
      setKeywordToEdit(null)
      loadKeywords(selectedCampaign)
    } catch (error) {
      console.error('修改关键词失败:', error)
      message.error('修改关键词失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setEditKeywordLoading(false)
    }
  }

  // 批量改为人工出价
  const handleBatchChangeToManual = async () => {
    if (selectedStrategies.length === 0) {
      message.warning('请先选择需要转换的广告系列')
      return
    }
    
    // 过滤出非人工出价的广告系列
    const toConvert = selectedStrategies.filter(s => !s.is_manual_cpc)
    if (toConvert.length === 0) {
      message.info('所选广告系列已全部是人工出价')
      return
    }
    
    setBatchChangeLoading(true)
    let successCount = 0
    let failCount = 0
    
    for (const strategy of toConvert) {
      try {
        await api.post('/api/bids/change-to-manual', {
          mcc_id: selectedMcc,
          customer_id: strategy.customer_id,
          campaign_id: strategy.campaign_id
        })
        successCount++
      } catch (error) {
        console.error(`转换 ${strategy.campaign_name} 失败:`, error)
        failCount++
      }
    }
    
    setBatchChangeLoading(false)
    setSelectedStrategies([])
    
    if (failCount === 0) {
      message.success(`成功将 ${successCount} 个广告系列转为人工出价`)
    } else {
      message.warning(`转换完成: ${successCount} 成功, ${failCount} 失败`)
    }
    
    loadStrategies()
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
          <Button
            size="small"
            icon={<DollarOutlined />}
            onClick={() => {
              setSelectedCampaignForBudget(record)
              setNewBudgetValue(record.daily_budget || 50)
              setSetBudgetModalVisible(true)
            }}
          >
            改预算
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
          <Text strong style={{ color: '#4DA6FF' }}>${value.toFixed(2)}</Text>
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
      width: 100,
      render: (status, record) => (
        <Switch
          checked={status === 'ENABLED'}
          loading={toggleStatusLoading[record.criterion_id]}
          checkedChildren={<PlayCircleOutlined />}
          unCheckedChildren={<PauseCircleOutlined />}
          onChange={() => handleToggleKeywordStatus(record)}
        />
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="设置CPC">
            <Button
              size="small"
              type="primary"
              icon={<DollarOutlined />}
              onClick={() => {
                setSelectedKeyword(record)
                setNewCpcValue(record.max_cpc || record.avg_cpc || 0.10)
                setSetCpcModalVisible(true)
              }}
            />
          </Tooltip>
          <Tooltip title="编辑关键词">
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleOpenEditKeywordModal(record)}
            />
          </Tooltip>
        </Space>
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
            {/* 批量操作栏 - 选中时显示 */}
            {selectedStrategies.length > 0 && (
              <div style={{ 
                marginBottom: 16, 
                padding: '12px 16px',
                background: 'linear-gradient(135deg, #4DA6FF 0%, #7B68EE 100%)',
                borderRadius: 8,
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                boxShadow: '0 4px 12px rgba(77, 166, 255, 0.4)'
              }}>
                <Space>
                  <CheckCircleOutlined style={{ color: '#fff', fontSize: 18 }} />
                  <Text style={{ color: '#fff', fontWeight: 500 }}>
                    已选择 <span style={{ fontSize: 18, fontWeight: 700 }}>{selectedStrategies.length}</span> 个广告系列
                    {selectedStrategies.filter(s => !s.is_manual_cpc).length > 0 && (
                      <span style={{ marginLeft: 8, opacity: 0.9 }}>
                        · {selectedStrategies.filter(s => !s.is_manual_cpc).length} 个需转换
                      </span>
                    )}
                  </Text>
                </Space>
                <Space>
                  <Button
                    size="small"
                    ghost
                    style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.5)' }}
                    onClick={() => setSelectedStrategies([])}
                  >
                    取消选择
                  </Button>
                  <Popconfirm
                    title="批量转为人工出价"
                    description={`确定要将 ${selectedStrategies.filter(s => !s.is_manual_cpc).length} 个智能出价广告系列转为人工出价吗？`}
                    onConfirm={handleBatchChangeToManual}
                    okText="确定转换"
                    cancelText="取消"
                    disabled={selectedStrategies.filter(s => !s.is_manual_cpc).length === 0}
                  >
                    <Button
                      type="primary"
                      icon={<RightOutlined />}
                      loading={batchChangeLoading}
                      disabled={selectedStrategies.filter(s => !s.is_manual_cpc).length === 0}
                      style={{ 
                        background: '#fff', 
                        color: '#7B68EE',
                        border: 'none',
                        fontWeight: 600,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
                      }}
                    >
                      一键转人工出价
                    </Button>
                  </Popconfirm>
                  <Button
                    type="primary"
                    icon={<DollarOutlined />}
                    onClick={() => {
                      setBatchBudgetValue(50)
                      setBatchBudgetModalVisible(true)
                    }}
                    style={{ 
                      background: '#52c41a',
                      border: 'none',
                      fontWeight: 600,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
                    }}
                  >
                    批量改预算
                  </Button>
                </Space>
              </div>
            )}

            {/* 提示信息 - 未选中时显示 */}
            {selectedStrategies.length === 0 && (
              <Alert
                message="智能出价 vs 人工出价"
                description={
                  <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                    <li><strong>人工CPC出价</strong>：您完全控制每个关键词的最高CPC，可逐个设置</li>
                    <li><strong>智能出价（最大化点击）</strong>：Google自动调整出价，无法手动设置关键词CPC</li>
                    <li>勾选广告系列后可<strong>批量转换</strong>为人工出价</li>
                  </ul>
                }
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}
            
            <Table
              columns={strategyColumns}
              dataSource={strategies}
              rowKey="id"
              loading={loading}
              pagination={{ 
                pageSize: 50,
                showSizeChanger: true,
                pageSizeOptions: ['10', '20', '50', '100'],
                showTotal: (total) => `共 ${total} 个广告系列`
              }}
              scroll={{ x: 1100 }}
              size="small"
              rowSelection={{
                selectedRowKeys: selectedStrategies.map(s => s.id),
                onChange: (selectedRowKeys, selectedRows, info) => {
                  // 当使用全选时，需要从 strategies 中获取完整数据
                  if (info.type === 'all') {
                    // 全选：根据 selectedRowKeys 从 strategies 中找到所有匹配的行
                    const allSelected = strategies.filter(s => selectedRowKeys.includes(s.id))
                    setSelectedStrategies(allSelected)
                  } else {
                    // 单选：直接更新
                    setSelectedStrategies(selectedRows)
                  }
                },
                selections: [
                  {
                    key: 'all-data',
                    text: '选择全部广告系列',
                    onSelect: () => {
                      setSelectedStrategies([...strategies])
                    }
                  },
                  {
                    key: 'smart-bidding',
                    text: '只选智能出价',
                    onSelect: () => {
                      setSelectedStrategies(strategies.filter(s => !s.is_manual_cpc))
                    }
                  },
                  {
                    key: 'clear',
                    text: '取消全部选择',
                    onSelect: () => {
                      setSelectedStrategies([])
                    }
                  }
                ]
              }}
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
                <Button
                  type="primary"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleOpenAddKeywordModal()
                  }}
                >
                  添加关键词
                </Button>
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

      {/* 设置预算弹窗 */}
      <Modal
        title="设置每日预算"
        open={setBudgetModalVisible}
        onCancel={() => {
          setSetBudgetModalVisible(false)
          setSelectedCampaignForBudget(null)
          setNewBudgetValue(null)
        }}
        onOk={handleSetBudget}
        confirmLoading={setBudgetLoading}
        okText="确认设置"
        cancelText="取消"
      >
        {selectedCampaignForBudget && (
          <div>
            <Paragraph>
              <Text type="secondary">广告系列：</Text>
              <Text strong>{selectedCampaignForBudget.campaign_name}</Text>
            </Paragraph>
            <Paragraph>
              <Text type="secondary">当前预算：</Text>
              <Text>
                {selectedCampaignForBudget.daily_budget
                  ? `$${selectedCampaignForBudget.daily_budget.toFixed(2)}/天`
                  : '未设置'}
              </Text>
            </Paragraph>
            <div style={{ marginTop: 16 }}>
              <Text>新的每日预算：</Text>
              <InputNumber
                prefix="$"
                suffix="/天"
                value={newBudgetValue}
                onChange={setNewBudgetValue}
                min={1}
                max={10000}
                step={5}
                precision={2}
                style={{ width: 180, marginLeft: 8 }}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* 批量设置预算弹窗 */}
      <Modal
        title={`批量设置预算 (${selectedStrategies.length} 个广告系列)`}
        open={batchBudgetModalVisible}
        onCancel={() => {
          setBatchBudgetModalVisible(false)
          setBatchBudgetValue(null)
        }}
        onOk={handleBatchSetBudget}
        confirmLoading={setBudgetLoading}
        okText="确认设置"
        cancelText="取消"
      >
        <Alert
          message="将为选中的所有广告系列设置相同的每日预算"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <div>
          <Text>新的每日预算：</Text>
          <InputNumber
            prefix="$"
            suffix="/天"
            value={batchBudgetValue}
            onChange={setBatchBudgetValue}
            min={1}
            max={10000}
            step={5}
            precision={2}
            style={{ width: 180, marginLeft: 8 }}
          />
        </div>
        <div style={{ marginTop: 16 }}>
          <Text type="secondary">将应用于：</Text>
          <ul style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
            {selectedStrategies.map(s => (
              <li key={s.id}>{s.campaign_name}</li>
            ))}
          </ul>
        </div>
      </Modal>

      {/* 添加关键词弹窗 */}
      <Modal
        title={
          <Space>
            <PlusOutlined />
            <span>添加关键词</span>
          </Space>
        }
        open={addKeywordModalVisible}
        onCancel={() => setAddKeywordModalVisible(false)}
        onOk={handleAddKeyword}
        confirmLoading={addKeywordLoading}
        okText="添加"
        cancelText="取消"
        width={600}
      >
        <Form
          form={addKeywordForm}
          layout="vertical"
        >
          <Form.Item
            name="ad_group_id"
            label="选择广告组"
            rules={[{ required: true, message: '请选择广告组' }]}
          >
            <Select
              placeholder="选择广告组"
              loading={adGroupsLoading}
              showSearch
              optionFilterProp="children"
            >
              {adGroups.map(ag => (
                <Select.Option key={ag.ad_group_id} value={ag.ad_group_id}>
                  {ag.campaign_name} / {ag.ad_group_name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            name="keyword_text"
            label="关键词"
            rules={[{ required: true, message: '请输入关键词' }]}
          >
            <Input placeholder="输入关键词文本" />
          </Form.Item>
          <Form.Item
            name="match_type"
            label="匹配类型"
            rules={[{ required: true, message: '请选择匹配类型' }]}
            initialValue="BROAD"
          >
            <Select>
              <Select.Option value="EXACT">完全匹配 [keyword]</Select.Option>
              <Select.Option value="PHRASE">词组匹配 "keyword"</Select.Option>
              <Select.Option value="BROAD">广泛匹配 keyword</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item
            name="cpc_bid"
            label="最高CPC出价 (可选)"
          >
            <InputNumber
              prefix="$"
              min={0.01}
              max={100}
              step={0.01}
              precision={2}
              placeholder="留空则使用广告组默认出价"
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑关键词弹窗 */}
      <Modal
        title={
          <Space>
            <EditOutlined />
            <span>编辑关键词</span>
          </Space>
        }
        open={editKeywordModalVisible}
        onCancel={() => {
          setEditKeywordModalVisible(false)
          setKeywordToEdit(null)
        }}
        onOk={handleEditKeyword}
        confirmLoading={editKeywordLoading}
        okText="保存"
        cancelText="取消"
        width={600}
      >
        {keywordToEdit && (
          <div>
            <Alert
              type="warning"
              message="注意：修改关键词文本或匹配类型会删除原关键词并重新创建"
              style={{ marginBottom: 16 }}
              showIcon
            />
            <Form
              form={editKeywordForm}
              layout="vertical"
            >
              <Form.Item
                name="keyword_text"
                label="关键词"
                rules={[{ required: true, message: '请输入关键词' }]}
              >
                <Input placeholder="输入关键词文本" />
              </Form.Item>
              <Form.Item
                name="match_type"
                label="匹配类型"
                rules={[{ required: true, message: '请选择匹配类型' }]}
              >
                <Select>
                  <Select.Option value="EXACT">完全匹配 [keyword]</Select.Option>
                  <Select.Option value="PHRASE">词组匹配 "keyword"</Select.Option>
                  <Select.Option value="BROAD">广泛匹配 keyword</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item
                name="cpc_bid"
                label="最高CPC出价"
                rules={[{ required: true, message: '请输入CPC出价' }]}
              >
                <InputNumber
                  prefix="$"
                  min={0.01}
                  max={100}
                  step={0.01}
                  precision={2}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Form>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default BidManagement

