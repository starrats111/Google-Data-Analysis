import React from 'react'
import { Card, Row, Col, Button, Typography, Space } from 'antd'
import { BarChartOutlined, LineChartOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

const { Title, Paragraph, Text } = Typography

const MyAnalysis = () => {
  const navigate = useNavigate()

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Title level={3} style={{ marginBottom: 8 }}>我的分析</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          把你每天需要看的两个分析拆开说明：左边是「L7D 最近7天分析」，右边是「单日分析」。
        </Paragraph>
      </Card>

      <Row gutter={24}>
        <Col xs={24} md={12}>
          <Card
            hoverable
            style={{ marginBottom: 24 }}
            onClick={() => navigate('/analysis-l7d')}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Space>
                <BarChartOutlined style={{ fontSize: 24, color: '#1677ff' }} />
                <Title level={4} style={{ margin: 0 }}>L7D 分析（最近7天）</Title>
              </Space>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                看「过去7天」整体表现：花了多少钱、回了多少佣金、出单天数、保守ROI、操作指令等。
              </Paragraph>
              <Button type="primary" onClick={() => navigate('/analysis-l7d')}>
                进入 L7D 分析
              </Button>
            </Space>
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <Card
            hoverable
            style={{ marginBottom: 24 }}
            onClick={() => navigate('/analysis-daily')}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Space>
                <LineChartOutlined style={{ fontSize: 24, color: '#52c41a' }} />
                <Title level={4} style={{ margin: 0 }}>每日分析（单天详细）</Title>
              </Space>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                看「某一天」每个广告系列的详细表现：花费、佣金、出单、阶段标签、异常类型、操作指令等。
              </Paragraph>
              <Button type="primary" onClick={() => navigate('/analysis-daily')}>
                进入 每日分析
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default MyAnalysis


