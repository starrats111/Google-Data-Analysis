import React, { useEffect, useState } from 'react'
import { Card, Row, Col, Table, message } from 'antd'
import { useAuth } from '../store/authStore'
import api from '../services/api'

const Dashboard = () => {
  const { user } = useAuth()
  const [overviewData, setOverviewData] = useState(null)
  const [employeeData, setEmployeeData] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user?.role === 'manager') {
      fetchManagerData()
    } else {
      fetchEmployeeData()
    }
  }, [user])

  const fetchManagerData = async () => {
    setLoading(true)
    try {
      const [overviewRes, employeesRes] = await Promise.all([
        api.get('/api/dashboard/overview'),
        api.get('/api/dashboard/employees'),
      ])
      setOverviewData(overviewRes.data)
      setEmployeeData(employeesRes.data)
    } catch (error) {
      message.error('获取数据失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchEmployeeData = async () => {
    // 员工个人数据
    setLoading(true)
    try {
      const response = await api.get('/api/user/statistics')
      setOverviewData(response.data)
    } catch (error) {
      message.error('获取数据失败')
    } finally {
      setLoading(false)
    }
  }

  if (user?.role === 'manager') {
    const columns = [
      { title: '员工编号', dataIndex: 'employee_id', key: 'employee_id' },
      { title: '用户名', dataIndex: 'username', key: 'username' },
      { title: '上传次数', dataIndex: 'upload_count', key: 'upload_count' },
      { title: '分析次数', dataIndex: 'analysis_count', key: 'analysis_count' },
      { title: '最后上传时间', dataIndex: 'last_upload', key: 'last_upload' },
    ]

    return (
      <div>
        <h2>数据总览</h2>
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card title="总上传数" bordered={false}>
              {overviewData?.total_uploads || 0}
            </Card>
          </Col>
          <Col span={6}>
            <Card title="总分析数" bordered={false}>
              {overviewData?.total_analyses || 0}
            </Card>
          </Col>
          <Col span={6}>
            <Card title="活跃员工" bordered={false}>
              {overviewData?.active_employees || 0}
            </Card>
          </Col>
          <Col span={6}>
            <Card title="今日上传" bordered={false}>
              {overviewData?.today_uploads || 0}
            </Card>
          </Col>
        </Row>

        <Card title="员工数据总览">
          <Table
            columns={columns}
            dataSource={employeeData}
            loading={loading}
            rowKey="employee_id"
          />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <h2>我的数据</h2>
      <Card>
        <p>欢迎，{user?.username}！</p>
        <p>这里是您的个人数据总览。</p>
      </Card>
    </div>
  )
}

export default Dashboard












