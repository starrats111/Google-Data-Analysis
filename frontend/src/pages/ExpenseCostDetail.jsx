import React, { useState, useEffect } from 'react'
import { Card, Table, Tag, Statistic, Row, Col, message, InputNumber, Button, Space, Modal, DatePicker, Select, Form } from 'antd'
import { useSearchParams } from 'react-router-dom'
import dayjs from 'dayjs'
import api from '../services/api'

const { RangePicker } = DatePicker
const { Option } = Select

export default function ExpenseCostDetail() {
  const [searchParams] = useSearchParams()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState(null)
  const [mccAccounts, setMccAccounts] = useState([])
  const [uploadModalVisible, setUploadModalVisible] = useState(false)
  const [uploadForm, setUploadForm] = useState({
    mcc_id: null,
    date: null,
    manual_cost: 0
  })

  const startDate = searchParams.get('start_date') || ''
  const endDate = searchParams.get('end_date') || ''

  useEffect(() => {
    if (startDate && endDate) {
      fetchData()
      fetchMccAccounts()
    }
  }, [startDate, endDate])

  const fetchMccAccounts = async () => {
    try {
      const response = await api.get('/api/mcc/accounts')
      setMccAccounts(response.data || [])
    } catch (error) {
      console.error('获取MCC账号列表失败', error)
    }
  }

  const handleUploadMccCost = async () => {
    if (!uploadForm.mcc_id || !uploadForm.date) {
      message.warning('请选择MCC账号和日期')
      return
    }
    try {
      await api.post('/api/expenses/mcc-cost', {
        mcc_id: uploadForm.mcc_id,
        date: uploadForm.date.format('YYYY-MM-DD'),
        manual_cost: uploadForm.manual_cost || 0
      })
      message.success('上传成功')
      setUploadModalVisible(false)
      setUploadForm({ mcc_id: null, date: null, manual_cost: 0 })
      fetchData()
    } catch (error) {
      message.error(error.response?.data?.detail || '上传失败')
    }
  }

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
      title: 'API费用',
      dataIndex: 'api_cost',
      key: 'api_cost',
      align: 'right',
      render: (val) => `$${(val || 0).toFixed(2)}`
    },
    {
      title: '手动费用',
      dataIndex: 'manual_cost',
      key: 'manual_cost',
      align: 'right',
      render: (val) => val > 0 ? <span style={{ color: '#52c41a' }}>${(val || 0).toFixed(2)}</span> : <span>${(val || 0).toFixed(2)}</span>
    },
    {
      title: '总费用',
      dataIndex: 'total_cost',
      key: 'total_cost',
      align: 'right',
      render: (val) => <strong>${(val || 0).toFixed(2)}</strong>
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

  const platformDetailColumns = [
    {
      title: '平台',
      dataIndex: 'platform_name',
      key: 'platform_name',
      render: (val, record) => <Tag color="blue">{record.platform_code}</Tag>
    },
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
    },
    {
      title: '广告系列数',
      dataIndex: 'campaign_count',
      key: 'campaign_count',
      align: 'right',
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0 }}>广告费用详情</h2>
            <p style={{ margin: '8px 0 0 0' }}>日期范围：{startDate} ~ {endDate}</p>
          </div>
          <Button type="primary" onClick={() => setUploadModalVisible(true)}>
            上传MCC费用
          </Button>
        </div>
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
                  valueStyle={{ color: '#4DA6FF', fontSize: '24px' }}
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

          <Card title="按平台汇总" style={{ marginBottom: 16 }}>
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

          {data.platform_details && data.platform_details.length > 0 && (
            <Card title="平台费用明细（按日期细分）">
              <Table
                columns={platformDetailColumns}
                dataSource={data.platform_details}
                loading={loading}
                rowKey={(record, index) => `${record.platform_code}-${record.date}-${index}`}
                pagination={{ pageSize: 20, showSizeChanger: true }}
              />
            </Card>
          )}
        </>
      )}

      <Modal
        title="上传MCC费用"
        open={uploadModalVisible}
        onOk={handleUploadMccCost}
        onCancel={() => {
          setUploadModalVisible(false)
          setUploadForm({ mcc_id: null, date: null, manual_cost: 0 })
        }}
        okText="保存"
        cancelText="取消"
      >
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div>
            <label style={{ display: 'block', marginBottom: '8px' }}>MCC账号：</label>
            <Select
              style={{ width: '100%' }}
              placeholder="请选择MCC账号"
              value={uploadForm.mcc_id}
              onChange={(val) => setUploadForm({ ...uploadForm, mcc_id: val })}
            >
              {mccAccounts.map(mcc => (
                <Option key={mcc.id} value={mcc.id}>
                  {mcc.mcc_name} ({mcc.email})
                </Option>
              ))}
            </Select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px' }}>日期：</label>
            <DatePicker
              style={{ width: '100%' }}
              value={uploadForm.date}
              onChange={(date) => setUploadForm({ ...uploadForm, date })}
              format="YYYY-MM-DD"
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px' }}>费用：</label>
            <InputNumber
              style={{ width: '100%' }}
              value={uploadForm.manual_cost}
              onChange={(val) => setUploadForm({ ...uploadForm, manual_cost: val || 0 })}
              min={0}
              step={0.01}
              precision={2}
              prefix="$"
            />
          </div>
        </Space>
      </Modal>
    </div>
  )
}

