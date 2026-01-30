import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Form, Select, DatePicker, message, Tag, Space } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker

export default function MccDataAggregate() {
  const { user } = useAuth()
  
  const [loading, setLoading] = useState(false)
  const [aggregatedData, setAggregatedData] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [accounts, setAccounts] = useState([])
  const [form] = Form.useForm()

  useEffect(() => {
    fetchPlatforms()
    fetchAccounts()
  }, [])

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms')
      setPlatforms(response.data)
    } catch (error) {
      console.error('获取平台列表失败', error)
    }
  }

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/api/affiliate/accounts')
      setAccounts(response.data)
    } catch (error) {
      console.error('获取账号列表失败', error)
    }
  }

  const handleSearch = async (values) => {
    setLoading(true)
    try {
      const params = {}
      
      if (values.platform_code) {
        params.platform_code = values.platform_code
      }
      
      if (values.account_id) {
        params.account_id = values.account_id
      }
      
      if (values.dateRange && values.dateRange.length === 2) {
        params.begin_date = values.dateRange[0].format('YYYY-MM-DD')
        params.end_date = values.dateRange[1].format('YYYY-MM-DD')
      }
      
      const response = await api.get('/api/mcc/aggregate', { params })
      
      if (response.data.success) {
        setAggregatedData(response.data.data || [])
        message.success(`找到 ${response.data.aggregated_records} 条聚合数据`)
      } else {
        message.error('查询失败')
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
      dataIndex: 'platform_name',
      key: 'platform_name',
    },
    {
      title: '账号',
      dataIndex: 'account_name',
      key: 'account_name',
    },
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
    },
    {
      title: '预算',
      dataIndex: 'budget',
      key: 'budget',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`
    },
    {
      title: '费用',
      dataIndex: 'cost',
      key: 'cost',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`
    },
    {
      title: '展示',
      dataIndex: 'impressions',
      key: 'impressions',
      render: (val) => val?.toLocaleString() || '0'
    },
    {
      title: '点击',
      dataIndex: 'clicks',
      key: 'clicks',
      render: (val) => val?.toLocaleString() || '0'
    },
    {
      title: 'CPC',
      dataIndex: 'cpc',
      key: 'cpc',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`
    },
    {
      title: '广告系列数',
      dataIndex: 'campaigns',
      key: 'campaigns',
      render: (campaigns) => campaigns?.length || 0
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>MCC数据聚合</h2>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={handleSearch}
        >
          <Form.Item
            name="platform_code"
            label="平台"
          >
            <Select
              placeholder="选择平台"
              style={{ width: 150 }}
              allowClear
            >
              {platforms.map(platform => (
                <Select.Option key={platform.id} value={platform.platform_code}>
                  {platform.platform_name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="account_id"
            label="账号"
          >
            <Select
              placeholder="选择账号"
              style={{ width: 150 }}
              allowClear
            >
              {accounts.map(account => (
                <Select.Option key={account.id} value={account.id}>
                  {account.account_name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="dateRange"
            label="日期范围"
          >
            <RangePicker
              format="YYYY-MM-DD"
              disabledDate={(current) => current && current > dayjs().endOf('day')}
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SearchOutlined />}
              loading={loading}
            >
              查询
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card>
        <Table
          columns={columns}
          dataSource={aggregatedData}
          loading={loading}
          rowKey={(record) => `${record.platform_code}_${record.account_id}_${record.date}`}
          expandable={{
            expandedRowRender: (record) => (
              <div style={{ margin: 0 }}>
                <h4>广告系列明细：</h4>
                <Table
                  dataSource={record.campaigns || []}
                  columns={[
                    { title: '广告系列ID', dataIndex: 'campaign_id', key: 'campaign_id' },
                    { title: '广告系列名', dataIndex: 'campaign_name', key: 'campaign_name' },
                    { title: '费用', dataIndex: 'cost', key: 'cost', render: (v) => `$${v?.toFixed(2) || '0.00'}` },
                    { title: '展示', dataIndex: 'impressions', key: 'impressions', render: (v) => v?.toLocaleString() || '0' },
                    { title: '点击', dataIndex: 'clicks', key: 'clicks', render: (v) => v?.toLocaleString() || '0' },
                  ]}
                  pagination={false}
                  size="small"
                  rowKey="campaign_id"
                />
              </div>
            ),
            rowExpandable: (record) => record.campaigns && record.campaigns.length > 0,
          }}
          locale={{
            emptyText: '请选择筛选条件并点击查询'
          }}
        />
      </Card>
    </div>
  )
}


