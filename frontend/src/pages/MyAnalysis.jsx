import React from 'react'
import { Card, Row, Col, Button, Typography, Space } from 'antd'
import { BarChartOutlined, LineChartOutlined, FileTextOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

const { Title, Paragraph, Text } = Typography

const MyAnalysis = () => {
  const navigate = useNavigate()

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Title level={3} style={{ marginBottom: 8 }}>我的分析</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          把你每天需要看的分析拆开说明：「L7D 最近7天分析」、「单日分析」和「我的报告」。
        </Paragraph>
      </Card>

      <Row gutter={24}>
        <Col xs={24} md={8}>
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
                看「过去7天」整体表现：花了多少钱、回了多少佣金、出单天数、保守ROI等。
              </Paragraph>
              <Button type="primary" onClick={() => navigate('/analysis-l7d')}>
                进入 L7D 分析
              </Button>
            </Space>
          </Card>
        </Col>

        <Col xs={24} md={8}>
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
                看「某一天」每个广告系列的详细表现：花费、佣金、出单、阶段标签等。
              </Paragraph>
              <Button type="primary" onClick={() => navigate('/analysis-daily')}>
                进入 每日分析
              </Button>
            </Space>
          </Card>
        </Col>

        <Col xs={24} md={8}>
          <Card
            hoverable
            style={{ marginBottom: 24, borderColor: '#722ed1' }}
            onClick={() => navigate('/my-reports')}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Space>
                <FileTextOutlined style={{ fontSize: 24, color: '#722ed1' }} />
                <Title level={4} style={{ margin: 0 }}>我的报告</Title>
              </Space>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                查看 AI 生成的分析报告，包含可执行的操作指令，如 CPC 0.10→0.08。
              </Paragraph>
              <Button style={{ borderColor: '#722ed1', color: '#722ed1' }} onClick={() => navigate('/my-reports')}>
                查看我的报告
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default MyAnalysis


