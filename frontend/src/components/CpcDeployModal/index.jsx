import React, { useState, useEffect } from 'react'
import { Modal, Table, Button, Checkbox, Tag, Alert, Spin, message, Space, Tooltip, Progress, Tabs, InputNumber } from 'antd'
import { ThunderboltOutlined, WarningOutlined, CheckCircleOutlined, CloseCircleOutlined, SwapOutlined, DollarOutlined, EditOutlined } from '@ant-design/icons'
import api from '../../services/api'
import './style.css'

const CpcDeployModal = ({ visible, onClose, aiReport, onSuccess }) => {
  const [loading, setLoading] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [deployingBudget, setDeployingBudget] = useState(false)
  const [suggestions, setSuggestions] = useState(null)
  const [selectedCampaigns, setSelectedCampaigns] = useState([])
  const [selectedBudgetCampaigns, setSelectedBudgetCampaigns] = useState([])
  const [deployResults, setDeployResults] = useState(null)
  const [budgetDeployResults, setBudgetDeployResults] = useState(null)
  const [activeTab, setActiveTab] = useState('cpc') // 'cpc' or 'budget'

  useEffect(() => {
    if (visible && aiReport) {
      parseSuggestions()
    }
  }, [visible, aiReport])

  const parseSuggestions = async () => {
    setParsing(true)
    try {
      const response = await api.post('/api/bids/parse-suggestions', {
        ai_report: aiReport
      })
      setSuggestions(response.data)
      
      // 默认选中所有可调整的广告系列
      const selectable = (response.data.cpc_adjustments || [])
        .filter(adj => adj.found_in_db && adj.is_manual_cpc)
        .map(adj => adj.campaign_name)
      setSelectedCampaigns(selectable)
      
      // 默认选中所有预算调整建议
      const budgetSelectable = (response.data.budget_adjustments || [])
        .filter(adj => adj.found_in_db)
        .map(adj => adj.campaign_name)
      setSelectedBudgetCampaigns(budgetSelectable)
    } catch (error) {
      console.error('解析CPC建议失败:', error)
      message.error('解析CPC建议失败')
    } finally {
      setParsing(false)
    }
  }

  const handleConvertToManual = async (adjustment) => {
    setLoading(true)
    try {
      await api.post('/api/bids/change-to-manual', {
        mcc_id: adjustment.db_mcc_id,
        customer_id: adjustment.db_customer_id,
        campaign_id: adjustment.db_campaign_id
      })
      message.success('已转换为人工出价')
      // 重新解析
      await parseSuggestions()
    } catch (error) {
      console.error('转换人工出价失败:', error)
      message.error('转换人工出价失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setLoading(false)
    }
  }

  const handleDeploy = async () => {
    if (selectedCampaigns.length === 0) {
      message.warning('请至少选择一个广告系列')
      return
    }

    setDeploying(true)
    setDeployResults(null)

    try {
      // 获取选中的调整项
      const adjustments = suggestions.cpc_adjustments
        .filter(adj => selectedCampaigns.includes(adj.campaign_name))
        .map(adj => ({
          campaign_name: adj.campaign_name,
          campaign_id: adj.db_campaign_id,
          target_cpc: adj.target_cpc,
          reason: adj.reason
        }))

      // 按MCC分组处理
      const mccGroups = {}
      for (const adj of suggestions.cpc_adjustments.filter(a => selectedCampaigns.includes(a.campaign_name))) {
        const mccId = adj.db_mcc_id
        if (!mccGroups[mccId]) {
          mccGroups[mccId] = {
            mcc_id: mccId,
            customer_id: adj.db_customer_id,
            adjustments: []
          }
        }
        mccGroups[mccId].adjustments.push({
          campaign_name: adj.campaign_name,
          campaign_id: adj.db_campaign_id,
          target_cpc: adj.target_cpc
        })
      }

      // 逐个MCC执行
      const allResults = []
      for (const mccId in mccGroups) {
        const group = mccGroups[mccId]
        const response = await api.post('/api/bids/apply-cpc-changes', group)
        allResults.push(...response.data.results)
      }

      setDeployResults(allResults)
      
      const successCount = allResults.filter(r => r.success).length
      const failedCount = allResults.filter(r => !r.success).length
      
      if (failedCount === 0) {
        message.success(`全部部署成功！共 ${successCount} 个广告系列`)
        onSuccess && onSuccess()
      } else {
        message.warning(`部署完成：${successCount} 成功，${failedCount} 失败`)
      }
    } catch (error) {
      console.error('部署CPC失败:', error)
      message.error('部署失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setDeploying(false)
    }
  }

  const handleSelectAll = (checked) => {
    if (checked) {
      const selectable = (suggestions?.cpc_adjustments || [])
        .filter(adj => adj.found_in_db && adj.is_manual_cpc)
        .map(adj => adj.campaign_name)
      setSelectedCampaigns(selectable)
    } else {
      setSelectedCampaigns([])
    }
  }

  const handleSelectCampaign = (campaignName, checked) => {
    if (checked) {
      setSelectedCampaigns([...selectedCampaigns, campaignName])
    } else {
      setSelectedCampaigns(selectedCampaigns.filter(c => c !== campaignName))
    }
  }

  // 预算相关的选择函数
  const handleSelectAllBudget = (checked) => {
    if (checked) {
      const selectable = (suggestions?.budget_adjustments || [])
        .filter(adj => adj.found_in_db)
        .map(adj => adj.campaign_name)
      setSelectedBudgetCampaigns(selectable)
    } else {
      setSelectedBudgetCampaigns([])
    }
  }

  const handleSelectBudgetCampaign = (campaignName, checked) => {
    if (checked) {
      setSelectedBudgetCampaigns([...selectedBudgetCampaigns, campaignName])
    } else {
      setSelectedBudgetCampaigns(selectedBudgetCampaigns.filter(c => c !== campaignName))
    }
  }

  // 部署预算调整
  const handleDeployBudget = async () => {
    if (selectedBudgetCampaigns.length === 0) {
      message.warning('请至少选择一个广告系列')
      return
    }

    setDeployingBudget(true)
    setBudgetDeployResults(null)

    try {
      // 按MCC分组处理
      const mccGroups = {}
      for (const adj of suggestions.budget_adjustments.filter(a => selectedBudgetCampaigns.includes(a.campaign_name) && a.found_in_db)) {
        const mccId = adj.db_mcc_id
        if (!mccGroups[mccId]) {
          mccGroups[mccId] = {
            mcc_id: mccId,
            campaigns: []
          }
        }
        mccGroups[mccId].campaigns.push({
          campaign_id: adj.db_campaign_id,
          new_budget: adj.target_budget
        })
      }

      // 逐个MCC执行
      const allResults = []
      for (const mccId in mccGroups) {
        const group = mccGroups[mccId]
        const response = await api.post('/api/bids/batch-set-budget', group)
        allResults.push(...response.data.results)
      }

      setBudgetDeployResults(allResults)
      
      const successCount = allResults.filter(r => r.success).length
      const failedCount = allResults.filter(r => !r.success).length
      
      if (failedCount === 0) {
        message.success(`预算全部修改成功！共 ${successCount} 个广告系列`)
        onSuccess && onSuccess()
      } else {
        message.warning(`预算修改完成：${successCount} 成功，${failedCount} 失败`)
      }
    } catch (error) {
      console.error('部署预算失败:', error)
      message.error('部署预算失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setDeployingBudget(false)
    }
  }

  const columns = [
    {
      title: () => (
        <Checkbox
          checked={selectedCampaigns.length > 0 && selectedCampaigns.length === (suggestions?.cpc_adjustments || []).filter(a => a.found_in_db && a.is_manual_cpc).length}
          indeterminate={selectedCampaigns.length > 0 && selectedCampaigns.length < (suggestions?.cpc_adjustments || []).filter(a => a.found_in_db && a.is_manual_cpc).length}
          onChange={(e) => handleSelectAll(e.target.checked)}
        />
      ),
      dataIndex: 'selected',
      width: 50,
      render: (_, record) => (
        <Checkbox
          checked={selectedCampaigns.includes(record.campaign_name)}
          disabled={!record.found_in_db || !record.is_manual_cpc}
          onChange={(e) => handleSelectCampaign(record.campaign_name, e.target.checked)}
        />
      )
    },
    {
      title: '广告系列',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      ellipsis: true,
      render: (text, record) => (
        <div>
          <div>{text}</div>
          {!record.found_in_db && (
            <Tag color="red" size="small">未找到</Tag>
          )}
        </div>
      )
    },
    {
      title: '出价策略',
      dataIndex: 'bidding_strategy_type',
      key: 'bidding_strategy_type',
      width: 150,
      render: (type, record) => {
        if (!record.found_in_db) return '-'
        if (record.is_manual_cpc) {
          return <Tag color="green">人工出价</Tag>
        }
        return (
          <Space>
            <Tag color="orange">{type || '智能出价'}</Tag>
            <Tooltip title="需要先转为人工出价">
              <Button 
                size="small" 
                icon={<SwapOutlined />}
                onClick={() => handleConvertToManual(record)}
                loading={loading}
              >
                转人工
              </Button>
            </Tooltip>
          </Space>
        )
      }
    },
    {
      title: 'CPC调整',
      key: 'cpc_change',
      width: 180,
      render: (_, record) => (
        <div>
          <span style={{ color: '#999' }}>${record.current_cpc?.toFixed(2)}</span>
          <span style={{ margin: '0 8px' }}>→</span>
          <span style={{ color: record.change_percent > 0 ? '#52c41a' : '#ff4d4f', fontWeight: 'bold' }}>
            ${record.target_cpc?.toFixed(2)}
          </span>
          <Tag color={record.change_percent > 0 ? 'green' : 'red'} style={{ marginLeft: 8 }}>
            {record.change_percent > 0 ? '+' : ''}{record.change_percent}%
          </Tag>
        </div>
      )
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 80,
      render: (priority) => {
        const colors = { high: 'red', medium: 'orange', low: 'blue' }
        const labels = { high: '高', medium: '中', low: '低' }
        return <Tag color={colors[priority]}>{labels[priority] || priority}</Tag>
      }
    },
    {
      title: '原因',
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true
    }
  ]

  const resultColumns = [
    {
      title: '广告系列',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      ellipsis: true
    },
    {
      title: '状态',
      dataIndex: 'success',
      key: 'success',
      width: 100,
      render: (success) => success ? (
        <Tag icon={<CheckCircleOutlined />} color="success">成功</Tag>
      ) : (
        <Tag icon={<CloseCircleOutlined />} color="error">失败</Tag>
      )
    },
    {
      title: '消息',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true
    }
  ]

  // 预算调整表格列
  const budgetColumns = [
    {
      title: () => (
        <Checkbox
          checked={selectedBudgetCampaigns.length > 0 && selectedBudgetCampaigns.length === (suggestions?.budget_adjustments || []).filter(a => a.found_in_db).length}
          indeterminate={selectedBudgetCampaigns.length > 0 && selectedBudgetCampaigns.length < (suggestions?.budget_adjustments || []).filter(a => a.found_in_db).length}
          onChange={(e) => handleSelectAllBudget(e.target.checked)}
        />
      ),
      dataIndex: 'selected',
      width: 50,
      render: (_, record) => (
        <Checkbox
          checked={selectedBudgetCampaigns.includes(record.campaign_name)}
          disabled={!record.found_in_db}
          onChange={(e) => handleSelectBudgetCampaign(record.campaign_name, e.target.checked)}
        />
      )
    },
    {
      title: '广告系列',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
      ellipsis: true,
      render: (text, record) => (
        <div>
          <div>{text}</div>
          {!record.found_in_db && (
            <Tag color="red" size="small">未找到</Tag>
          )}
        </div>
      )
    },
    {
      title: '预算调整',
      key: 'budget_change',
      width: 200,
      render: (_, record) => (
        <div>
          <span style={{ color: '#999' }}>${record.current_budget?.toFixed(2)}</span>
          <span style={{ margin: '0 8px' }}>→</span>
          <span style={{ color: record.target_budget > record.current_budget ? '#52c41a' : '#ff4d4f', fontWeight: 'bold' }}>
            ${record.target_budget?.toFixed(2)}
          </span>
          {record.change_percent && (
            <Tag color={record.change_percent > 0 ? 'green' : 'red'} style={{ marginLeft: 8 }}>
              {record.change_percent > 0 ? '+' : ''}{record.change_percent}%
            </Tag>
          )}
        </div>
      )
    },
    {
      title: '原因',
      dataIndex: 'reason',
      key: 'reason',
      ellipsis: true
    }
  ]

  const hasSuggestions = suggestions && (
    suggestions.cpc_adjustments?.length > 0 ||
    suggestions.pause_campaigns?.length > 0 ||
    suggestions.budget_adjustments?.length > 0
  )

  const hasCpcSuggestions = suggestions?.cpc_adjustments?.length > 0
  const hasBudgetSuggestions = suggestions?.budget_adjustments?.length > 0

  return (
    <Modal
      title={
        <Space>
          <ThunderboltOutlined style={{ color: '#1677ff' }} />
          <span>一键部署CPC调整</span>
        </Space>
      }
      open={visible}
      onCancel={onClose}
      width={1000}
      footer={
        deployResults ? (
          <Button onClick={onClose}>关闭</Button>
        ) : (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button 
              type="primary" 
              icon={<ThunderboltOutlined />}
              onClick={handleDeploy}
              loading={deploying}
              disabled={selectedCampaigns.length === 0}
            >
              确认部署 ({selectedCampaigns.length} 个广告系列)
            </Button>
          </Space>
        )
      }
    >
      {parsing ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin size="large" />
          <p style={{ marginTop: 16 }}>正在解析AI报告中的CPC建议...</p>
        </div>
      ) : !hasSuggestions ? (
        <div>
          <Alert
            type="warning"
            message="未检测到CPC调整建议"
            description="AI报告中没有包含结构化的CPC调整建议。请确保使用了最新的分析提示词，并且AI在报告末尾输出了JSON格式的调整建议。"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Alert
            type="info"
            message="如何获取CPC建议？"
            description={
              <ol style={{ paddingLeft: 16, margin: '8px 0' }}>
                <li>先在「出价管理」页面点击「同步出价数据」</li>
                <li>返回L7D分析页面，重新生成AI分析报告</li>
                <li>AI报告末尾会包含JSON格式的CPC调整建议</li>
              </ol>
            }
            showIcon
          />
        </div>
      ) : deployResults ? (
        <div>
          <Alert
            type={deployResults.every(r => r.success) ? 'success' : 'warning'}
            message="部署完成"
            description={`成功: ${deployResults.filter(r => r.success).length} 个，失败: ${deployResults.filter(r => !r.success).length} 个`}
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Table
            columns={resultColumns}
            dataSource={deployResults.map((r, i) => ({ ...r, key: i }))}
            pagination={false}
            size="small"
          />
        </div>
      ) : (
        <div>
          {suggestions?.cpc_adjustments?.some(a => !a.is_manual_cpc && a.found_in_db) && (
            <Alert
              type="warning"
              message="部分广告系列使用智能出价"
              description="智能出价的广告系列需要先转为人工出价才能调整CPC。请点击对应的「转人工」按钮进行转换。"
              showIcon
              icon={<WarningOutlined />}
              style={{ marginBottom: 16 }}
            />
          )}
          
          <h4>CPC调整建议 ({suggestions?.cpc_adjustments?.length || 0} 个)</h4>
          <Table
            columns={columns}
            dataSource={(suggestions?.cpc_adjustments || []).map((adj, i) => ({ ...adj, key: i }))}
            pagination={false}
            size="small"
            scroll={{ y: 300 }}
          />

          {suggestions?.pause_campaigns?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4>建议暂停 ({suggestions.pause_campaigns.length} 个)</h4>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {suggestions.pause_campaigns.map((p, i) => (
                  <Tag key={i} color="red">
                    {p.campaign_name} - {p.reason}
                  </Tag>
                ))}
              </div>
              <Alert
                type="info"
                message="暂停操作需要在Google Ads后台手动执行"
                style={{ marginTop: 8 }}
                showIcon
              />
            </div>
          )}

          {suggestions?.budget_adjustments?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <DollarOutlined />
                预算调整建议 ({suggestions.budget_adjustments.length} 个)
              </h4>
              <Table
                columns={budgetColumns}
                dataSource={(suggestions?.budget_adjustments || []).map((adj, i) => ({ ...adj, key: i }))}
                pagination={false}
                size="small"
                scroll={{ y: 200 }}
              />
              <div style={{ marginTop: 12, textAlign: 'right' }}>
                <Button 
                  type="primary" 
                  icon={<DollarOutlined />}
                  onClick={handleDeployBudget}
                  loading={deployingBudget}
                  disabled={selectedBudgetCampaigns.length === 0}
                >
                  部署预算调整 ({selectedBudgetCampaigns.length} 个)
                </Button>
              </div>
              {budgetDeployResults && (
                <div style={{ marginTop: 12 }}>
                  <Alert
                    type={budgetDeployResults.every(r => r.success) ? 'success' : 'warning'}
                    message="预算调整完成"
                    description={`成功: ${budgetDeployResults.filter(r => r.success).length} 个，失败: ${budgetDeployResults.filter(r => !r.success).length} 个`}
                    showIcon
                    style={{ marginBottom: 8 }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

export default CpcDeployModal

