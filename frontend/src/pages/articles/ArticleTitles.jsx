import React, { useState, useEffect, useCallback } from 'react'
import { Card, Table, Button, Tag, Popconfirm, Space, Select, message } from 'antd'
import { DeleteOutlined, CopyOutlined } from '@ant-design/icons'
import articleApi from '../../services/articleApi'

const { Option } = Select

const ArticleTitles = () => {
  const [titles, setTitles] = useState([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [usedFilter, setUsedFilter] = useState(undefined)

  const fetchTitles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await articleApi.getTitles({ page, page_size: pageSize, used: usedFilter })
      setTitles(res.data?.items || [])
      setTotal(res.data?.total || 0)
    } catch (_) {
      message.error('获取标题库失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, usedFilter])

  useEffect(() => {
    fetchTitles()
  }, [fetchTitles])

  const handleDelete = async (id) => {
    try {
      await articleApi.deleteTitle(id)
      message.success('标题已删除')
      fetchTitles()
    } catch (_) {
      message.error('删除失败')
    }
  }

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text).then(() => message.success('已复制'))
  }

  const columns = [
    {
      title: '标题', dataIndex: 'title', key: 'title', ellipsis: true,
    },
    {
      title: '英文标题', dataIndex: 'title_en', key: 'title_en', ellipsis: true,
      render: v => v || '-',
    },
    {
      title: '评分', dataIndex: 'score', key: 'score', width: 80,
      render: v => v ? v.toFixed(1) : '-',
    },
    {
      title: '状态', dataIndex: 'used', key: 'used', width: 80,
      render: v => <Tag color={v ? 'green' : 'default'}>{v ? '已使用' : '未使用'}</Tag>,
    },
    {
      title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 170,
      render: v => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作', key: 'actions', width: 100,
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<CopyOutlined />} onClick={() => handleCopy(record.title)} />
          <Popconfirm title="删除此标题？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="标题库"
      extra={
        <Select
          placeholder="筛选状态"
          value={usedFilter}
          onChange={v => { setUsedFilter(v); setPage(1) }}
          style={{ width: 120 }}
          allowClear
        >
          <Option value="false">未使用</Option>
          <Option value="true">已使用</Option>
        </Select>
      }
    >
      <Table
        dataSource={titles}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: t => `共 ${t} 个标题`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps) },
        }}
      />
    </Card>
  )
}

export default ArticleTitles
