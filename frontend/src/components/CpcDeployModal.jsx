import React, { useState, useEffect } from 'react'
import { Modal, Table, Checkbox, Button, Space, Typography, Tag, Divider, message, Spin, Alert } from 'antd'
import { RocketOutlined, DollarOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import api from '../services/api'

const { Text, Title } = Typography

/**
 * 一键部署CPC弹窗组件
 * 
 * 支持：
 * 1. 单行部署
 * 2. 批量部署（多选）
 * 3. 全量部署（所有广告系列）
 */
const CpcDeployModal = ({ 
  visible, 
  onClose, 
  campaigns = [],  // 要部署的广告系列列表
  onSuccess 
}) => {
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState(null)
  
  // 选中状态管理
  const [selectedKeywords, setSelectedKeywords] = useState({})  // {campaign_name: {keyword_id: boolean}}
  const [selectedBudgets, setSelectedBudgets] = useState({})    // {campaign_name: boolean}
  
  // 初始化选中状态
  useEffect(() => {
    if (visible && campaigns.length > 0) {
      const kwSelections = {}
      const budgetSelections = {}
      
      campaigns.forEach(campaign => {
        const deployData = campaign['部署数据'] || {}
        const keywords = deployData.keyword_suggestions || []
        
        kwSelections[campaign['广告系列名']] = {}
        keywords.forEach(kw => {
          kwSelections[campaign['广告系列名']][kw.keyword_id] = true
        })
        
        budgetSelections[campaign['广告系列名']] = !!deployData.budget_suggestion
      })
      
      setSelectedKeywords(kwSelections)
      setSelectedBudgets(budgetSelections)
      setDeployResult(null)
    }
  }, [visible, campaigns])
  
  // 切换关键词选中状态
  const toggleKeyword = (campaignName, keywordId) => {
    setSelectedKeywords(prev => ({
      ...prev,
      [campaignName]: {
        ...(prev[campaignName] || {}),
        [keywordId]: !(prev[campaignName]?.[keywordId])
      }
    }))
  }
  
  // 切换预算选中状态
  const toggleBudget = (campaignName) => {
    setSelectedBudgets(prev => ({
      ...prev,
      [campaignName]: !prev[campaignName]
    }))
  }
  
  // 全选/取消全选某个广告系列的关键词
  const toggleAllKeywords = (campaignName, keywords) => {
    const currentAll = keywords.every(kw => selectedKeywords[campaignName]?.[kw.keyword_id])
    setSelectedKeywords(prev => {
      const newSelections = { ...(prev[campaignName] || {}) }
      keywords.forEach(kw => {
        newSelections[kw.keyword_id] = !currentAll
      })
      return { ...prev, [campaignName]: newSelections }
    })
  }
  
  // 执行部署
  const handleDeploy = async () => {
    setDeploying(true)
    setDeployResult(null)
    
    try {
      // 构建部署请求数据
      const deployCampaigns = campaigns
        .filter(campaign => {
          const deployData = campaign['部署数据'] || {}
          if (deployData.action === 'pause') return true
          
          const keywords = deployData.keyword_suggestions || []
          const hasSelectedKeywords = keywords.some(kw => 
            selectedKeywords[campaign['广告系列名']]?.[kw.keyword_id]
          )
          const hasSelectedBudget = selectedBudgets[campaign['广告系列名']] && deployData.budget_suggestion
          
          return hasSelectedKeywords || hasSelectedBudget
        })
        .map(campaign => {
          const deployData = campaign['部署数据'] || {}
          const keywords = deployData.keyword_suggestions || []
          
          return {
            campaign_name: campaign['广告系列名'],
            campaign_id: deployData.campaign_id,
            customer_id: deployData.customer_id,
            mcc_id: deployData.mcc_id,
            keywords: keywords
              .filter(kw => selectedKeywords[campaign['广告系列名']]?.[kw.keyword_id])
              .map(kw => ({
                keyword_id: kw.keyword_id,
                keyword_text: kw.keyword_text,
                current_cpc: kw.current_cpc,
                target_cpc: kw.target_cpc,
                ad_group_id: kw.ad_group_id,
                selected: true
              })),
            budget_current: deployData.budget_suggestion?.current_budget,
            budget_target: deployData.budget_suggestion?.target_budget,
            budget_selected: selectedBudgets[campaign['广告系列名']] || false
          }
        })
      
      if (deployCampaigns.length === 0) {
        message.warning('请至少选择一项修改')
        setDeploying(false)
        return
      }
      
      const response = await api.post('/api/bids/one-click-deploy', {
        campaigns: deployCampaigns
      })
      
      setDeployResult(response.data)
      
      if (response.data.success) {
        const summary = response.data.summary
        message.success(
          `部署完成！关键词: ${summary.keywords_success}成功/${summary.keywords_failed}失败, ` +
          `预算: ${summary.budget_success}成功/${summary.budget_failed}失败`
        )
        onSuccess && onSuccess()
      }
    } catch (error) {
      console.error('部署失败:', error)
      message.error('部署失败: ' + (error.response?.data?.detail || error.message))
    } finally {
      setDeploying(false)
    }
  }
  
  // 计算统计信息
  const getStats = () => {
    let totalKeywords = 0
    let selectedKeywordCount = 0
    let totalBudgets = 0
    let selectedBudgetCount = 0
    
    campaigns.forEach(campaign => {
      const deployData = campaign['部署数据'] || {}
      const keywords = deployData.keyword_suggestions || []
      
      totalKeywords += keywords.length
      selectedKeywordCount += keywords.filter(kw => 
        selectedKeywords[campaign['广告系列名']]?.[kw.keyword_id]
      ).length
      
      if (deployData.budget_suggestion) {
        totalBudgets += 1
        if (selectedBudgets[campaign['广告系列名']]) {
          selectedBudgetCount += 1
        }
      }
    })
    
    return { totalKeywords, selectedKeywordCount, totalBudgets, selectedBudgetCount }
  }
  
  const stats = getStats()
  
  return (
    <Modal
      title={
        <Space>
          <RocketOutlined style={{ color: '#52c41a' }} />
          <span>一键部署CPC和预算</span>
        </Space>
      }
      open={visible}
      onCancel={onClose}
      width={900}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="deploy"
          type="primary"
          icon={<RocketOutlined />}
          loading={deploying}
          onClick={handleDeploy}
          style={{ background: '#52c41a', borderColor: '#52c41a' }}
        >
          确认部署选中项 ({stats.selectedKeywordCount}关键词 + {stats.selectedBudgetCount}预算)
        </Button>
      ]}
    >
      <Spin spinning={deploying} tip="正在部署...">
        {deployResult && (
          <Alert
            type={deployResult.summary.keywords_failed === 0 && deployResult.summary.budget_failed === 0 ? 'success' : 'warning'}
            message="部署结果"
            description={
              <Space direction="vertical">
                <Text>关键词修改: {deployResult.summary.keywords_success} 成功, {deployResult.summary.keywords_failed} 失败</Text>
                <Text>预算修改: {deployResult.summary.budget_success} 成功, {deployResult.summary.budget_failed} 失败</Text>
              </Space>
            }
            style={{ marginBottom: 16 }}
            showIcon
          />
        )}
        
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {campaigns.map((campaign, index) => {
            const deployData = campaign['部署数据'] || {}
            const keywords = deployData.keyword_suggestions || []
            const budgetSuggestion = deployData.budget_suggestion
            const campaignName = campaign['广告系列名']
            
            // 暂停操作特殊处理
            if (deployData.action === 'pause') {
              return (
                <div key={campaignName} style={{ marginBottom: 16, padding: 12, background: '#fff1f0', borderRadius: 8 }}>
                  <Title level={5} style={{ margin: 0, color: '#f5222d' }}>
                    {campaignName}
                  </Title>
                  <Tag color="red" style={{ marginTop: 8 }}>建议暂停</Tag>
                </div>
              )
            }
            
            // 无需修改
            if (keywords.length === 0 && !budgetSuggestion) {
              return (
                <div key={campaignName} style={{ marginBottom: 16, padding: 12, background: '#f6ffed', borderRadius: 8 }}>
                  <Title level={5} style={{ margin: 0, color: '#52c41a' }}>
                    {campaignName}
                  </Title>
                  <Tag color="green" style={{ marginTop: 8 }}>维持现状</Tag>
                </div>
              )
            }
            
            return (
              <div key={campaignName} style={{ marginBottom: 16, padding: 12, background: '#fafafa', borderRadius: 8 }}>
                <Title level={5} style={{ margin: 0 }}>
                  {campaignName}
                </Title>
                
                {/* 关键词CPC修改 */}
                {keywords.length > 0 && (
                  <>
                    <Divider orientation="left" style={{ margin: '12px 0' }}>
                      <Space>
                        <DollarOutlined />
                        <span>关键词CPC修改</span>
                        <Button 
                          size="small" 
                          onClick={() => toggleAllKeywords(campaignName, keywords)}
                        >
                          {keywords.every(kw => selectedKeywords[campaignName]?.[kw.keyword_id]) ? '取消全选' : '全选'}
                        </Button>
                      </Space>
                    </Divider>
                    <div style={{ marginLeft: 16 }}>
                      {keywords.map(kw => (
                        <div 
                          key={kw.keyword_id} 
                          style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            padding: '4px 0',
                            borderBottom: '1px solid #f0f0f0'
                          }}
                        >
                          <Checkbox
                            checked={selectedKeywords[campaignName]?.[kw.keyword_id]}
                            onChange={() => toggleKeyword(campaignName, kw.keyword_id)}
                          />
                          <Text style={{ marginLeft: 8, flex: 1 }}>
                            [{kw.keyword_text}]
                          </Text>
                          <Text style={{ marginLeft: 8 }}>
                            ${kw.current_cpc.toFixed(2)} → ${kw.target_cpc.toFixed(2)}
                          </Text>
                          <Tag 
                            color={kw.change_percent > 0 ? 'green' : 'red'} 
                            style={{ marginLeft: 8 }}
                          >
                            {kw.change_percent > 0 ? '+' : ''}{kw.change_percent.toFixed(1)}%
                          </Tag>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                
                {/* 预算修改 */}
                {budgetSuggestion && (
                  <>
                    <Divider orientation="left" style={{ margin: '12px 0' }}>
                      <Space>
                        <DollarOutlined />
                        <span>预算修改</span>
                      </Space>
                    </Divider>
                    <div style={{ marginLeft: 16 }}>
                      <Checkbox
                        checked={selectedBudgets[campaignName]}
                        onChange={() => toggleBudget(campaignName)}
                      >
                        预算 ${budgetSuggestion.current_budget.toFixed(2)} → ${budgetSuggestion.target_budget.toFixed(2)}
                        <Tag 
                          color="green" 
                          style={{ marginLeft: 8 }}
                        >
                          +{budgetSuggestion.change_percent.toFixed(0)}%
                        </Tag>
                        <Text type="secondary" style={{ marginLeft: 8 }}>
                          ({budgetSuggestion.reason})
                        </Text>
                      </Checkbox>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </Spin>
    </Modal>
  )
}

export default CpcDeployModal

