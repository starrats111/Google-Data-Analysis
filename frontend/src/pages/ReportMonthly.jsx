import React from 'react'
import { Card, Typography, Alert, Space } from 'antd'
import { FileTextOutlined, ToolOutlined } from '@ant-design/icons'

const { Title, Paragraph } = Typography

const ReportMonthly = () => {
  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <FileTextOutlined style={{ fontSize: 64, color: '#722ed1', marginBottom: 24 }} />
            <Title level={2}>本月报表</Title>
            <Paragraph type="secondary" style={{ fontSize: 16 }}>
              此功能正在开发中，敬请期待...
            </Paragraph>
          </div>
          
          <Alert
            message="功能预告"
            description={
              <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                <li>本月广告费用汇总</li>
                <li>本月佣金收入汇总</li>
                <li>ROI分析报告</li>
              </ul>
            }
            type="info"
            showIcon
            icon={<ToolOutlined />}
          />
        </Space>
      </Card>
    </div>
  )
}

export default ReportMonthly

