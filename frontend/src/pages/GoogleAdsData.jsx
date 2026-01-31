import React, { useState, useEffect } from 'react'
import { Card, Button, Form, Select, DatePicker, message, Space, Radio, Statistic, Row, Col } from 'antd'
import { SearchOutlined, DownloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { RangePicker } = DatePicker

export default function GoogleAdsData() {
  const { user } = useAuth()
  
  const [loading, setLoading] = useState(false)
  const [summaryData, setSummaryData] = useState(null) // 聚合数据
  const [mccAccounts, setMccAccounts] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [form] = Form.useForm()
  const [dateRangeType, setDateRangeType] = useState('past7days') // 时间范围类型

  useEffect(() => {
    fetchMccAccounts()
    fetchPlatforms()
    // 默认查询过去7天
    handleDateRangeChange('past7days')
  }, [])

  // 处理时间范围类型变化
  const handleDateRangeChange = (type) => {
    setDateRangeType(type)
    let beginDate, endDate
    
    const today = dayjs()
    switch(type) {
      case 'today':
        beginDate = today
        endDate = today
        break
      case 'yesterday':
        beginDate = today.subtract(1, 'day')
        endDate = today.subtract(1, 'day')
        break
      case 'past7days':
        beginDate = today.subtract(7, 'day')
        endDate = today
        break
      case 'thisWeek':
        beginDate = today.startOf('week')
        endDate = today
        break
      case 'thisMonth':
        beginDate = today.startOf('month')
        endDate = today
        break
      case 'custom':
        // 自定义时不清空日期选择器
        return
      default:
        beginDate = today.subtract(7, 'day')
        endDate = today
    }
    
    form.setFieldsValue({
      dateRange: [beginDate, endDate]
    })
    
    // 自动触发查询（除了自定义）
    if (type !== 'custom') {
      // 延迟一下确保表单值已更新
      setTimeout(() => {
        form.submit()
      }, 100)
    }
  }

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
      
      // 获取日期范围：优先使用表单值，如果没有则使用当前选择的时间范围类型
      let beginDate, endDate
      if (values.dateRange && values.dateRange.length === 2) {
        beginDate = values.dateRange[0]
        endDate = values.dateRange[1]
      } else {
        // 如果表单中没有日期范围，根据当前选择的时间范围类型计算
        const today = dayjs()
        switch(dateRangeType) {
          case 'today':
            beginDate = today
            endDate = today
            break
          case 'yesterday':
            beginDate = today.subtract(1, 'day')
            endDate = today.subtract(1, 'day')
            break
          case 'past7days':
            beginDate = today.subtract(7, 'day')
            endDate = today
            break
          case 'thisWeek':
            beginDate = today.startOf('week')
            endDate = today
            break
          case 'thisMonth':
            beginDate = today.startOf('month')
            endDate = today
            break
          default:
            message.warning('请选择日期范围')
            setLoading(false)
            return
        }
      }
      
      params.begin_date = beginDate.format('YYYY-MM-DD')
      params.end_date = endDate.format('YYYY-MM-DD')
      
      // 获取聚合数据（总数据）
      const response = await api.get('/api/google-ads-data/summary', { params })
      setSummaryData(response.data)
      
      if (response.data && (response.data.total_cost > 0 || response.data.total_impressions > 0 || response.data.total_clicks > 0)) {
        message.success('查询成功')
      } else {
        message.info('未找到数据')
      }
    } catch (error) {
      console.error('查询失败:', error)
      message.error(error.response?.data?.detail || '查询失败')
      setSummaryData(null)
    } finally {
      setLoading(false)
    }
  }


  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>Google Ads数据</h2>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSearch}
        >
          <Row gutter={16}>
            <Col span={24} style={{ marginBottom: 16 }}>
              <Form.Item label="时间范围">
                <Radio.Group 
                  value={dateRangeType} 
                  onChange={(e) => handleDateRangeChange(e.target.value)}
                  buttonStyle="solid"
                >
                  <Radio.Button value="today">今天</Radio.Button>
                  <Radio.Button value="yesterday">昨天</Radio.Button>
                  <Radio.Button value="past7days">过去七天</Radio.Button>
                  <Radio.Button value="thisWeek">本周</Radio.Button>
                  <Radio.Button value="thisMonth">本月</Radio.Button>
                  <Radio.Button value="custom">自定义</Radio.Button>
                </Radio.Group>
              </Form.Item>
            </Col>

            {dateRangeType === 'custom' && (
              <Col span={24} style={{ marginBottom: 16 }}>
                <Form.Item
                  name="dateRange"
                  label="选择日期范围"
                  rules={[{ required: true, message: '请选择日期范围' }]}
                >
                  <RangePicker
                    format="YYYY-MM-DD"
                    style={{ width: '100%' }}
                    disabledDate={(current) => current && current > dayjs().endOf('day')}
                  />
                </Form.Item>
              </Col>
            )}

            <Col span={12}>
              <Form.Item
                name="mcc_id"
                label="MCC账号（可选）"
              >
                <Select
                  placeholder="选择MCC账号"
                  allowClear
                >
                  {mccAccounts.map(mcc => (
                    <Select.Option key={mcc.id} value={mcc.id}>
                      {mcc.mcc_name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item
                name="platform_code"
                label="平台（可选）"
              >
                <Select
                  placeholder="选择平台"
                  allowClear
                >
                  {platforms.map(platform => (
                    <Select.Option key={platform.id} value={platform.platform_code}>
                      {platform.platform_name}
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>

            <Col span={24}>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<SearchOutlined />}
                  loading={loading}
                  size="large"
                  block
                >
                  查询
                </Button>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {summaryData && (
        <Card>
          <Row gutter={16}>
            <Col span={6}>
              <Statistic
                title="总费用"
                value={summaryData.total_cost || 0}
                precision={2}
                prefix="$"
                valueStyle={{ color: '#ff4d4f' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="总展示"
                value={summaryData.total_impressions || 0}
                valueStyle={{ color: '#1890ff' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="总点击"
                value={summaryData.total_clicks || 0}
                valueStyle={{ color: '#52c41a' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title="平均CPC"
                value={summaryData.avg_cpc || 0}
                precision={2}
                prefix="$"
              />
            </Col>
          </Row>
          {summaryData.date_range && (
            <div style={{ marginTop: 16, color: '#666', fontSize: '14px' }}>
              日期范围：{summaryData.date_range.begin_date} 至 {summaryData.date_range.end_date}
            </div>
          )}
        </Card>
      )}

      {!summaryData && !loading && (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            请选择时间范围并点击查询
          </div>
        </Card>
      )}
    </div>
  )
}


