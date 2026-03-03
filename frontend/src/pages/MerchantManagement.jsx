import React, { useEffect, useMemo, useState } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Form,
  Input,
  Select,
  Tag,
  Tabs,
  Modal,
  message,
  Popconfirm,
  InputNumber,
  Statistic,
  Row,
  Col,
  Tooltip,
} from 'antd'
import { ReloadOutlined, SearchOutlined, UserSwitchOutlined, SyncOutlined } from '@ant-design/icons'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { Option } = Select

const statusColorMap = {
  active: 'green',
  inactive: 'default',
  completed: 'blue',
  cancelled: 'red',
}

const priorityColorMap = {
  high: 'red',
  normal: 'blue',
  low: 'default',
}

const MerchantManagement = () => {
  const { permissions, user } = useAuth()
  const role = permissions?.role || user?.role || 'member'
  const canManage = role === 'manager' || role === 'leader'
  const isManager = role === 'manager'

  const [tabKey, setTabKey] = useState('merchants')
  const [loading, setLoading] = useState(false)
  const [merchants, setMerchants] = useState([])
  const [merchantTotal, setMerchantTotal] = useState(0)
  const [merchantPage, setMerchantPage] = useState(1)
  const [merchantPageSize, setMerchantPageSize] = useState(20)

  const [assignments, setAssignments] = useState([])
  const [assignmentTotal, setAssignmentTotal] = useState(0)
  const [assignmentPage, setAssignmentPage] = useState(1)
  const [assignmentPageSize, setAssignmentPageSize] = useState(20)

  const [stats, setStats] = useState({
    total: 0,
    assigned: 0,
    unassigned: 0,
    missing_mid_total: 0,
    discovery_rate: 100,
    missing_mid_rate: 0,
    by_platform: {},
    missing_mid_by_platform: {},
  })
  const [platformOptions, setPlatformOptions] = useState([])
  const [userOptions, setUserOptions] = useState([])

  const [merchantFilters, setMerchantFilters] = useState({
    platform: undefined,
    category: undefined,
    status: undefined,
    assigned: undefined,
    missing_mid: undefined,
    search: '',
  })
  const [assignmentFilters, setAssignmentFilters] = useState({
    user_id: undefined,
    status: undefined,
  })

  const [selectedMerchantIds, setSelectedMerchantIds] = useState([])
  const [selectedAssignmentIds, setSelectedAssignmentIds] = useState([])

  const [assignModalOpen, setAssignModalOpen] = useState(false)
  const [transferModalOpen, setTransferModalOpen] = useState(false)
  const [editMerchantModalOpen, setEditMerchantModalOpen] = useState(false)
  const [editAssignmentModalOpen, setEditAssignmentModalOpen] = useState(false)

  const [currentMerchant, setCurrentMerchant] = useState(null)
  const [currentAssignment, setCurrentAssignment] = useState(null)

  const [assignForm] = Form.useForm()
  const [transferForm] = Form.useForm()
  const [editMerchantForm] = Form.useForm()
  const [editAssignmentForm] = Form.useForm()

  const byPlatformText = useMemo(() => {
    const entries = Object.entries(stats.by_platform || {})
    if (!entries.length) return '暂无'
    return entries.map(([k, v]) => `${k}: ${v}`).join(' | ')
  }, [stats.by_platform])

  const missingMidByPlatformText = useMemo(() => {
    const entries = Object.entries(stats.missing_mid_by_platform || {})
    if (!entries.length) return '暂无'
    return entries.map(([k, v]) => `${k}: ${v}`).join(' | ')
  }, [stats.missing_mid_by_platform])

  useEffect(() => {
    fetchUsers()
    if (canManage) {
      fetchStats()
      fetchMerchants(1, merchantPageSize)
    } else {
      fetchAssignments(1, assignmentPageSize)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tabKey === 'assignments') {
      fetchAssignments(1, assignmentPageSize)
    }
  }, [tabKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchUsers = async () => {
    try {
      const resp = await api.get('/api/team/users')
      const users = resp.data || []
      setUserOptions(users)
    } catch (error) {
      console.error('获取用户列表失败', error)
    }
  }

  const fetchStats = async () => {
    try {
      const resp = await api.get('/api/merchants/stats')
      setStats(resp.data || {
        total: 0,
        assigned: 0,
        unassigned: 0,
        missing_mid_total: 0,
        discovery_rate: 100,
        missing_mid_rate: 0,
        by_platform: {},
        missing_mid_by_platform: {},
      })
      setPlatformOptions(Object.keys(resp.data?.by_platform || {}))
    } catch (error) {
      console.error('获取商家统计失败', error)
    }
  }

  const fetchMerchants = async (page = merchantPage, pageSize = merchantPageSize) => {
    setLoading(true)
    try {
      const params = {
        page,
        page_size: pageSize,
      }
      if (merchantFilters.platform) params.platform = merchantFilters.platform
      if (merchantFilters.category) params.category = merchantFilters.category
      if (merchantFilters.status) params.status = merchantFilters.status
      if (merchantFilters.assigned !== undefined) params.assigned = merchantFilters.assigned
      if (merchantFilters.missing_mid !== undefined) params.missing_mid = merchantFilters.missing_mid
      if (merchantFilters.search) params.search = merchantFilters.search

      const resp = await api.get('/api/merchants', { params })
      const data = resp.data || {}
      setMerchants(data.items || [])
      setMerchantTotal(data.total || 0)
      setMerchantPage(page)
      setMerchantPageSize(pageSize)
      setSelectedMerchantIds([])
    } catch (error) {
      message.error(error.response?.data?.detail || '获取商家列表失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchAssignments = async (page = assignmentPage, pageSize = assignmentPageSize) => {
    setLoading(true)
    try {
      const params = {
        page,
        page_size: pageSize,
      }
      if (assignmentFilters.user_id) params.user_id = assignmentFilters.user_id
      if (assignmentFilters.status) params.status = assignmentFilters.status

      const resp = await api.get('/api/merchant-assignments', { params })
      const data = resp.data || {}
      setAssignments(data.items || [])
      setAssignmentTotal(data.total || 0)
      setAssignmentPage(page)
      setAssignmentPageSize(pageSize)
      setSelectedAssignmentIds([])
    } catch (error) {
      message.error(error.response?.data?.detail || '获取分配记录失败')
    } finally {
      setLoading(false)
    }
  }

  const [discoverLoading, setDiscoverLoading] = useState(false)

  const handleDiscover = async () => {
    setDiscoverLoading(true)
    try {
      const resp = await api.post('/api/merchants/discover')
      message.success(resp.data?.message || '商家同步完成')
      await Promise.all([fetchStats(), fetchMerchants(1, merchantPageSize)])
    } catch (error) {
      message.error(error.response?.data?.detail || '商家同步失败')
    } finally {
      setDiscoverLoading(false)
    }
  }

  const handleAssignSubmit = async () => {
    try {
      const values = await assignForm.validateFields()
      if (!selectedMerchantIds.length) {
        message.warning('请先选择商家')
        return
      }
      await api.post('/api/merchant-assignments', {
        merchant_ids: selectedMerchantIds,
        user_id: values.user_id,
        priority: values.priority || 'normal',
        monthly_target: values.monthly_target,
        notes: values.notes,
      })
      message.success('分配成功')
      setAssignModalOpen(false)
      assignForm.resetFields()
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(1, assignmentPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '分配失败')
    }
  }

  const handleTransferSubmit = async () => {
    try {
      const values = await transferForm.validateFields()
      if (!selectedAssignmentIds.length) {
        message.warning('请先选择分配记录')
        return
      }
      await api.post('/api/merchant-assignments/transfer', {
        assignment_ids: selectedAssignmentIds,
        new_user_id: values.new_user_id,
      })
      message.success('转移成功')
      setTransferModalOpen(false)
      transferForm.resetFields()
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(assignmentPage, assignmentPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '转移失败')
    }
  }

  const handleCancelAssignment = async (assignmentId) => {
    try {
      await api.delete(`/api/merchant-assignments/${assignmentId}`)
      message.success('已取消分配')
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(assignmentPage, assignmentPageSize)])
    } catch (error) {
      message.error(error.response?.data?.detail || '取消分配失败')
    }
  }

  const openEditMerchantModal = (merchant) => {
    setCurrentMerchant(merchant)
    editMerchantForm.setFieldsValue({
      category: merchant.category,
      commission_rate: merchant.commission_rate,
      status: merchant.status,
      notes: merchant.notes,
      slug: merchant.slug,
      merchant_id: merchant.merchant_id,
    })
    setEditMerchantModalOpen(true)
  }

  const handleEditMerchantSubmit = async () => {
    try {
      const values = await editMerchantForm.validateFields()
      await api.put(`/api/merchants/${currentMerchant.id}`, values)
      message.success('商家更新成功')
      setEditMerchantModalOpen(false)
      setCurrentMerchant(null)
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '商家更新失败')
    }
  }

  const openEditAssignmentModal = (assignment) => {
    setCurrentAssignment(assignment)
    editAssignmentForm.setFieldsValue({
      priority: assignment.priority,
      monthly_target: assignment.monthly_target,
      status: assignment.status,
      notes: assignment.notes,
    })
    setEditAssignmentModalOpen(true)
  }

  const handleEditAssignmentSubmit = async () => {
    try {
      const values = await editAssignmentForm.validateFields()
      await api.put(`/api/merchant-assignments/${currentAssignment.id}`, values)
      message.success('分配更新成功')
      setEditAssignmentModalOpen(false)
      setCurrentAssignment(null)
      await Promise.all([fetchStats(), fetchMerchants(merchantPage, merchantPageSize), fetchAssignments(assignmentPage, assignmentPageSize)])
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '分配更新失败')
    }
  }

  const merchantColumns = [
    {
      title: '商家名称',
      dataIndex: 'merchant_name',
      key: 'merchant_name',
      width: 220,
      fixed: 'left',
      render: (text, record) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{text || '-'}</span>
          <Space size={6}>
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>{record.merchant_id || '待补MID'}</span>
            {record.missing_mid ? <Tag color="orange">待补MID</Tag> : null}
          </Space>
        </Space>
      ),
    },
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 120,
      render: (val) => <Tag color="blue">{val || '-'}</Tag>,
    },
    {
      title: '类别',
      dataIndex: 'category',
      key: 'category',
      width: 120,
      render: (val) => val || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (val) => <Tag color={statusColorMap[val] || 'default'}>{val || '-'}</Tag>,
    },
    {
      title: '当前负责人',
      dataIndex: 'assigned_users',
      key: 'assigned_users',
      width: 260,
      render: (assignedUsers) => {
        if (!assignedUsers?.length) return <Tag>未分配</Tag>
        return (
          <Space wrap>
            {assignedUsers.map((u) => (
              <Tag key={u.assignment_id} color="purple">
                {u.display_name || u.username || `用户${u.user_id}`}
              </Tag>
            ))}
          </Space>
        )
      },
    },
    {
      title: '近30天订单',
      dataIndex: 'orders_30d',
      key: 'orders_30d',
      width: 120,
      align: 'right',
      sorter: (a, b) => (a.orders_30d || 0) - (b.orders_30d || 0),
      render: (val) => (val || 0).toLocaleString(),
    },
    {
      title: '近30天佣金',
      dataIndex: 'commission_30d',
      key: 'commission_30d',
      width: 140,
      align: 'right',
      sorter: (a, b) => (a.commission_30d || 0) - (b.commission_30d || 0),
      render: (val) => `$${(val || 0).toFixed(2)}`,
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Button size="small" disabled={!canManage} onClick={() => openEditMerchantModal(record)}>
          编辑
        </Button>
      ),
    },
  ]

  const assignmentColumns = [
    {
      title: '商家',
      key: 'merchant',
      width: 220,
      fixed: 'left',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 600 }}>{record.merchant?.merchant_name || '-'}</span>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>
            {record.merchant?.platform || '-'} / {record.merchant?.merchant_id || '-'}
          </span>
        </Space>
      ),
    },
    canManage && {
      title: '负责人',
      key: 'owner',
      width: 140,
      render: (_, record) => record.display_name || record.username || '-',
    },
    {
      title: '分配人',
      dataIndex: 'assigned_by_name',
      key: 'assigned_by_name',
      width: 120,
      render: (val) => val || '-',
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (val) => <Tag color={priorityColorMap[val] || 'default'}>{val || '-'}</Tag>,
    },
    {
      title: '月目标佣金',
      dataIndex: 'monthly_target',
      key: 'monthly_target',
      width: 140,
      align: 'right',
      render: (val) => (val ? `$${Number(val).toFixed(2)}` : '-'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (val) => <Tag color={statusColorMap[val] || 'default'}>{val || '-'}</Tag>,
    },
    {
      title: '分配时间',
      dataIndex: 'assigned_at',
      key: 'assigned_at',
      width: 180,
      render: (val) => (val ? new Date(val).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '备注',
      dataIndex: 'notes',
      key: 'notes',
      width: 180,
      render: (val) => val || '-',
    },
    canManage && {
      title: '操作',
      key: 'action',
      width: 190,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openEditAssignmentModal(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认取消该分配吗？"
            onConfirm={() => handleCancelAssignment(record.id)}
            okText="确认"
            cancelText="取消"
          >
            <Button size="small" danger>
              取消
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ].filter(Boolean)

  const merchantRowSelection = canManage
    ? {
        selectedRowKeys: selectedMerchantIds,
        onChange: (keys) => setSelectedMerchantIds(keys),
      }
    : undefined

  const assignmentRowSelection = canManage
    ? {
        selectedRowKeys: selectedAssignmentIds,
        onChange: (keys) => setSelectedAssignmentIds(keys),
      }
    : undefined

  // 员工视角的简化统计
  const myAssignmentStats = useMemo(() => {
    const activeCount = assignments.filter(a => a.status === 'active').length
    return { activeCount }
  }, [assignments])

  return (
    <div>
      {canManage && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic title="商家总数" value={stats.total || 0} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic title="已分配商家" value={stats.assigned || 0} valueStyle={{ color: '#1677ff' }} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic title="未分配商家" value={stats.unassigned || 0} valueStyle={{ color: '#fa8c16' }} />
              </Card>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Card>
                <Statistic title="待补MID" value={stats.missing_mid_total || 0} valueStyle={{ color: '#d46b08' }} />
              </Card>
            </Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} md={8}>
              <Card>
                <Statistic title="商家发现成功率" value={stats.discovery_rate || 0} precision={2} suffix="%" valueStyle={{ color: '#389e0d' }} />
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card>
                <Statistic title="MID缺失率" value={stats.missing_mid_rate || 0} precision={2} suffix="%" valueStyle={{ color: '#cf1322' }} />
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card>
                <Space direction="vertical" size={4}>
                  <Space wrap>
                    <Tag color="processing">平台分布</Tag>
                    <span>{byPlatformText}</span>
                  </Space>
                  <Space wrap>
                    <Tag color="orange">待补MID分布</Tag>
                    <span>{missingMidByPlatformText}</span>
                  </Space>
                </Space>
              </Card>
            </Col>
          </Row>
        </>
      )}

      <Tabs
        activeKey={canManage ? tabKey : 'assignments'}
        onChange={setTabKey}
        items={[
          canManage && {
            key: 'merchants',
            label: '商家目录',
            children: (
              <Card
                title="商家目录"
                extra={
                  <Space>
                    <Tooltip title="重新加载数据">
                      <Button icon={<ReloadOutlined />} onClick={() => fetchMerchants(merchantPage, merchantPageSize)} />
                    </Tooltip>
                    <Button icon={<SyncOutlined />} loading={discoverLoading} onClick={handleDiscover}>同步商家</Button>
                    {canManage && (
                      <Button
                        type="primary"
                        icon={<UserSwitchOutlined />}
                        disabled={!selectedMerchantIds.length}
                        onClick={() => {
                          setAssignModalOpen(true)
                          assignForm.setFieldsValue({ priority: 'normal' })
                        }}
                      >
                        分配给员工
                      </Button>
                    )}
                  </Space>
                }
              >
                <Space wrap style={{ marginBottom: 12 }}>
                  <Select
                    allowClear
                    placeholder="平台"
                    style={{ width: 140 }}
                    value={merchantFilters.platform}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, platform: v }))}
                  >
                    {platformOptions.map((p) => (
                      <Option key={p} value={p}>{p}</Option>
                    ))}
                  </Select>

                  <Input
                    allowClear
                    placeholder="搜索商家名/MID/slug"
                    style={{ width: 240 }}
                    value={merchantFilters.search}
                    prefix={<SearchOutlined />}
                    onChange={(e) => setMerchantFilters((s) => ({ ...s, search: e.target.value }))}
                    onPressEnter={() => fetchMerchants(1, merchantPageSize)}
                  />

                  <Select
                    allowClear
                    placeholder="状态"
                    style={{ width: 120 }}
                    value={merchantFilters.status}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, status: v }))}
                  >
                    <Option value="active">active</Option>
                    <Option value="inactive">inactive</Option>
                  </Select>

                  <Select
                    allowClear
                    placeholder="分配状态"
                    style={{ width: 140 }}
                    value={merchantFilters.assigned}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, assigned: v }))}
                  >
                    <Option value={true}>已分配</Option>
                    <Option value={false}>未分配</Option>
                  </Select>

                  <Select
                    allowClear
                    placeholder="MID状态"
                    style={{ width: 140 }}
                    value={merchantFilters.missing_mid}
                    onChange={(v) => setMerchantFilters((s) => ({ ...s, missing_mid: v }))}
                  >
                    <Option value={true}>待补MID</Option>
                    <Option value={false}>MID完整</Option>
                  </Select>

                  <Button type="primary" onClick={() => fetchMerchants(1, merchantPageSize)}>查询</Button>
                  <Button
                    onClick={() => {
                      setMerchantFilters({
                        platform: undefined,
                        category: undefined,
                        status: undefined,
                        assigned: undefined,
                        missing_mid: undefined,
                        search: '',
                      })
                      setTimeout(() => fetchMerchants(1, merchantPageSize), 0)
                    }}
                  >
                    重置
                  </Button>
                </Space>

                <Table
                  rowKey="id"
                  loading={loading && tabKey === 'merchants'}
                  columns={merchantColumns}
                  dataSource={merchants}
                  rowSelection={merchantRowSelection}
                  scroll={{ x: 1350 }}
                  pagination={{
                    current: merchantPage,
                    pageSize: merchantPageSize,
                    total: merchantTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (page, size) => fetchMerchants(page, size),
                  }}
                />
              </Card>
            ),
          },
          {
            key: 'assignments',
            label: canManage ? '分配记录' : '我的商家',
            children: (
              <Card
                title={canManage ? '分配记录' : '我的商家'}
                extra={
                  <Space>
                    <Button icon={<ReloadOutlined />} onClick={() => fetchAssignments(assignmentPage, assignmentPageSize)} />
                    {isManager && (
                      <Button
                        type="primary"
                        disabled={!selectedAssignmentIds.length}
                        onClick={() => setTransferModalOpen(true)}
                      >
                        批量转移
                      </Button>
                    )}
                  </Space>
                }
              >
                <Space wrap style={{ marginBottom: 12 }}>
                  {canManage && (
                    <Select
                      allowClear
                      placeholder="负责人"
                      style={{ width: 180 }}
                      value={assignmentFilters.user_id}
                      onChange={(v) => setAssignmentFilters((s) => ({ ...s, user_id: v }))}
                    >
                      {userOptions.map((u) => (
                        <Option key={u.id} value={u.id}>
                          {u.display_name || u.username}
                        </Option>
                      ))}
                    </Select>
                  )}

                  <Select
                    allowClear
                    placeholder="状态"
                    style={{ width: 140 }}
                    value={assignmentFilters.status}
                    onChange={(v) => setAssignmentFilters((s) => ({ ...s, status: v }))}
                  >
                    <Option value="active">active</Option>
                    <Option value="completed">completed</Option>
                    <Option value="cancelled">cancelled</Option>
                  </Select>

                  <Button type="primary" onClick={() => fetchAssignments(1, assignmentPageSize)}>查询</Button>
                  <Button
                    onClick={() => {
                      setAssignmentFilters({ user_id: undefined, status: undefined })
                      setTimeout(() => fetchAssignments(1, assignmentPageSize), 0)
                    }}
                  >
                    重置
                  </Button>
                </Space>

                <Table
                  rowKey="id"
                  loading={loading && tabKey === 'assignments'}
                  columns={assignmentColumns}
                  dataSource={assignments}
                  rowSelection={canManage ? assignmentRowSelection : undefined}
                  scroll={{ x: canManage ? 1400 : 1000 }}
                  pagination={{
                    current: assignmentPage,
                    pageSize: assignmentPageSize,
                    total: assignmentTotal,
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (page, size) => fetchAssignments(page, size),
                  }}
                />
              </Card>
            ),
          },
        ].filter(Boolean)}
      />

      <Modal
        title={`批量分配商家（${selectedMerchantIds.length}个）`}
        open={assignModalOpen}
        onOk={handleAssignSubmit}
        onCancel={() => {
          setAssignModalOpen(false)
          assignForm.resetFields()
        }}
        destroyOnHidden
      >
        <Form form={assignForm} layout="vertical">
          <Form.Item name="user_id" label="分配给员工" rules={[{ required: true, message: '请选择员工' }]}> 
            <Select placeholder="选择员工">
              {userOptions.map((u) => (
                <Option key={u.id} value={u.id}>{u.display_name || u.username}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <Select>
              <Option value="high">high</Option>
              <Option value="normal">normal</Option>
              <Option value="low">low</Option>
            </Select>
          </Form.Item>
          <Form.Item name="monthly_target" label="月度目标佣金($)">
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`批量转移分配（${selectedAssignmentIds.length}条）`}
        open={transferModalOpen}
        onOk={handleTransferSubmit}
        onCancel={() => {
          setTransferModalOpen(false)
          transferForm.resetFields()
        }}
        destroyOnHidden
      >
        <Form form={transferForm} layout="vertical">
          <Form.Item name="new_user_id" label="转移给员工" rules={[{ required: true, message: '请选择员工' }]}> 
            <Select placeholder="选择员工">
              {userOptions.map((u) => (
                <Option key={u.id} value={u.id}>{u.display_name || u.username}</Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑商家"
        open={editMerchantModalOpen}
        onOk={handleEditMerchantSubmit}
        onCancel={() => {
          setEditMerchantModalOpen(false)
          setCurrentMerchant(null)
        }}
        destroyOnHidden
      >
        <Form form={editMerchantForm} layout="vertical">
          <Form.Item
            name="merchant_id"
            label="MID"
            rules={[
              {
                pattern: /^\d*$/,
                message: 'MID 仅支持纯数字（留空表示待补）',
              },
            ]}
          >
            <Input placeholder="留空表示待补MID；填写时必须为纯数字" />
          </Form.Item>
          <Form.Item name="category" label="类别">
            <Input placeholder="例如 beauty / fashion" />
          </Form.Item>
          <Form.Item name="commission_rate" label="佣金比例">
            <Input placeholder="例如 8%" />
          </Form.Item>
          <Form.Item name="slug" label="Slug">
            <Input placeholder="可选" />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select>
              <Option value="active">active</Option>
              <Option value="inactive">inactive</Option>
            </Select>
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑分配"
        open={editAssignmentModalOpen}
        onOk={handleEditAssignmentSubmit}
        onCancel={() => {
          setEditAssignmentModalOpen(false)
          setCurrentAssignment(null)
        }}
        destroyOnHidden
      >
        <Form form={editAssignmentForm} layout="vertical">
          <Form.Item name="priority" label="优先级">
            <Select>
              <Option value="high">high</Option>
              <Option value="normal">normal</Option>
              <Option value="low">low</Option>
            </Select>
          </Form.Item>
          <Form.Item name="monthly_target" label="月度目标佣金($)">
            <InputNumber min={0} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select>
              <Option value="active">active</Option>
              <Option value="completed">completed</Option>
              <Option value="cancelled">cancelled</Option>
            </Select>
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default MerchantManagement
