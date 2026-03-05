import React, { useState, useEffect, useCallback } from 'react'
import { Table, Button, Space, Tag, Input, Select, Modal, message, Card, Tooltip, Popconfirm } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import articleApi from '../../services/articleApi'

const { Option } = Select

const ArticleList = () => {
  const [articles, setArticles] = useState([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [status, setStatus] = useState(undefined)
  const [categoryId, setCategoryId] = useState(undefined)
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState([])
  const navigate = useNavigate()

  const fetchArticles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await articleApi.getArticles({
        page,
        page_size: pageSize,
        status: status || undefined,
        category_id: categoryId || undefined,
        search: search || undefined,
      })
      setArticles(res.data?.items || [])
      setTotal(res.data?.total || 0)
    } catch (err) {
      message.error('获取文章列表失败')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, status, categoryId, search])

  const fetchCategories = useCallback(async () => {
    try {
      const res = await articleApi.getCategories()
      setCategories(res.data || [])
    } catch (_) {}
  }, [])

  useEffect(() => {
    fetchArticles()
  }, [fetchArticles])

  useEffect(() => {
    fetchCategories()
  }, [])

  const handleDelete = async (id) => {
    try {
      await articleApi.deleteArticle(id)
      message.success('文章已删除')
      fetchArticles()
    } catch (err) {
      message.error('删除失败')
    }
  }

  const columns = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      width: 300,
      render: (text, record) => (
        <a onClick={() => navigate(`/articles/edit/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s) => (
        <Tag color={s === 'published' ? 'green' : 'default'}>
          {s === 'published' ? '已发布' : '草稿'}
        </Tag>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category_name',
      key: 'category_name',
      width: 120,
      render: (v) => v || '-',
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      width: 200,
      render: (tags) =>
        tags?.map((t) => <Tag key={t.id} color="blue">{t.name}</Tag>) || '-',
    },
    {
      title: '作者',
      dataIndex: 'author',
      key: 'author',
      width: 100,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (v) => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="编辑">
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => navigate(`/articles/edit/${record.id}`)}
            />
          </Tooltip>
          <Popconfirm title="确定删除此文章？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="文章管理"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/articles/publish')}>
          发布文章
        </Button>
      }
    >
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          placeholder="搜索标题..."
          prefix={<SearchOutlined />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onPressEnter={() => { setPage(1); fetchArticles() }}
          style={{ width: 220 }}
          allowClear
        />
        <Select
          placeholder="筛选状态"
          value={status}
          onChange={(v) => { setStatus(v); setPage(1) }}
          style={{ width: 120 }}
          allowClear
        >
          <Option value="draft">草稿</Option>
          <Option value="published">已发布</Option>
        </Select>
        <Select
          placeholder="筛选分类"
          value={categoryId}
          onChange={(v) => { setCategoryId(v); setPage(1) }}
          style={{ width: 140 }}
          allowClear
        >
          {categories.map((c) => (
            <Option key={c.id} value={c.id}>{c.name}</Option>
          ))}
        </Select>
      </Space>

      <Table
        dataSource={articles}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 篇文章`,
          onChange: (p, ps) => { setPage(p); setPageSize(ps) },
        }}
        scroll={{ x: 1100 }}
      />
    </Card>
  )
}

export default ArticleList
