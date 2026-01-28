import React, { useState, useEffect } from 'react'
import { Card, Typography, Descriptions, Tag, Button, Spin, message } from 'antd'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeftOutlined } from '@ant-design/icons'
import api from '../services/api'
import './Analysis.css'

const { Title, Text } = Typography

const StageLabelDetail = () => {
  const { label } = useParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [labelInfo, setLabelInfo] = useState(null)

  useEffect(() => {
    fetchLabelInfo()
  }, [label])

  const fetchLabelInfo = async () => {
    if (!label) return
    
    setLoading(true)
    try {
      const response = await api.get(`/api/stage-label/${encodeURIComponent(label)}`)
      setLabelInfo(response.data)
    } catch (error) {
      console.error('获取阶段标签信息失败', error)
      message.error('获取阶段标签信息失败')
      // 如果API不存在，使用默认信息
      setLabelInfo({
        label: decodeURIComponent(label),
        when_to_use: '根据表4规则自动生成',
        action_ad: '请查看表4.xlsx了解详细操作',
        action_data: '请查看表4.xlsx了解详细操作',
        action_risk: '请查看表4.xlsx了解详细操作',
      })
    } finally {
      setLoading(false)
    }
  }

  const decodedLabel = label ? decodeURIComponent(label) : ''

  // 根据标签确定颜色
  const getLabelColor = (labelText) => {
    if (labelText.includes('K1') || labelText.includes('关停')) return 'red'
    if (labelText.includes('S1') || labelText.includes('成熟')) return 'green'
    if (labelText.includes('P1') || labelText.includes('候选')) return 'cyan'
    if (labelText.includes('T2') || labelText.includes('观察')) return 'orange'
    if (labelText.includes('T1') || labelText.includes('试水')) return 'blue'
    return 'default'
  }

  return (
    <div className="analysis-page">
      <div className="analysis-page__header">
        <div>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/analysis')}
            style={{ marginBottom: 16 }}
          >
            返回分析结果
          </Button>
          <Title level={3} className="analysis-page__title">
            阶段标签详情
          </Title>
        </div>
      </div>

      <Card>
        <Spin spinning={loading}>
          {labelInfo ? (
            <Descriptions
              title={
                <Tag color={getLabelColor(labelInfo.label || decodedLabel)} style={{ fontSize: 16, padding: '4px 12px' }}>
                  {labelInfo.label || decodedLabel}
                </Tag>
              }
              bordered
              column={1}
            >
              <Descriptions.Item label="何时使用">
                {labelInfo.when_to_use || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="投放动作（投放组）">
                <Text strong style={{ color: '#1890ff' }}>
                  {labelInfo.action_ad || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="数据动作（数据组）">
                <Text strong style={{ color: '#52c41a' }}>
                  {labelInfo.action_data || '-'}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="风控动作（风控组）">
                <Text strong style={{ color: '#faad14' }}>
                  {labelInfo.action_risk || '-'}
                </Text>
              </Descriptions.Item>
              {labelInfo.trigger_conditions && (
                <Descriptions.Item label="触发条件">
                  {labelInfo.trigger_conditions}
                </Descriptions.Item>
              )}
            </Descriptions>
          ) : (
            <div>
              <Title level={4}>
                <Tag color={getLabelColor(decodedLabel)}>{decodedLabel}</Tag>
              </Title>
              <Text type="secondary">
                请查看 excel/表4.xlsx 文件了解该阶段标签的详细操作说明
              </Text>
            </div>
          )}
        </Spin>
      </Card>
    </div>
  )
}

export default StageLabelDetail

