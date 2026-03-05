import React, { useState, useEffect, useCallback } from 'react'
import { Card, Table, Button, Modal, Form, Input, Space, Popconfirm, message } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import articleApi from '../../services/articleApi'

const ArticleCategories = () => {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form] = Form.useForm()

  const fetchCategories = useCallback(async () => {
    setLoading(true)
    try {
      const res = await articleApi.getCategories()
      setCategories(res.data || [])
    } catch (_) {
      message.error('获取分类失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCategories()
  }, [fetchCategories])

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      if (editingId) {
        await articleApi.updateCategory(editingId, values)
        message.success('分类已更新')
      } else {
        await articleApi.createCategory(values)
        message.success('分类已创建')
      }
      setModalVisible(false)
      form.resetFields()
      setEditingId(null)
      fetchCategories()
    } catch (err) {
      if (err?.errorFields) return
      message.error(err?.response?.data?.detail || '保存失败')
    }
  }

  const handleEdit = (record) => {
    setEditingId(record.id)
    form.setFieldsValue({ name: record.name, description: record.description })
    setModalVisible(true)
  }

  const handleDelete = async (id) => {
    try {
      await articleApi.deleteCategory(id)
      message.success('分类已删除')
      fetchCategories()
    } catch (err) {
      message.error('删除失败')
    }
  }

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: 'Slug', dataIndex: 'slug', key: 'slug' },
    { title: '描述', dataIndex: 'description', key: 'description', render: v => v || '-' },
    {
      title: '创建时间', dataIndex: 'created_at', key: 'created_at',
      render: v => v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
    {
      title: '操作', key: 'actions', width: 120,
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm title="确定删除此分类？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="分类管理"
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => { setEditingId(null); form.resetFields(); setModalVisible(true) }}
        >
          新建分类
        </Button>
      }
    >
      <Table dataSource={categories} columns={columns} rowKey="id" loading={loading} pagination={false} />

      <Modal
        title={editingId ? '编辑分类' : '新建分类'}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => { setModalVisible(false); form.resetFields(); setEditingId(null) }}
        okText="保存"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入分类名称' }]}>
            <Input placeholder="分类名称" maxLength={100} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={3} placeholder="分类描述（可选）" maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

export default ArticleCategories
