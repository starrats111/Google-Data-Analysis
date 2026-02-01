import React, { useState, useEffect } from 'react'
import { Card, Table, Tag, Statistic, Row, Col, message } from 'antd'
import { useSearchParams } from 'react-router-dom'
import api from '../services/api'

export default function ExpenseCostDetail() {
  const [searchParams] = useSearchParams()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)

  const startDate = searchParams.get('start_date') || ''
  const endDate = searchParams.get('end_date') || ''

  useEffect(() => {
    if (startDate && endDate) {
      fetchData()
    }
  }, [startDate, endDate])

  const fetchData = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/expenses/cost-detail', {
        params: {
          start_date: startDate,
          end_date: endDate
        }
      })
      setData(response.data)
    } catch (error) {
      message.error(error.response?.data?.detail || '获取费用详情失败')
    } finally {
      setLoading(false)
    }
  }

  const mccColumns = [
    {
      title: 'MCC名称',
      dataIndex: 'mcc_name',
      key: 'mcc_name',
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: '费用',
      dataIndex: 'total_cost',
      key: 'total_cost',
      align: 'right',
      render: (val) => `$${(val || 0).toFixed(2)}`
    }
  ]

  const platformColumns = [
    {
      title: '平台代码',
      dataIndex: 'platform_code',
      key: 'platform_code',
      render: (val) => <Tag color="blue">{val}</Tag>
    },
    {
      title: '平台名称',
      dataIndex: 'platform_name',
      key: 'platform_name',
    },
    {
      title: '费用',
      dataIndex: 'total_cost',
      key: 'total_cost',
      align: 'right',
      render: (val) => `$${(val || 0).toFixed(2)}`
    }
  ]

  return (
    <div style={{ padding: '24px' }}>
      <Card style={{ marginBottom: 16 }}>
        <h2>广告费用详情</h2>
        <p>日期范围：{startDate} ~ {endDate}</p>
      </Card>

      {data && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              <Col span={8}>
                <Statistic
                  title="总费用"
                  value={data.total_cost}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#1890ff', fontSize: '24px' }}
                />
              </Col>
              <Col span={8}>
                <Statistic
                  title="未匹配平台费用"
                  value={data.unmatched_cost}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#ff4d4f' }}
                />
              </Col>
            </Row>
          </Card>

          <Card title="按MCC账号汇总" style={{ marginBottom: 16 }}>
            <Table
              columns={mccColumns}
              dataSource={data.mcc_breakdown || []}
              loading={loading}
              rowKey="mcc_id"
              pagination={false}
            />
          </Card>

          <Card title="按平台汇总">
            <Table
              columns={platformColumns}
              dataSource={data.platform_breakdown || []}
              loading={loading}
              rowKey="platform_code"
              pagination={false}
            />
            {data.unmatched_cost > 0 && (
              <div style={{ marginTop: 16, padding: '12px', background: '#fff7e6', borderRadius: '4px' }}>
                <strong>未匹配平台费用：</strong>
                <span style={{ color: '#ff4d4f', fontSize: '16px', marginLeft: '8px' }}>
                  ${data.unmatched_cost.toFixed(2)}
                </span>
                <p style={{ marginTop: '8px', color: '#666', fontSize: '12px' }}>
                  这些费用来自无法从广告系列名中提取平台代码的广告系列
                </p>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}

