import React, { useState, useEffect } from 'react'
import { Card, Table, Button, Form, Select, DatePicker, message, Tag, Space, Input } from 'antd'
import { SearchOutlined, DownloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker

export default function GoogleAdsData() {
  const { user } = useAuth()
  
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState([])
  const [mccAccounts, setMccAccounts] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [form] = Form.useForm()

  useEffect(() => {
    fetchMccAccounts()
    fetchPlatforms()
    // 默认查询最近7天的数据
    const endDate = dayjs()
    const beginDate = endDate.subtract(7, 'day')
    form.setFieldsValue({
      dateRange: [beginDate, endDate]
    })
    handleSearch({ dateRange: [beginDate, endDate] })
  }, [])

  const fetchMccAccounts = async () => {
    try {
      const response = await api.get('/api/mcc/accounts')
      setMccAccounts(response.data)
    } catch (error) {
      console.error('获取MCC账号列表失败', error)
    }
  }

  const fetchPlatforms = async () => {
    try {
      const response = await api.get('/api/affiliate/platforms')
      setPlatforms(response.data)
    } catch (error) {
      console.error('获取平台列表失败', error)
    }
  }

  const handleSearch = async (values) => {
    setLoading(true)
    try {
      const params = {}
      
      if (values.mcc_id) {
        params.mcc_id = values.mcc_id
      }
      
      if (values.platform_code) {
        params.platform_code = values.platform_code
      }
      
      if (values.dateRange && values.dateRange.length === 2) {
        params.begin_date = values.dateRange[0].format('YYYY-MM-DD')
        params.end_date = values.dateRange[1].format('YYYY-MM-DD')
      }
      
      const response = await api.get('/api/google-ads-data', { params })
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
    
    if (values.mcc_id) {
      params.mcc_id = values.mcc_id
    }
    
    if (values.platform_code) {
      params.platform_code = values.platform_code
    }
    
    if (values.dateRange && values.dateRange.length === 2) {
      params.begin_date = values.dateRange[0].format('YYYY-MM-DD')
      params.end_date = values.dateRange[1].format('YYYY-MM-DD')
    }
    
    try {
      const response = await api.get('/api/google-ads-data', { 
        params,
        responseType: 'blob'
      })
      
      // 创建下载链接
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `Google Ads数据_${dayjs().format('YYYY-MM-DD')}.xlsx`)
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
      title: 'MCC',
      dataIndex: 'mcc_name',
      key: 'mcc_name',
      filters: [...new Set(data.map(d => d.mcc_name))].map(name => ({
        text: name,
        value: name,
      })),
      onFilter: (value, record) => record.mcc_name === value,
    },
    {
      title: '广告系列ID',
      dataIndex: 'campaign_id',
      key: 'campaign_id',
    },
    {
      title: '广告系列名',
      dataIndex: 'campaign_name',
      key: 'campaign_name',
    },
    {
      title: '平台',
      dataIndex: 'extracted_platform_code',
      key: 'extracted_platform_code',
      render: (val) => val ? <Tag color="blue">{val}</Tag> : <Tag>未匹配</Tag>,
      filters: [...new Set(data.map(d => d.extracted_platform_code).filter(Boolean))].map(code => ({
        text: code,
        value: code,
      })),
      onFilter: (value, record) => record.extracted_platform_code === value,
    },
    {
      title: '账号代码',
      dataIndex: 'extracted_account_code',
      key: 'extracted_account_code',
      render: (val) => val || '-'
    },
    {
      title: '预算',
      dataIndex: 'budget',
      key: 'budget',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`,
      sorter: (a, b) => a.budget - b.budget,
    },
    {
      title: '费用',
      dataIndex: 'cost',
      key: 'cost',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`,
      sorter: (a, b) => a.cost - b.cost,
    },
    {
      title: '展示',
      dataIndex: 'impressions',
      key: 'impressions',
      render: (val) => val?.toLocaleString() || '0',
      sorter: (a, b) => a.impressions - b.impressions,
    },
    {
      title: '点击',
      dataIndex: 'clicks',
      key: 'clicks',
      render: (val) => val?.toLocaleString() || '0',
      sorter: (a, b) => a.clicks - b.clicks,
    },
    {
      title: 'CPC',
      dataIndex: 'cpc',
      key: 'cpc',
      render: (val) => `$${val?.toFixed(2) || '0.00'}`,
      sorter: (a, b) => a.cpc - b.cpc,
    },
    {
      title: 'IS Budget丢失',
      dataIndex: 'is_budget_lost',
      key: 'is_budget_lost',
      render: (val) => `${(val * 100)?.toFixed(2) || '0.00'}%`,
      sorter: (a, b) => a.is_budget_lost - b.is_budget_lost,
    },
    {
      title: 'IS Rank丢失',
      dataIndex: 'is_rank_lost',
      key: 'is_rank_lost',
      render: (val) => `${(val * 100)?.toFixed(2) || '0.00'}%`,
      sorter: (a, b) => a.is_rank_lost - b.is_rank_lost,
    },
    {
      title: '最后同步时间',
      dataIndex: 'last_sync_at',
      key: 'last_sync_at',
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm:ss') : '-'
    },
  ]

  // 计算汇总数据
  const totalCost = data.reduce((sum, item) => sum + (item.cost || 0), 0)
  const totalImpressions = data.reduce((sum, item) => sum + (item.impressions || 0), 0)
  const totalClicks = data.reduce((sum, item) => sum + (item.clicks || 0), 0)
  const avgCpc = totalClicks > 0 ? totalCost / totalClicks : 0

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>Google Ads数据</h2>
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
            name="mcc_id"
            label="MCC账号"
          >
            <Select
              placeholder="选择MCC账号"
              style={{ width: 150 }}
              allowClear
            >
              {mccAccounts.map(mcc => (
                <Select.Option key={mcc.id} value={mcc.id}>
                  {mcc.mcc_name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

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
              <span style={{ color: '#666' }}>总费用：</span>
              <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#ff4d4f' }}>
                ${totalCost.toFixed(2)}
              </span>
            </div>
            <div>
              <span style={{ color: '#666' }}>总展示：</span>
              <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
                {totalImpressions.toLocaleString()}
              </span>
            </div>
            <div>
              <span style={{ color: '#666' }}>总点击：</span>
              <span style={{ fontSize: '18px', fontWeight: 'bold', color: '#52c41a' }}>
                {totalClicks.toLocaleString()}
              </span>
            </div>
            <div>
              <span style={{ color: '#666' }}>平均CPC：</span>
              <span style={{ fontSize: '18px', fontWeight: 'bold' }}>
                ${avgCpc.toFixed(2)}
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
          scroll={{ x: 1500 }}
          locale={{
            emptyText: '请选择筛选条件并点击查询'
          }}
        />
      </Card>
    </div>
  )
}


