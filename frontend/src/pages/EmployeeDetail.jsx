import React, { useState, useEffect } from 'react'
import { Card, Tabs, Table, Tag, Statistic, Row, Col, Button, Skeleton, Descriptions, Space } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'

const EmployeeDetail = () => {
  const { id } = useParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [employee, setEmployee] = useState(null)
  const [mccAccounts, setMccAccounts] = useState([])
  const [platformAccounts, setPlatformAccounts] = useState([])
  const [analysisData, setAnalysisData] = useState([])
  const [expenseData, setExpenseData] = useState(null)

  useEffect(() => {
    if (id) {
      fetchEmployeeData()
    }
  }, [id])

  const fetchEmployeeData = async () => {
    setLoading(true)
    try {
      // 并行获取所有数据
      const [empRes, mccRes, platformRes, analysisRes, expenseRes] = await Promise.all([
        api.get(`/api/users/${id}`),
        api.get(`/api/mcc/by-user/${id}`),
        api.get(`/api/affiliate/accounts/by-user/${id}`),
        api.get(`/api/analysis/by-user/${id}?limit=10`),
        api.get(`/api/expenses/by-user/${id}`),
      ])
      
      setEmployee(empRes.data)
      setMccAccounts(mccRes.data || [])
      setPlatformAccounts(platformRes.data || [])
      setAnalysisData(analysisRes.data || [])
      setExpenseData(expenseRes.data)
    } catch (error) {
      console.error('获取员工详情失败:', error)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <Skeleton active paragraph={{ rows: 15 }} />
      </Card>
    )
  }

  if (!employee) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 40 }}>
          <p>员工不存在</p>
          <Button onClick={() => navigate('/employees')}>返回列表</Button>
        </div>
      </Card>
    )
  }

  // MCC账号表格
  const mccColumns = [
    {
      title: 'MCC名称',
      dataIndex: 'mcc_name',
      key: 'mcc_name',
    },
    {
      title: 'MCC ID',
      dataIndex: 'mcc_id',
      key: 'mcc_id',
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: '货币',
      dataIndex: 'currency',
      key: 'currency',
      render: (val) => val || 'USD',
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (val) => (
        <Tag color={val ? 'green' : 'red'}>{val ? '激活' : '停用'}</Tag>
      ),
    },
  ]

  // 平台账号表格
  const platformColumns = [
    {
      title: '平台',
      dataIndex: ['platform', 'platform_name'],
      key: 'platform_name',
      render: (_, record) => record.platform?.platform_name || '-',
    },
    {
      title: '账号名称',
      dataIndex: 'account_name',
      key: 'account_name',
    },
    {
      title: '渠道ID',
      dataIndex: 'account_code',
      key: 'account_code',
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (val) => (
        <Tag color={val ? 'green' : 'red'}>{val ? '激活' : '停用'}</Tag>
      ),
    },
  ]

  // L7D分析表格
  const analysisColumns = [
    {
      title: '日期',
      dataIndex: 'analysis_date',
      key: 'analysis_date',
      width: 110,
    },
    {
      title: '类型',
      dataIndex: 'analysis_type',
      key: 'analysis_type',
      width: 80,
      render: (val) => (
        <Tag color={val === 'l7d' ? 'blue' : 'green'}>{val?.toUpperCase()}</Tag>
      ),
    },
    {
      title: '广告系列数',
      key: 'campaign_count',
      width: 100,
      render: (_, record) => {
        const data = record.result_data?.data || []
        return data.length
      },
    },
  ]

  const tabItems = [
    {
      key: 'mcc',
      label: `MCC账号 (${mccAccounts.length})`,
      children: (
        <Table
          columns={mccColumns}
          dataSource={mccAccounts}
          rowKey="id"
          pagination={false}
          size="small"
        />
      ),
    },
    {
      key: 'platform',
      label: `平台账号 (${platformAccounts.length})`,
      children: (
        <Table
          columns={platformColumns}
          dataSource={platformAccounts}
          rowKey="id"
          pagination={false}
          size="small"
        />
      ),
    },
    {
      key: 'analysis',
      label: 'L7D分析',
      children: (
        <Table
          columns={analysisColumns}
          dataSource={analysisData}
          rowKey="id"
          pagination={{ pageSize: 10 }}
          size="small"
        />
      ),
    },
    {
      key: 'expense',
      label: '收益明细',
      children: expenseData ? (
        <div>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Statistic
                title="本月费用"
                value={expenseData.cost_month || 0}
                precision={2}
                prefix="$"
                valueStyle={{ color: '#cf1322' }}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title="本月佣金"
                value={expenseData.commission_month || 0}
                precision={2}
                prefix="$"
                valueStyle={{ color: '#3f8600' }}
              />
            </Col>
            <Col span={8}>
              <Statistic
                title="本月ROI"
                value={expenseData.roi_month || 0}
                precision={2}
              />
            </Col>
          </Row>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="本季度费用">
              ${(expenseData.cost_quarter || 0).toFixed(2)}
            </Descriptions.Item>
            <Descriptions.Item label="本季度佣金">
              ${(expenseData.commission_quarter || 0).toFixed(2)}
            </Descriptions.Item>
            <Descriptions.Item label="本年度费用">
              ${(expenseData.cost_year || 0).toFixed(2)}
            </Descriptions.Item>
            <Descriptions.Item label="本年度佣金">
              ${(expenseData.commission_year || 0).toFixed(2)}
            </Descriptions.Item>
          </Descriptions>
        </div>
      ) : (
        <p>暂无收益数据</p>
      ),
    },
  ]

  return (
    <div>
      {/* 头部信息 */}
      <Card style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/employees')}
          >
            返回员工列表
          </Button>
          
          <Row gutter={24} align="middle">
            <Col>
              <h2 style={{ margin: 0 }}>员工: {employee.username}</h2>
            </Col>
            <Col>
              <Tag color="blue">
                {employee.role === 'manager' ? '经理' : '员工'}
              </Tag>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={12} sm={6}>
              <Statistic
                title="本月费用"
                value={expenseData?.cost_month || 0}
                precision={2}
                prefix="$"
                valueStyle={{ color: '#cf1322', fontSize: 20 }}
              />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="本月佣金"
                value={expenseData?.commission_month || 0}
                precision={2}
                prefix="$"
                valueStyle={{ color: '#3f8600', fontSize: 20 }}
              />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="MCC数量"
                value={mccAccounts.length}
                valueStyle={{ fontSize: 20 }}
              />
            </Col>
            <Col xs={12} sm={6}>
              <Statistic
                title="平台账号数"
                value={platformAccounts.length}
                valueStyle={{ fontSize: 20 }}
              />
            </Col>
          </Row>
        </Space>
      </Card>

      {/* Tab内容 */}
      <Card>
        <Tabs items={tabItems} />
      </Card>
    </div>
  )
}

export default EmployeeDetail

