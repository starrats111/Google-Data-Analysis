import React, { useState, useEffect } from 'react'
import { Card, Table, DatePicker, Space, Spin, message, Button, Typography, Row, Col, Statistic } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'

const { Title } = Typography

const ReportMonthly = () => {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [selectedDate, setSelectedDate] = useState(dayjs())

  const fetchData = async () => {
    setLoading(true)
    try {
      const year = selectedDate.year()
      const month = selectedDate.month() + 1
      const response = await api.get(`/api/reports/monthly?year=${year}&month=${month}`)
      setData(response.data)
    } catch (error) {
      console.error('获取月报失败:', error)
      message.error('获取月报失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [selectedDate])

  const columns = [
    {
      title: '员工',
      dataIndex: 'employee',
      key: 'employee',
      width: 100,
      fixed: 'left'
    },
    {
      title: '广告费($)',
      dataIndex: 'ad_cost',
      key: 'ad_cost',
      width: 120,
      align: 'right',
      render: (value) => <span style={{ color: '#cf1322' }}>{value?.toFixed(2)}</span>
    },
    {
      title: '账面佣金($)',
      dataIndex: 'book_commission',
      key: 'book_commission',
      width: 120,
      align: 'right',
      render: (value) => <span style={{ color: '#3f8600' }}>{value?.toFixed(2)}</span>
    },
    {
      title: '失效佣金($)',
      dataIndex: 'rejected_commission',
      key: 'rejected_commission',
      width: 120,
      align: 'right',
      render: (value) => <span style={{ color: '#ff4d4f' }}>{value?.toFixed(2)}</span>
    },
    {
      title: '有效佣金($)',
      dataIndex: 'valid_commission',
      key: 'valid_commission',
      width: 120,
      align: 'right',
      render: (value) => <span style={{ color: '#1677ff' }}>{value?.toFixed(2)}</span>
    },
    {
      title: '订单数',
      dataIndex: 'orders',
      key: 'orders',
      width: 80,
      align: 'center'
    },
    {
      title: '在跑广告量',
      dataIndex: 'active_campaigns',
      key: 'active_campaigns',
      width: 100,
      align: 'center'
    }
  ]

  const handleExport = () => {
    if (!data || !data.data) {
      message.warning('没有数据可导出')
      return
    }

    // 构建CSV数据
    const headers = ['员工', '广告费($)', '账面佣金($)', '失效佣金($)', '有效佣金($)', '订单数', '在跑广告量']
    
    let csvContent = '\uFEFF' // UTF-8 BOM
    csvContent += headers.join(',') + '\n'
    
    data.data.forEach(row => {
      const rowData = [
        row.employee,
        row.ad_cost?.toFixed(2),
        row.book_commission?.toFixed(2),
        row.rejected_commission?.toFixed(2),
        row.valid_commission?.toFixed(2),
        row.orders,
        row.active_campaigns
      ]
      csvContent += rowData.map(cell => `"${cell || ''}"`).join(',') + '\n'
    })
    
    // 添加合计行
    const s = data.summary
    csvContent += `"合计","${s.total_ad_cost?.toFixed(2)}","${s.total_book_commission?.toFixed(2)}","${s.total_rejected_commission?.toFixed(2)}","${s.total_valid_commission?.toFixed(2)}","${s.total_orders}","${s.total_active_campaigns}"\n`
    
    // 下载文件
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.setAttribute('href', url)
    link.setAttribute('download', `月度报表_${data.period || selectedDate.format('YYYY年MM月')}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    message.success('导出成功')
  }

  return (
    <div style={{ padding: '24px' }}>
      <Card>
        <div style={{ marginBottom: 24 }}>
          <Row justify="space-between" align="middle">
            <Col>
              <Title level={4} style={{ margin: 0 }}>
                {data?.period || '本月报表'}
              </Title>
            </Col>
            <Col>
              <Space>
                <DatePicker 
                  picker="month" 
                  value={selectedDate}
                  onChange={(date) => setSelectedDate(date || dayjs())}
                  allowClear={false}
                />
                <Button icon={<ReloadOutlined />} onClick={fetchData}>
                  刷新
                </Button>
                <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport}>
                  导出CSV
                </Button>
              </Space>
            </Col>
          </Row>
        </div>

        {/* 汇总统计 */}
        {data?.summary && (
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={4}>
              <Card size="small">
                <Statistic 
                  title="总广告费" 
                  value={data.summary.total_ad_cost} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#cf1322', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small">
                <Statistic 
                  title="总账面佣金" 
                  value={data.summary.total_book_commission} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#3f8600', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small">
                <Statistic 
                  title="总失效佣金" 
                  value={data.summary.total_rejected_commission} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#ff4d4f', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small">
                <Statistic 
                  title="总有效佣金" 
                  value={data.summary.total_valid_commission} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#1677ff', fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small">
                <Statistic 
                  title="总订单数" 
                  value={data.summary.total_orders}
                  valueStyle={{ fontSize: 18 }}
                />
              </Card>
            </Col>
            <Col span={4}>
              <Card size="small">
                <Statistic 
                  title="总在跑广告" 
                  value={data.summary.total_active_campaigns}
                  valueStyle={{ fontSize: 18 }}
                />
              </Card>
            </Col>
          </Row>
        )}

        <Spin spinning={loading}>
          <Table
            columns={columns}
            dataSource={data?.data?.map((item, index) => ({ ...item, key: index }))}
            pagination={false}
            bordered
            size="middle"
            scroll={{ x: 800 }}
            summary={() => data?.summary ? (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}><strong>合计</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <strong style={{ color: '#cf1322' }}>${data.summary.total_ad_cost?.toFixed(2)}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">
                    <strong style={{ color: '#3f8600' }}>${data.summary.total_book_commission?.toFixed(2)}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">
                    <strong style={{ color: '#ff4d4f' }}>${data.summary.total_rejected_commission?.toFixed(2)}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">
                    <strong style={{ color: '#1677ff' }}>${data.summary.total_valid_commission?.toFixed(2)}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="center">
                    <strong>{data.summary.total_orders}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="center">
                    <strong>{data.summary.total_active_campaigns}</strong>
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            ) : null}
          />
        </Spin>
      </Card>
    </div>
  )
}

export default ReportMonthly
