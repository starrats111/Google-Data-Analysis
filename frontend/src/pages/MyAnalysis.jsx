import React from 'react'
import { Card, Row, Col, Button, Typography, Space } from 'antd'
import { BarChartOutlined, FileTextOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

const { Title, Paragraph } = Typography

const MyAnalysis = () => {
  const navigate = useNavigate()

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Title level={3} style={{ marginBottom: 8 }}>我的分析</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          查看 L7D 分析（每天自动生成）和 AI 生成的报告。
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
                看「过去7天」整体表现：花了多少钱、回了多少佣金、出单天数、保守ROI等。每天自动生成。
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


