import React, { useMemo, useState, useEffect } from 'react'
import { Card, Table, Select, DatePicker, Space, message, Tag, Badge, Typography, Tooltip, Button, Popconfirm } from 'antd'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import api from '../services/api'
import ExportButton from '../components/Export/ExportButton'
import './Analysis.css'

const { RangePicker } = DatePicker
const { Option } = Select
const { Title, Text } = Typography

const Analysis = () => {
  const navigate = useNavigate()
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [dateRange, setDateRange] = useState(null)

  const fetchAccounts = async () => {
    try {
      const response = await api.get('/api/affiliate/accounts')
      setAccounts(response.data)
    } catch (error) {
      console.error('获取账号列表失败', error)
    }
  }

  const fetchResults = async () => {
    setLoading(true)
    try {
      const params = {}
      if (selectedAccount) params.account_id = selectedAccount
      if (dateRange && dateRange.length === 2) {
        params.start_date = dateRange[0].format('YYYY-MM-DD')
        params.end_date = dateRange[1].format('YYYY-MM-DD')
      }

      const response = await api.get('/api/analysis/results', { params })
      setResults(response.data)
    } catch (error) {
      message.error('获取分析结果失败')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteResult = async (resultId) => {
    try {
      await api.delete(`/api/analysis/results/${resultId}`)
      message.success('删除成功')
      fetchResults()
    } catch (error) {
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  useEffect(() => {
    fetchAccounts()
  }, [])

  useEffect(() => {
    fetchResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccount, dateRange])

  const accountNameMap = useMemo(() => {
    const map = new Map()
    for (const acc of accounts) {
      map.set(acc.id, `${acc.platform?.platform_name || '-'} - ${acc.account_name || '-'}`)
    }
    return map
  }, [accounts])

  const columns = useMemo(() => ([
    {
      title: '日期',
      dataIndex: 'analysis_date',
      key: 'analysis_date',
      width: 120,
      render: (v) => (v ? String(v).slice(0, 10) : '-'),
    },
    {
      title: '联盟账号',
      dataIndex: 'affiliate_account_id',
      key: 'affiliate_account_id',
      ellipsis: true,
      render: (id) => (
        <Tooltip title={accountNameMap.get(id) || `账号ID: ${id}`}>
          <span>{accountNameMap.get(id) || `账号ID: ${id}`}</span>
        </Tooltip>
      ),
    },
    {
      title: '数据行数',
      key: 'rows',
      width: 110,
      align: 'right',
      render: (_, record) => {
        const data = record.result_data?.data || []
        const count = Array.isArray(data) ? data.length : 0
        return <Badge count={count} color={count > 0 ? '#1677ff' : '#d9d9d9'} />
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      fixed: 'right',
      render: (_, record) => (
        <Popconfirm
          title="确定删除该分析结果吗？"
          description="删除后无法恢复"
          okText="确定"
          cancelText="取消"
          onConfirm={() => handleDeleteResult(record.id)}
        >
          <Button danger size="small">删除</Button>
        </Popconfirm>
      ),
    },
  ]), [accountNameMap])

  return (
    <div className="analysis-page">
      <div className="analysis-page__header">
        <div>
          <Title level={3} className="analysis-page__title">分析结果</Title>
          <Text className="analysis-page__subtitle">
            支持按联盟账号与日期筛选；展开行可查看每条分析明细
          </Text>
        </div>
      </div>

      <Card className="analysis-table" styles={{ body: { paddingTop: 14 } }}>
        <div className="analysis-filters">
          <Select
            placeholder="选择联盟账号"
            style={{ width: 260 }}
            value={selectedAccount}
            onChange={setSelectedAccount}
            allowClear
            showSearch
            optionFilterProp="children"
          >
            {accounts.map(acc => (
              <Option key={acc.id} value={acc.id}>
                {acc.platform?.platform_name || '-'} - {acc.account_name || '-'}
              </Option>
            ))}
          </Select>
          <RangePicker
            value={dateRange}
            onChange={setDateRange}
            format="YYYY-MM-DD"
            allowEmpty={[true, true]}
          />
          <ExportButton
            type="analysis"
            accountId={selectedAccount}
            dateRange={dateRange}
          />
        </div>

        <Table
          columns={columns}
          dataSource={results}
          loading={loading}
          rowKey="id"
          size="middle"
          bordered
          sticky
          scroll={{ x: 800 }}
          pagination={{ pageSize: 10, showSizeChanger: true }}
          expandable={{
            expandedRowRender: (record) => {
              const data = record.result_data?.data || []
              if (!Array.isArray(data) || data.length === 0) return <Text type="secondary">暂无数据</Text>

              const dataColumns = Object.keys(data[0]).map((key) => {
                const column = {
                  title: key,
                  dataIndex: key,
                  key,
                  ellipsis: true,
                  render: (text) => {
                    if (text === null || text === undefined || text === '') return '-'
                    return <Tooltip title={String(text)}>{String(text)}</Tooltip>
                  },
                }

                // 为处理动作列添加特殊渲染
                if (key === '处理动作') {
                  column.width = 110
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text) return '-'
                    const t = String(text)
                    let color = 'default'
                    if (t.includes('暂停')) color = 'red'
                    else if (t.includes('加预算') || t.includes('增加')) color = 'green'
                    else if (t.includes('维持') || t.includes('保持')) color = 'blue'
                    return <Tag color={color}>{t}</Tag>
                  }
                }

                // 为操作指令列添加特殊渲染
                if (key === '操作指令') {
                  column.width = 200
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text || text === '-') return '-'
                    const t = String(text)
                    let color = 'default'
                    // 根据操作指令内容设置颜色
                    if (t.includes('关停') || t.includes('PAUSE')) {
                      color = 'red'
                    } else if (t.includes('降价')) {
                      color = 'orange'
                    } else if (t.includes('预算') || t.includes('加产')) {
                      color = 'green'
                    } else if (t.includes('CPC+') || t.includes('抢占')) {
                      color = 'cyan'
                    } else if (t.includes('稳定') || t.includes('维持')) {
                      color = 'blue'
                    } else if (t.includes('样本不足') || t.includes('观察')) {
                      color = 'default'
                    }
                    return <Tag color={color} style={{ fontSize: '13px' }}>{t}</Tag>
                  }
                }

                // 为阶段标签列添加特殊渲染（可点击跳转）
                if (key === '阶段标签') {
                  column.width = 120
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text) return '-'
                    const t = String(text)
                    let color = 'default'
                    if (t.includes('K1') || t.includes('关停')) color = 'red'
                    else if (t.includes('S1') || t.includes('成熟')) color = 'green'
                    else if (t.includes('P1') || t.includes('候选')) color = 'cyan'
                    else if (t.includes('T2') || t.includes('观察')) color = 'orange'
                    else if (t.includes('T1') || t.includes('试水')) color = 'blue'
                    return (
                      <Tag 
                        color={color}
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/stage-label/${encodeURIComponent(t)}`)}
                      >
                        {t}
                      </Tag>
                    )
                  }
                }

                // 为异常类型列添加特殊渲染（P0红色，P1黄色）
                if (key === '异常类型') {
                  column.width = 120
                  column.ellipsis = false
                  column.render = (text) => {
                    if (!text || text === '-' || text === null || text === undefined) return '-'
                    const t = String(text).trim()
                    if (!t) return '-'
                    // 检查优先级：P0显示红色，P1显示黄色
                    let color = 'default'
                    if (t.startsWith('P0') || t.includes('P0-') || /^P0\s/.test(t)) {
                      color = 'red'
                    } else if (t.startsWith('P1') || t.includes('P1-') || /^P1\s/.test(t)) {
                      color = 'gold'
                    }
                    return <Tag color={color} style={{ fontWeight: color !== 'default' ? 'bold' : 'normal' }}>{t}</Tag>
                  }
                }

                // 将"表1状态"列名改为"谷歌状态"（兼容旧数据）
                if (key === '表1状态') {
                  column.title = '谷歌状态'
                }

                // 动作相关列更宽 + tooltip
                if (['投放动作', '数据动作', '风控动作', '使用场景', '动作原因'].includes(key)) {
                  column.width = 260
                }

                // 数值列格式化
                if (['保守ROI', '保守EPC', 'CPC', '费用', '费用($)', '佣金', '回传佣金', '回传佣金($)', '保守佣金', '保守佣金($)', '点击', '订单'].some(col => key.includes(col))) {
                  column.align = 'right'
                  column.render = (text) => {
                    if (text === null || text === undefined || text === '') return '-'
                    const num = Number(text)
                    if (Number.isNaN(num)) return String(text)
                    // 后端按“原始值”返回保守ROI（如 0.4838），这里不做 *100 或加% 等转换
                    if (key.includes('ROI')) return num.toFixed(4)
                    if (key.includes('点击') || key.includes('订单')) return num.toFixed(0)
                    return num.toFixed(4)
                  }
                }

                return column
              })

              // 将“账号=CID、广告系列、阶段标签”置于前三列并冻结在左侧
              const pinnedLeft = ['账号=CID', '广告系列', '阶段标签']
              const leftCols = []
              for (const colName of pinnedLeft) {
                const idx = dataColumns.findIndex((c) => c.key === colName)
                if (idx > -1) {
                  const col = dataColumns.splice(idx, 1)[0]
                  col.fixed = 'left'
                  // 合理列宽
                  if (colName === '账号=CID') col.width = col.width || 140
                  if (colName === '广告系列') col.width = col.width || 260
                  if (colName === '阶段标签') col.width = col.width || 120
                  leftCols.push(col)
                }
              }
              dataColumns.unshift(...leftCols)

              const dataWithKeys = data.map((r, idx) => ({
                ...r,
                __rowKey: `${record.id}-${idx}`,
              }))

              return (
                <div className="analysis-subtable">
                  <Table
                    columns={dataColumns}
                    dataSource={dataWithKeys}
                    rowKey="__rowKey"
                    pagination={{ pageSize: 20, size: 'small', hideOnSinglePage: true }}
                    size="small"
                    bordered
                    sticky
                    scroll={{ x: 'max-content', y: 420 }}
                  />
                </div>
              )
            },
          }}
        />
      </Card>
    </div>
  )
}

export default Analysis




