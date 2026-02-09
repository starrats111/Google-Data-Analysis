import React, { useState, useEffect } from 'react'
import { Card, Table, Tag, Button, Space, Statistic, Row, Col, Skeleton, Input } from 'antd'
import { EyeOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'

const EmployeeList = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [employees, setEmployees] = useState([])
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    fetchEmployees()
  }, [])

  const fetchEmployees = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/dashboard/employees')
      setEmployees(response.data || [])
    } catch (error) {
      console.error('获取员工列表失败:', error)
    } finally {
      setLoading(false)
    }
  }

  // 计算汇总
  const summary = {
    totalEmployees: employees.length,
    totalCost: employees.reduce((sum, emp) => sum + (emp.cost_month || 0), 0),
    totalCommission: employees.reduce((sum, emp) => sum + (emp.commission_month || 0), 0),
  }

  const columns = [
    {
      title: '员工',
      dataIndex: 'username',
      key: 'username',
      fixed: 'left',
      width: 120,
      filteredValue: searchText ? [searchText] : null,
      onFilter: (value, record) => 
        record.username?.toLowerCase().includes(value.toLowerCase()) ||
        record.real_name?.toLowerCase().includes(value.toLowerCase()),
      render: (text, record) => (
        <Button type="link" onClick={() => navigate(`/employees/${record.id}`)}>
          {text}
        </Button>
      ),
    },
    {
      title: 'MCC数量',
      dataIndex: 'mcc_count',
      key: 'mcc_count',
      width: 100,
      sorter: (a, b) => (a.mcc_count || 0) - (b.mcc_count || 0),
      render: (val) => <Tag color="blue">{val || 0}</Tag>,
    },
    {
      title: '平台数量',
      dataIndex: 'platform_count',
      key: 'platform_count',
      width: 100,
      sorter: (a, b) => (a.platform_count || 0) - (b.platform_count || 0),
      render: (val) => <Tag color="green">{val || 0}</Tag>,
    },
    {
      title: '本月费用($)',
      dataIndex: 'cost_month',
      key: 'cost_month',
      width: 120,
      sorter: (a, b) => (a.cost_month || 0) - (b.cost_month || 0),
      defaultSortOrder: 'descend',
      render: (val) => (
        <span style={{ color: '#cf1322' }}>${(val || 0).toFixed(2)}</span>
      ),
    },
    {
      title: '本月佣金($)',
      dataIndex: 'commission_month',
      key: 'commission_month',
      width: 120,
      sorter: (a, b) => (a.commission_month || 0) - (b.commission_month || 0),
      render: (val) => (
        <span style={{ color: '#3f8600' }}>${(val || 0).toFixed(2)}</span>
      ),
    },
    {
      title: '本月订单',
      dataIndex: 'orders_month',
      key: 'orders_month',
      width: 100,
      sorter: (a, b) => (a.orders_month || 0) - (b.orders_month || 0),
    },
    {
      title: '本月ROI',
      dataIndex: 'roi_month',
      key: 'roi_month',
      width: 100,
      sorter: (a, b) => (a.roi_month || 0) - (b.roi_month || 0),
      render: (val) => {
        const roi = val || 0
        const color = roi >= 1 ? '#3f8600' : roi >= 0.5 ? '#faad14' : '#cf1322'
        return <span style={{ color }}>{roi.toFixed(2)}</span>
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_, record) => (
        <Button
          type="primary"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => navigate(`/employees/${record.id}`)}
        >
          详情
        </Button>
      ),
    },
  ]

  const filteredEmployees = employees.filter(emp => 
    !searchText || 
    emp.username?.toLowerCase().includes(searchText.toLowerCase()) ||
    emp.real_name?.toLowerCase().includes(searchText.toLowerCase())
  )

  return (
    <div>
      {/* 汇总统计 */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="员工总数"
              value={summary.totalEmployees}
              suffix="人"
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="本月总费用"
              value={summary.totalCost}
              precision={2}
              prefix="$"
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title="本月总佣金"
              value={summary.totalCommission}
              precision={2}
              prefix="$"
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
      </Row>

      {/* 员工列表 */}
      <Card
        title="员工列表"
        extra={
          <Input
            placeholder="搜索员工"
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 200 }}
            allowClear
          />
        }
      >
        {loading ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <Table
            columns={columns}
            dataSource={filteredEmployees}
            rowKey="id"
            scroll={{ x: 900 }}
            pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 人` }}
          />
        )}
      </Card>
    </div>
  )
}

export default EmployeeList

