import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Form, Select, DatePicker, message, Tag, Space, Input } from 'antd'
import { SearchOutlined, DownloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker

export default function PlatformData() {
  const { user } = useAuth()
  
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [accounts, setAccounts] = useState([])
  const [form] = Form.useForm()

  useEffect(() => {
    fetchPlatforms()
    fetchAccounts()
    // 默认查询最近7天的数据
    const endDate = dayjs()
    const beginDate = endDate.subtract(7, 'day')
    form.setFieldsValue({
      dateRange: [beginDate, endDate]
    })
    handleSearch({ dateRange: [beginDate, endDate] })
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
      
      if (values.platform_id) {
        params.platform_id = values.platform_id
      }
      
      if (values.account_id) {
        params.account_id = values.account_id
      }
      
      if (values.dateRange && values.dateRange.length === 2) {
        params.begin_date = values.dateRange[0].format('YYYY-MM-DD')
        params.end_date = values.dateRange[1].format('YYYY-MM-DD')
      }
      
      const response = await api.get('/api/platform-data', { params })
      setData(response.data || [])
      
      if (response.data && response.data.length > 0) {
        message.success(`找到 ${response.data.length} 条记录`)
      } else {
        message.info('未找到数据')
      }
    } catch (error) {
      message.error(error.response?.data?.detail || '查询失败')
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async () => {
    const values = form.getFieldsValue()
    const params = {}
    
    if (values.platform_id) {
      params.platform_id = values.platform_id
    }
    
    if (values.account_id) {
      params.account_id = values.account_id
    }
    
    if (values.dateRange && values.dateRange.length === 2) {
      params.begin_date = values.dateRange[0].format('YYYY-MM-DD')
      params.end_date = values.dateRange[1].format('YYYY-MM-DD')
    }
    
    try {
      const response = await api.get('/api/platform-data', { 
        params,
        responseType: 'blob'
      })
      
      // 创建下载链接
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `平台数据_${dayjs().format('YYYY-MM-DD')}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      
      message.success('导出成功')
    } catch (error) {
      message.error('导出失败')
    }
  }

  const columns = [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      sorter: (a, b) => dayjs(a.date).unix() - dayjs(b.date).unix(),
    },
    {
      title: '平台',
      dataIndex: 'platform_name',
      key: 'platform_name',
      filters: [...new Set(data.map(d => d.platform_name))].map(name => ({
        text: name,
        value: name,
      })),
      onFilter: (value, record) => record.platform_name === value,
    },
    {
      title: '账号',
      dataIndex: 'account_name',
      key: 'account_name',
    },
    {
      title: '佣金',
      dataIndex: 'commission',
      key: 'commission',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`,
      sorter: (a, b) => a.commission - b.commission,
    },
    {
      title: '订单数',
      dataIndex: 'orders',
      key: 'orders',
      sorter: (a, b) => a.orders - b.orders,
    },
    {
      title: '本周出单天数',
      dataIndex: 'order_days_this_week',
      key: 'order_days_this_week',
      render: (val) => `${val || 0} 天`
    },
    {
      title: '最后同步时间',
      dataIndex: 'last_sync_at',
      key: 'last_sync_at',
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'
    },
  ]

  // 计算汇总数据
  const totalCommission = data.reduce((sum, item) => sum + (item.commission || 0), 0)
  const totalOrders = data.reduce((sum, item) => sum + (item.orders || 0), 0)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>平台数据</h2>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={handleExport}
        >
          导出数据
        </Button>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={handleSearch}
        >
          <Form.Item
            name="platform_id"
            label="平台"
          >
            <Select
              placeholder="选择平台"
              style={{ width: 150 }}
              allowClear
            >
              {platforms.map(platform => (
                <Select.Option key={platform.id} value={platform.id}>
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

      {data.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <Space size="large">
            <div>
              <span style={{ color: '#666' }}>总佣金：</span>
              <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
                ${totalCommission.toFixed(2)}
              </span>
            </div>
            <div>
              <span style={{ color: '#666' }}>总订单数：</span>
              <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#52c41a' }}>
                {totalOrders}
              </span>
            </div>
            <div>
              <span style={{ color: '#666' }}>记录数：</span>
              <span style={{ fontSize: '18px', fontWeight: 'bold' }}>
                {data.length}
              </span>
            </div>
          </Space>
        </Card>
      )}

      <Card>
        <Table
          columns={columns}
          dataSource={data}
          loading={loading}
          rowKey="id"
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条记录`,
          }}
          locale={{
            emptyText: '请选择筛选条件并点击查询'
          }}
        />
      </Card>
    </div>
  )
}


