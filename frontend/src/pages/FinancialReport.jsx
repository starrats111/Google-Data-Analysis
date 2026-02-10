import React from 'react'
import { Card, Typography, Alert, Space } from 'antd'
import { BankOutlined, ToolOutlined } from '@ant-design/icons'

const { Title, Paragraph } = Typography

const FinancialReport = () => {
  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <BankOutlined style={{ fontSize: 64, color: '#1677ff', marginBottom: 24 }} />
            <Title level={2}>财务报表</Title>
            <Paragraph type="secondary" style={{ fontSize: 16 }}>
              此功能正在开发中，敬请期待...
            </Paragraph>
          </div>
          
          <Alert
            message="功能预告"
            description={
              <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                <li>员工每月佣金汇总</li>
                <li>已收/未收佣金记录</li>
                <li>导出Excel报表</li>
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

export default FinancialReport

