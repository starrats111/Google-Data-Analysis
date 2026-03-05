import React from 'react'
import { Card, Tag, Progress, Table, Alert, Collapse, Typography, Space, Tooltip } from 'antd'
import {
  WarningOutlined,
  DollarOutlined,
  FundOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'

const { Text, Title } = Typography
const { Panel } = Collapse

const severityConfig = {
  critical: { color: '#f5222d', bg: '#fff1f0', label: '严重', icon: '🔴' },
  warning: { color: '#fa8c16', bg: '#fff7e6', label: '警告', icon: '🟡' },
  info: { color: '#1890ff', bg: '#e6f7ff', label: '提示', icon: '🔵' },
}

function AnomalySection({ anomalies }) {
  if (!anomalies || anomalies.length === 0) {
    return (
      <Alert
        type="success"
        message="本周期所有指标在正常范围内"
        showIcon
        style={{ marginBottom: 12 }}
      />
    )
  }

  return (
    <Card
      size="small"
      title={
        <Space>
          <WarningOutlined style={{ color: '#f5222d' }} />
          <span>异常警报</span>
          <Tag color="red">{anomalies.length} 项</Tag>
        </Space>
      }
      style={{ marginBottom: 12 }}
    >
      {anomalies.map((a, idx) => {
        const cfg = severityConfig[a.severity] || severityConfig.info
        return (
          <div
            key={idx}
            style={{
              padding: '8px 12px',
              marginBottom: 8,
              background: cfg.bg,
              borderRadius: 6,
              borderLeft: `3px solid ${cfg.color}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Space size={8}>
                <Tag color={cfg.color} style={{ margin: 0 }}>
                  {cfg.icon} {cfg.label}
                </Tag>
                <Text strong style={{ fontSize: 13 }}>
                  {a.campaign_name}
                </Text>
              </Space>
              {a.estimated_impact_usd > 0 && (
                <Text type="danger" strong>
                  影响 ${a.estimated_impact_usd?.toFixed(2)}
                </Text>
              )}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>
              <Text type="secondary">
                {a.metric} = {a.current_value}（基线 {a.baseline_avg} ± {a.baseline_std}，
                偏离 {a.deviation_pct > 0 ? '+' : ''}{a.deviation_pct}%）
              </Text>
              {a.likely_cause && (
                <Tag color="default" style={{ marginLeft: 8 }}>
                  可能原因：{a.likely_cause}
                </Tag>
              )}
            </div>
          </div>
        )
      })}
    </Card>
  )
}

function CpaDiagnosisSection({ diagnosis }) {
  if (!diagnosis) {
    return (
      <Alert
        type="info"
        message="CPA 保持稳定，无需诊断"
        showIcon
        style={{ marginBottom: 12 }}
      />
    )
  }

  const diag = diagnosis.cpa_diagnosis || diagnosis

  return (
    <Card
      size="small"
      title={
        <Space>
          <FundOutlined style={{ color: '#722ed1' }} />
          <span>CPA 变化归因</span>
          <Tag color={diag.change_pct > 0 ? 'red' : 'green'}>
            {diag.change_pct > 0 ? '+' : ''}{diag.change_pct}%
          </Tag>
        </Space>
      }
      style={{ marginBottom: 12 }}
    >
      <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>上期 CPA</Text>
          <div style={{ fontSize: 20, fontWeight: 600 }}>${diag.previous_cpa?.toFixed(2)}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 20 }}>→</div>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>当前 CPA</Text>
          <div style={{ fontSize: 20, fontWeight: 600, color: diag.change_pct > 0 ? '#f5222d' : '#52c41a' }}>
            ${diag.current_cpa?.toFixed(2)}
          </div>
        </div>
      </div>

      {(diag.factors || []).map((f, idx) => (
        <div key={idx} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text strong style={{ fontSize: 13 }}>{f.factor}</Text>
            <Text type="secondary">{f.contribution_pct}%</Text>
          </div>
          <Progress
            percent={f.contribution_pct}
            strokeColor={idx === 0 ? '#f5222d' : idx === 1 ? '#fa8c16' : '#1890ff'}
            size="small"
            showInfo={false}
          />
          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
            {f.detail}
            {f.fix && <span style={{ marginLeft: 8, color: '#1890ff' }}>→ {f.fix}</span>}
          </div>
        </div>
      ))}
    </Card>
  )
}

function BudgetSection({ budgetAnalysis }) {
  if (!budgetAnalysis || budgetAnalysis.length === 0) {
    return (
      <Alert
        type="info"
        message="无预算优化建议"
        showIcon
        style={{ marginBottom: 12 }}
      />
    )
  }

  const columns = [
    { title: '广告系列', dataIndex: 'campaign_name', key: 'name', ellipsis: true, width: 200 },
    {
      title: '当前预算',
      dataIndex: 'current_daily_budget',
      key: 'current',
      width: 100,
      align: 'right',
      render: (v) => `$${(v || 0).toFixed(2)}`,
    },
    {
      title: '推荐预算',
      dataIndex: 'recommended_daily_budget',
      key: 'recommended',
      width: 100,
      align: 'right',
      render: (v) => <Text strong style={{ color: '#52c41a' }}>${(v || 0).toFixed(2)}</Text>,
    },
    {
      title: '变化',
      dataIndex: 'change',
      key: 'change',
      width: 80,
      align: 'center',
      render: (v) => {
        const isUp = v && v.startsWith('+')
        return <Tag color={isUp ? 'green' : 'orange'}>{v}</Tag>
      },
    },
    { title: '理由', dataIndex: 'reason', key: 'reason', ellipsis: true },
    {
      title: '预计 ROI',
      dataIndex: 'projected_roi_change',
      key: 'roi',
      width: 100,
      align: 'center',
      render: (v) => <Tag color="blue">{v}</Tag>,
    },
  ]

  return (
    <Card
      size="small"
      title={
        <Space>
          <DollarOutlined style={{ color: '#52c41a' }} />
          <span>预算优化建议</span>
          <Tag color="green">{budgetAnalysis.length} 项</Tag>
        </Space>
      }
      style={{ marginBottom: 12 }}
    >
      <Table
        columns={columns}
        dataSource={budgetAnalysis.map((b, i) => ({ ...b, key: i }))}
        pagination={false}
        size="small"
        scroll={{ x: 700 }}
      />
    </Card>
  )
}

export default function StructuredAnalysisCard({ resultData, campaignName }) {
  if (!resultData) return null

  const aiEngine = resultData.ai_engine
  const anomalies = resultData.anomalies || []
  const cpaDiagnosis = resultData.cpa_diagnosis
  const budgetAnalysis = resultData.budget_analysis || []

  const filteredAnomalies = campaignName
    ? anomalies.filter((a) => a.campaign_name === campaignName)
    : anomalies

  const filteredBudget = campaignName
    ? budgetAnalysis.filter((b) => b.campaign_name === campaignName)
    : budgetAnalysis

  if (aiEngine === 'gemini_fallback') {
    return (
      <Alert
        type="warning"
        message="AI 引擎降级提示"
        description="Claude 分析服务暂时不可用，已自动降级为 Gemini 生成报告。"
        showIcon
        icon={<ThunderboltOutlined />}
        style={{ marginBottom: 12 }}
      />
    )
  }

  if (aiEngine !== 'claude') return null

  return (
    <div style={{ marginBottom: 16 }}>
      <Collapse
        defaultActiveKey={filteredAnomalies.length > 0 ? ['anomalies'] : []}
        ghost
        items={[
          {
            key: 'anomalies',
            label: (
              <Space>
                <WarningOutlined />
                <span>异常检测</span>
                {filteredAnomalies.length > 0 && (
                  <Tag color="red">{filteredAnomalies.length}</Tag>
                )}
              </Space>
            ),
            children: <AnomalySection anomalies={filteredAnomalies} />,
          },
          {
            key: 'cpa',
            label: (
              <Space>
                <FundOutlined />
                <span>CPA 诊断</span>
              </Space>
            ),
            children: <CpaDiagnosisSection diagnosis={cpaDiagnosis} />,
          },
          {
            key: 'budget',
            label: (
              <Space>
                <DollarOutlined />
                <span>预算建议</span>
                {filteredBudget.length > 0 && (
                  <Tag color="green">{filteredBudget.length}</Tag>
                )}
              </Space>
            ),
            children: <BudgetSection budgetAnalysis={filteredBudget} />,
          },
        ]}
      />
    </div>
  )
}
