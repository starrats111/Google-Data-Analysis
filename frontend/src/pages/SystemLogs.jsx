import React, { useState, useEffect, useRef } from 'react'
import { Card, DatePicker, Space, Button, Typography, message, Spin, Input, Tag, Empty, Tooltip, Select, Row, Col, Statistic } from 'antd'
import { ReloadOutlined, CopyOutlined, SearchOutlined, ClockCircleOutlined, WarningOutlined, CheckCircleOutlined, InfoCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'

const { Title, Text, Paragraph } = Typography
const { RangePicker } = DatePicker
const { TextArea } = Input
const { Option } = Select

const SystemLogs = () => {
  const [loading, setLoading] = useState(false)
  const [logs, setLogs] = useState('')
  const [logLines, setLogLines] = useState([])
  const [dateRange, setDateRange] = useState([
    dayjs().subtract(1, 'hour'),
    dayjs()
  ])
  const [filterLevel, setFilterLevel] = useState('all')
  const [filterKeyword, setFilterKeyword] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [stats, setStats] = useState({ total: 0, info: 0, warning: 0, error: 0 })
  const logContainerRef = useRef(null)
  const refreshTimerRef = useRef(null)

  // 获取日志
  const fetchLogs = async () => {
    setLoading(true)
    try {
      const response = await api.get('/api/system/logs', {
        params: {
          start_time: dateRange[0].format('YYYY-MM-DD HH:mm:ss'),
          end_time: dateRange[1].format('YYYY-MM-DD HH:mm:ss'),
          level: filterLevel !== 'all' ? filterLevel : undefined,
          keyword: filterKeyword || undefined
        }
      })
      
      const logText = response.data?.logs || ''
      setLogs(logText)
      
      // 解析日志行
      const lines = logText.split('\n').filter(line => line.trim())
      setLogLines(lines)
      
      // 统计
      let info = 0, warning = 0, error = 0
      lines.forEach(line => {
        const upperLine = line.toUpperCase()
        if (upperLine.includes('ERROR') || upperLine.includes('CRITICAL')) error++
        else if (upperLine.includes('WARNING') || upperLine.includes('WARN')) warning++
        else info++
      })
      setStats({ total: lines.length, info, warning, error })
      
    } catch (error) {
      console.error('获取日志失败:', error)
      if (error.response?.status === 404) {
        message.info('日志API暂未配置')
        setLogs('日志功能需要后端支持，请确保后端API /api/system/logs 已配置。')
      } else {
        message.error('获取日志失败: ' + (error.response?.data?.detail || error.message))
      }
    } finally {
      setLoading(false)
    }
  }

  // 复制日志
  const copyLogs = () => {
    if (!logs) {
      message.warning('没有日志内容')
      return
    }
    navigator.clipboard.writeText(logs).then(() => {
      message.success('日志已复制到剪贴板')
    }).catch(() => {
      message.error('复制失败')
    })
  }

  // 复制选中的日志行
  const copyFilteredLogs = () => {
    const filteredText = getFilteredLines().join('\n')
    if (!filteredText) {
      message.warning('没有日志内容')
      return
    }
    navigator.clipboard.writeText(filteredText).then(() => {
      message.success('已复制筛选后的日志')
    }).catch(() => {
      message.error('复制失败')
    })
  }

  // 筛选日志行
  const getFilteredLines = () => {
    return logLines.filter(line => {
      // 关键词筛选
      if (filterKeyword && !line.toLowerCase().includes(filterKeyword.toLowerCase())) {
        return false
      }
      return true
    })
  }

  // 获取日志行的级别和颜色
  const getLogLevelInfo = (line) => {
    const upperLine = line.toUpperCase()
    if (upperLine.includes('ERROR') || upperLine.includes('CRITICAL')) {
      return { level: 'error', color: '#ff4d4f', icon: <CloseCircleOutlined /> }
    }
    if (upperLine.includes('WARNING') || upperLine.includes('WARN')) {
      return { level: 'warning', color: '#faad14', icon: <WarningOutlined /> }
    }
    if (upperLine.includes('SUCCESS') || upperLine.includes('✓')) {
      return { level: 'success', color: '#52c41a', icon: <CheckCircleOutlined /> }
    }
    return { level: 'info', color: '#1677ff', icon: <InfoCircleOutlined /> }
  }

  // 自动刷新
  useEffect(() => {
    if (autoRefresh) {
      refreshTimerRef.current = setInterval(fetchLogs, 10000) // 每10秒刷新
    } else {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
      }
    }
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
      }
    }
  }, [autoRefresh, dateRange, filterLevel, filterKeyword])

  // 初始加载
  useEffect(() => {
    fetchLogs()
  }, [])

  // 快捷时间选择
  const quickTimeOptions = [
    { label: '最近1小时', value: 1, unit: 'hour' },
    { label: '最近3小时', value: 3, unit: 'hour' },
    { label: '最近6小时', value: 6, unit: 'hour' },
    { label: '最近12小时', value: 12, unit: 'hour' },
    { label: '最近24小时', value: 24, unit: 'hour' },
    { label: '今天', value: 'today' },
  ]

  const handleQuickTime = (option) => {
    if (option.value === 'today') {
      setDateRange([dayjs().startOf('day'), dayjs()])
    } else {
      setDateRange([dayjs().subtract(option.value, option.unit), dayjs()])
    }
  }

  const filteredLines = getFilteredLines()

  return (
    <div style={{ padding: '24px' }}>
      <Card>
        <div style={{ marginBottom: 24 }}>
          <Row justify="space-between" align="middle">
            <Col>
              <Title level={4} style={{ margin: 0 }}>
                <ClockCircleOutlined style={{ marginRight: 8 }} />
                系统日志
              </Title>
            </Col>
            <Col>
              <Space wrap>
                <RangePicker
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  value={dateRange}
                  onChange={(dates) => dates && setDateRange(dates)}
                  allowClear={false}
                  style={{ width: 340 }}
                />
                <Button icon={<ReloadOutlined spin={loading} />} onClick={fetchLogs} loading={loading}>
                  刷新
                </Button>
                <Button 
                  type={autoRefresh ? 'primary' : 'default'}
                  onClick={() => setAutoRefresh(!autoRefresh)}
                >
                  {autoRefresh ? '停止自动刷新' : '自动刷新'}
                </Button>
              </Space>
            </Col>
          </Row>
        </div>

        {/* 快捷时间选择 */}
        <div style={{ marginBottom: 16 }}>
          <Space wrap>
            <Text type="secondary">快捷选择:</Text>
            {quickTimeOptions.map((opt, idx) => (
              <Button 
                key={idx} 
                size="small" 
                onClick={() => handleQuickTime(opt)}
              >
                {opt.label}
              </Button>
            ))}
          </Space>
        </div>

        {/* 统计卡片 */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small" style={{ background: '#f6ffed', borderColor: '#b7eb8f' }}>
              <Statistic 
                title="总日志条数" 
                value={stats.total}
                valueStyle={{ fontSize: 24 }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" style={{ background: '#EBF5FF', borderColor: '#91d5ff' }}>
              <Statistic 
                title="INFO" 
                value={stats.info}
                valueStyle={{ color: '#1677ff', fontSize: 24 }}
                prefix={<InfoCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" style={{ background: '#fffbe6', borderColor: '#ffe58f' }}>
              <Statistic 
                title="WARNING" 
                value={stats.warning}
                valueStyle={{ color: '#faad14', fontSize: 24 }}
                prefix={<WarningOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small" style={{ background: '#fff2f0', borderColor: '#ffccc7' }}>
              <Statistic 
                title="ERROR" 
                value={stats.error}
                valueStyle={{ color: '#ff4d4f', fontSize: 24 }}
                prefix={<CloseCircleOutlined />}
              />
            </Card>
          </Col>
        </Row>

        {/* 筛选和操作 */}
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <Space wrap>
            <Input
              placeholder="搜索关键词..."
              prefix={<SearchOutlined />}
              value={filterKeyword}
              onChange={(e) => setFilterKeyword(e.target.value)}
              style={{ width: 200 }}
              allowClear
            />
            <Select
              value={filterLevel}
              onChange={setFilterLevel}
              style={{ width: 120 }}
            >
              <Option value="all">全部级别</Option>
              <Option value="info">INFO</Option>
              <Option value="warning">WARNING</Option>
              <Option value="error">ERROR</Option>
            </Select>
          </Space>
          <Space>
            <Text type="secondary">显示 {filteredLines.length} / {logLines.length} 条</Text>
            <Tooltip title="复制筛选后的日志">
              <Button icon={<CopyOutlined />} onClick={copyFilteredLogs}>
                复制筛选结果
              </Button>
            </Tooltip>
            <Tooltip title="复制全部日志">
              <Button type="primary" icon={<CopyOutlined />} onClick={copyLogs}>
                一键复制全部
              </Button>
            </Tooltip>
          </Space>
        </div>

        {/* 日志内容 */}
        <Spin spinning={loading}>
          {filteredLines.length === 0 ? (
            <Empty 
              description={logs ? "没有匹配的日志" : "暂无日志"} 
              style={{ padding: 40 }}
            />
          ) : (
            <div 
              ref={logContainerRef}
              style={{ 
                background: '#1e1e1e', 
                borderRadius: 8, 
                padding: 16,
                maxHeight: 500,
                overflow: 'auto',
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                fontSize: 13,
                lineHeight: 1.6
              }}
            >
              {filteredLines.map((line, idx) => {
                const { color, icon } = getLogLevelInfo(line)
                return (
                  <div 
                    key={idx}
                    style={{ 
                      color: '#d4d4d4',
                      padding: '2px 0',
                      borderBottom: '1px solid #333',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8
                    }}
                  >
                    <span style={{ color: '#666', userSelect: 'none', minWidth: 40, textAlign: 'right' }}>
                      {idx + 1}
                    </span>
                    <span style={{ color, flexShrink: 0 }}>{icon}</span>
                    <span style={{ 
                      wordBreak: 'break-all',
                      whiteSpace: 'pre-wrap'
                    }}>
                      {line}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Spin>

        {/* 原始日志（隐藏，用于复制） */}
        <TextArea
          value={logs}
          style={{ display: 'none' }}
          readOnly
        />
      </Card>
    </div>
  )
}

export default SystemLogs

