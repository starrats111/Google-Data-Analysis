import React, { useState, useEffect, useCallback } from 'react'
import {
  Table, Button, Space, Tag, Modal, Form, Input, message, Card,
  Tooltip, Popconfirm, Badge,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  GlobalOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons'
import articleApi from '../../services/articleApi'
import { useAuth } from '../../store/authStore'

const SiteManagement = () => {
  const [sites, setSites] = useState([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingSite, setEditingSite] = useState(null)
  const [verifying, setVerifying] = useState({})
  const [form] = Form.useForm()
  const { user } = useAuth()
  const isAdmin = user?.role === 'manager' || user?.role === 'leader'

  const fetchSites = useCallback(async () => {
    setLoading(true)
    try {
      const res = await articleApi.getSites()
      setSites(res.data?.items || [])
    } catch {
      message.error('获取网站列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSites() }, [fetchSites])

  const handleCreate = () => {
    setEditingSite(null)
    form.resetFields()
    form.setFieldsValue({
      data_js_path: 'js/articles-index.js',
      article_template: 'article-1.html',
    })
    setModalOpen(true)
  }

  const handleEdit = (record) => {
    setEditingSite(record)
    form.setFieldsValue(record)
    setModalOpen(true)
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      if (editingSite) {
        await articleApi.updateSite(editingSite.id, values)
        message.success('网站配置已更新')
      } else {
        const res = await articleApi.createSite(values)
        if (res.data?.migration?.errors?.length) {
          message.warning(`网站已创建，但迁移有 ${res.data.migration.errors.length} 个警告`)
        } else {
          message.success(`网站已创建，${res.data?.migration?.migrated_count || 0} 篇文章已完成 slug 迁移`)
        }
      }
      setModalOpen(false)
      fetchSites()
    } catch (err) {
      if (err.response?.data?.detail) {
        message.error(err.response.data.detail)
      }
    }
  }

  const handleDelete = async (id) => {
    try {
      await articleApi.deleteSite(id)
      message.success('网站配置已删除')
      fetchSites()
    } catch {
      message.error('删除失败')
    }
  }

  const handleVerify = async (id) => {
    setVerifying(prev => ({ ...prev, [id]: true }))
    try {
      const res = await articleApi.verifySite(id)
      const checks = res.data?.checks || {}
      if (checks.valid) {
        message.success('网站目录验证通过')
      } else {
        const failed = Object.entries(checks)
          .filter(([k, v]) => !v && k !== 'valid')
          .map(([k]) => k)
        message.error(`验证失败: ${failed.join(', ')}`)
      }
    } catch {
      message.error('验证请求失败')
    } finally {
      setVerifying(prev => ({ ...prev, [id]: false }))
    }
  }

  const columns = [
    {
      title: '网站名称',
      dataIndex: 'site_name',
      key: 'site_name',
      width: 150,
      render: (text, record) => (
        <Space>
          <GlobalOutlined />
          <span style={{ fontWeight: 500 }}>{text}</span>
          {record.domain && (
            <a href={`https://${record.domain}`} target="_blank" rel="noreferrer"
              style={{ fontSize: 12, color: '#999' }}>
              {record.domain}
            </a>
          )}
        </Space>
      ),
    },
    {
      title: '目录路径',
      dataIndex: 'site_path',
      key: 'site_path',
      width: 250,
      render: (v) => <code style={{ fontSize: 12 }}>{v}</code>,
    },
    {
      title: '迁移状态',
      dataIndex: 'migrated',
      key: 'migrated',
      width: 100,
      render: (v) => v
        ? <Badge status="success" text="已迁移" />
        : <Badge status="warning" text="未迁移" />,
    },
    {
      title: '创建人',
      dataIndex: 'created_by_name',
      key: 'created_by_name',
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
      width: 200,
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="验证目录">
            <Button
              type="link" size="small"
              icon={<SafetyCertificateOutlined />}
              loading={verifying[record.id]}
              onClick={() => handleVerify(record.id)}
            />
          </Tooltip>
          {isAdmin && (
            <>
              <Tooltip title="编辑">
                <Button type="link" size="small" icon={<EditOutlined />}
                  onClick={() => handleEdit(record)} />
              </Tooltip>
              <Popconfirm title="确定删除此网站配置？" onConfirm={() => handleDelete(record.id)}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="网站管理"
      extra={
        isAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新增网站
          </Button>
        )
      }
    >
      <Table
        dataSource={sites}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={false}
        scroll={{ x: 900 }}
      />

      <Modal
        title={editingSite ? '编辑网站' : '新增网站'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        okText={editingSite ? '保存' : '创建'}
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="site_name" label="网站名称"
            rules={[{ required: true, message: '请输入网站名称' }]}>
            <Input placeholder="如 AlluraHub" />
          </Form.Item>
          <Form.Item name="site_path" label="服务器目录路径"
            rules={[{ required: true, message: '请输入目录路径' }]}
            extra="必须在 /home/admin/sites/ 下">
            <Input placeholder="/home/admin/sites/allurahub" />
          </Form.Item>
          <Form.Item name="domain" label="网站域名（选填）">
            <Input placeholder="allurahub.com" />
          </Form.Item>
          <Form.Item name="data_js_path" label="索引文件相对路径">
            <Input placeholder="js/articles-index.js" />
          </Form.Item>
          <Form.Item name="article_template" label="文章模板文件名">
            <Input placeholder="article-1.html" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

export default SiteManagement
