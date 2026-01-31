import React, { useState, useEffect } from 'react'
import { Card, Table, message, Tag, Space } from 'antd'
import { useSearchParams, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import api from '../services/api'

export default function RejectionDetails() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState([])

  useEffect(() => {
    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    const platform = searchParams.get('platform')

    if (startDate && endDate) {
      fetchRejectionDetails(startDate, endDate, platform)
    } else {
      message.warning('缺少日期参数')
    }
  }, [searchParams])

  const fetchRejectionDetails = async (startDate, endDate, platform) => {
    setLoading(true)
    try {
      const params = {
        start_date: startDate,
        end_date: endDate
      }
      if (platform) {
        params.platform = platform
      }

      const response = await api.get('/api/affiliate-transactions/rejections', { params })
      setData(response.data || [])

      if (response.data && response.data.length > 0) {
        message.success(`找到 ${response.data.length} 条拒付记录`)
      } else {
        message.info('未找到拒付记录')
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '查询失败')
    } finally {
      setLoading(false)
    }
  }

  const columns = [
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 120,
      render: (val) => <Tag color="blue">{val}</Tag>
    },
    {
      title: '商户',
      dataIndex: 'merchant',
      key: 'merchant',
      width: 150,
      render: (val) => val || '-'
    },
    {
      title: '交易ID',
      dataIndex: 'transaction_id',
      key: 'transaction_id',
      width: 200,
    },
    {
      title: '交易时间',
      dataIndex: 'transaction_time',
      key: 'transaction_time',
      width: 180,
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'
    },
    {
      title: '订单金额',
      dataIndex: 'order_amount',
      key: 'order_amount',
      width: 120,
      align: 'right',
      render: (val) => `$${(val || 0).toFixed(2)}`
    },
    {
      title: '拒付佣金',
      dataIndex: 'commission_amount',
      key: 'commission_amount',
      width: 120,
      align: 'right',
      render: (val) => (
        <span style={{ color: '#ff4d4f', fontWeight: 'bold' }}>
          ${(val || 0).toFixed(2)}
        </span>
      )
    },
    {
      title: '拒付原因',
      dataIndex: 'reject_reason',
      key: 'reject_reason',
      width: 300,
      render: (val) => val || '-'
    },
    {
      title: '拒付时间',
      dataIndex: 'reject_time',
      key: 'reject_time',
      width: 180,
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'
    }
  ]

  const totalRejectedCommission = data.reduce((sum, item) => sum + (item.commission_amount || 0), 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>拒付详情</h2>
        <Space>
          <span style={{ color: '#666' }}>总拒付佣金：</span>
          <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#ff4d4f' }}>
            ${totalRejectedCommission.toFixed(2)}
          </span>
        </Space>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={data}
          loading={loading}
          rowKey={(record) => `${record.platform}-${record.transaction_id}`}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条拒付记录`,
          }}
          scroll={{ x: 1200 }}
          locale={{
            emptyText: '未找到拒付记录'
          }}
        />
      </Card>
    </div>
  )
}

