import React, { useState, useEffect } from 'react'
import { Card, Table, DatePicker, Space, Spin, message, Button, Typography, Row, Col, Statistic } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'

const { Title } = Typography

const FinancialReport = () => {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [selectedDate, setSelectedDate] = useState(dayjs())

  const fetchData = async () => {
    setLoading(true)
    try {
      const year = selectedDate.year()
      const month = selectedDate.month() + 1
      const response = await api.get(`/api/reports/financial?year=${year}&month=${month}`)
      setData(response.data)
    } catch (error) {
      console.error('获取财务报表失败:', error)
      message.error('获取财务报表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [selectedDate])

  // 将数据转换为表格格式（支持合并单元格）
  const getTableData = () => {
    if (!data || !data.data) return []
    
    const tableData = []
    let rowIndex = 0
    
    data.data.forEach((emp) => {
      const accountCount = emp.accounts.length || 1
      
      if (emp.accounts.length === 0) {
        // 没有账号的员工
        tableData.push({
          key: rowIndex++,
          employee: emp.employee,
          ad_cost: emp.ad_cost,
          platform: '-',
          account_name: '-',
          book_commission: 0,
          rejected_commission: 0,
          rowSpan: 1,
          isFirst: true
        })
      } else {
        emp.accounts.forEach((acc, idx) => {
          tableData.push({
            key: rowIndex++,
            employee: emp.employee,
            ad_cost: emp.ad_cost,
            platform: acc.platform,
            account_name: acc.account_name,
            book_commission: acc.book_commission,
            rejected_commission: acc.rejected_commission,
            rowSpan: idx === 0 ? accountCount : 0,
            isFirst: idx === 0
          })
        })
      }
    })
    
    return tableData
  }

  const columns = [
    {
      title: '员工',
      dataIndex: 'employee',
      key: 'employee',
      width: 100,
      fixed: 'left',
      onCell: (record) => ({
        rowSpan: record.rowSpan
      }),
      render: (text, record) => record.isFirst ? text : null
    },
    {
      title: '广告费($)',
      dataIndex: 'ad_cost',
      key: 'ad_cost',
      width: 120,
      align: 'right',
      onCell: (record) => ({
        rowSpan: record.rowSpan
      }),
      render: (value, record) => record.isFirst ? value?.toFixed(2) : null
    },
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 80,
      align: 'center'
    },
    {
      title: '账号',
      dataIndex: 'account_name',
      key: 'account_name',
      width: 150
    },
    {
      title: '账面佣金($)',
      dataIndex: 'book_commission',
      key: 'book_commission',
      width: 120,
      align: 'right',
      render: (value) => value?.toFixed(2)
    },
    {
      title: '失效佣金($)',
      dataIndex: 'rejected_commission',
      key: 'rejected_commission',
      width: 120,
      align: 'right',
      render: (value) => <span style={{ color: value > 0 ? '#ff4d4f' : 'inherit' }}>{value?.toFixed(2)}</span>
    }
  ]

  const handleExport = async () => {
    if (!data || !data.data) {
      message.warning('没有数据可导出')
      return
    }

    const year = selectedDate.year()
    const month = selectedDate.month() + 1
    
    try {
      message.loading({ content: '正在生成Excel...', key: 'export' })
      
      // 调用后端API下载Excel
      const response = await api.get(`/api/reports/financial/export?year=${year}&month=${month}`, {
        responseType: 'blob'
      })
      
      // 创建下载链接
      const blob = new Blob([response.data], { 
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `财务报表_${year}年${month.toString().padStart(2, '0')}月.xlsx`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)
      
      message.success({ content: '导出成功', key: 'export' })
    } catch (error) {
      console.error('导出失败:', error)
      message.error({ content: '导出失败: ' + (error.response?.data?.detail || error.message), key: 'export' })
    }
  }

  return (
    <div style={{ padding: '24px' }}>
      <Card>
        <div style={{ marginBottom: 24 }}>
          <Row justify="space-between" align="middle">
            <Col>
              <Title level={4} style={{ margin: 0 }}>财务报表</Title>
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
                  导出Excel
                </Button>
              </Space>
            </Col>
          </Row>
        </div>

        {/* 汇总统计 */}
        {data?.summary && (
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={6}>
              <Card size="small">
                <Statistic 
                  title="总广告费" 
                  value={data.summary.total_ad_cost} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#cf1322' }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic 
                  title="总账面佣金" 
                  value={data.summary.total_book_commission} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#3f8600' }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic 
                  title="总失效佣金" 
                  value={data.summary.total_rejected_commission} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#ff4d4f' }}
                />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic 
                  title="总有效佣金" 
                  value={data.summary.total_valid_commission} 
                  precision={2} 
                  prefix="$"
                  valueStyle={{ color: '#1677ff' }}
                />
              </Card>
            </Col>
          </Row>
        )}

        {/* 移动端表格滚动提示 */}
        <div className="table-scroll-hint">👆 左右滑动查看完整表格 👆</div>

        <Spin spinning={loading}>
          <Table
            columns={columns}
            dataSource={getTableData()}
            pagination={false}
            bordered
            size="middle"
            scroll={{ x: 800 }}
            summary={() => data?.summary ? (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}><strong>合计</strong></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <strong>${data.summary.total_ad_cost?.toFixed(2)}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} />
                  <Table.Summary.Cell index={3} />
                  <Table.Summary.Cell index={4} align="right">
                    <strong>${data.summary.total_book_commission?.toFixed(2)}</strong>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">
                    <strong style={{ color: '#ff4d4f' }}>${data.summary.total_rejected_commission?.toFixed(2)}</strong>
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

export default FinancialReport
