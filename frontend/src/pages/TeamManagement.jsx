import React, { useState, useEffect, useMemo } from 'react'
import { 
  Card, Tabs, Table, Button, Space, Tag, Modal, Form, Input, Select, 
  message, Popconfirm, Statistic, Row, Col, Progress, Typography, Spin, Empty, Dropdown
} from 'antd'
import { 
  TeamOutlined, UserOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  ReloadOutlined, CrownOutlined, TrophyOutlined, DollarOutlined, CloudSyncOutlined, SyncOutlined, DownOutlined
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '../services/api'
import { useAuth } from '../store/authStore'

const { Title, Text } = Typography
const { Option } = Select

const TeamManagement = () => {
  const { permissions } = useAuth()
  const [activeTab, setActiveTab] = useState('overview')
  
  // 数据状态
  const [teams, setTeams] = useState([])
  const [users, setUsers] = useState([])
  const [teamStats, setTeamStats] = useState([])
  const [memberRanking, setMemberRanking] = useState([])
  const [loading, setLoading] = useState(false)
  
  // 弹窗状态
  const [userModalOpen, setUserModalOpen] = useState(false)
  const [teamModalOpen, setTeamModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [editingTeam, setEditingTeam] = useState(null)
  
  // 筛选状态
  const [selectedTeamFilter, setSelectedTeamFilter] = useState(null)
  const [syncing, setSyncing] = useState(false)
  
  const [userForm] = Form.useForm()
  const [teamForm] = Form.useForm()

  // 本月日期范围
  const monthDateRange = useMemo(() => {
    const now = dayjs()
    return {
      start_date: now.startOf('month').format('YYYY-MM-DD'),
      end_date: now.endOf('month').format('YYYY-MM-DD')
    }
  }, [])

  // 加载数据
  const loadData = async () => {
    setLoading(true)
    try {
      // 统计数据使用本月日期范围
      const [teamsRes, usersRes, statsRes, rankingRes] = await Promise.all([
        api.get('/api/team/teams'),
        api.get('/api/team/users'),
        api.get('/api/team/stats/teams', { params: monthDateRange }),
        api.get('/api/team/stats/ranking', { params: { limit: 50, ...monthDateRange } })
      ])
      setTeams(teamsRes.data)
      setUsers(usersRes.data)
      setTeamStats(statsRes.data)
      setMemberRanking(rankingRes.data)
    } catch (error) {
      console.error('加载数据失败:', error)
      message.error('加载数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  // 角色显示
  const getRoleTag = (role) => {
    switch (role) {
      case 'manager': return <Tag color="gold" icon={<CrownOutlined />}>经理</Tag>
      case 'leader': return <Tag color="blue" icon={<TeamOutlined />}>组长</Tag>
      default: return <Tag color="default">组员</Tag>
    }
  }

  // 同步团队数据
  const handleSync = async (syncType = 'all') => {
    setSyncing(true)
    message.loading({ content: '正在启动数据同步...', key: 'sync', duration: 0 })
    
    try {
      const response = await api.post('/api/team/sync-team-data', null, {
        params: { sync_type: syncType }
      })
      
      if (response.data.background) {
        message.success({
          content: `${response.data.message}`,
          key: 'sync',
          duration: 5
        })
      } else {
        message.success({
          content: response.data.message,
          key: 'sync'
        })
      }
      
      // 延迟刷新数据
      setTimeout(() => loadData(), 2000)
      
    } catch (error) {
      console.error('同步失败:', error)
      message.error({
        content: `同步失败: ${error.response?.data?.detail || error.message}`,
        key: 'sync'
      })
    } finally {
      setSyncing(false)
    }
  }

  // 同步菜单项
  const syncMenuItems = [
    { key: 'all', label: '同步全部数据', icon: <CloudSyncOutlined /> },
    { key: 'platform', label: '仅同步平台数据', icon: <SyncOutlined /> },
    { key: 'google', label: '仅同步广告数据', icon: <SyncOutlined /> }
  ]

  // ========== 用户管理 ==========
  const handleAddUser = () => {
    setEditingUser(null)
    userForm.resetFields()
    setUserModalOpen(true)
  }

  const handleEditUser = (user) => {
    setEditingUser(user)
    userForm.setFieldsValue({
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      team_id: user.team_id
    })
    setUserModalOpen(true)
  }

  const handleSaveUser = async () => {
    try {
      const values = await userForm.validateFields()
      
      if (editingUser) {
        // 更新用户
        await api.put(`/api/team/users/${editingUser.id}`, values)
        message.success('用户已更新')
      } else {
        // 创建用户
        await api.post('/api/team/users', values)
        message.success('用户已创建')
      }
      
      setUserModalOpen(false)
      loadData()
    } catch (error) {
      console.error('保存用户失败:', error)
      message.error(error.response?.data?.detail || '保存失败')
    }
  }

  const handleDeleteUser = async (userId) => {
    try {
      await api.delete(`/api/team/users/${userId}`)
      message.success('用户已删除')
      loadData()
    } catch (error) {
      console.error('删除用户失败:', error)
      message.error(error.response?.data?.detail || '删除失败')
    }
  }

  const handleResetPassword = (userId) => {
    Modal.confirm({
      title: '重置密码',
      content: (
        <Input.Password
          id="reset-pwd-input"
          placeholder="请输入新密码（至少6位）"
          style={{ marginTop: 12 }}
        />
      ),
      okText: '确认重置',
      cancelText: '取消',
      onOk: async () => {
        const pwd = document.getElementById('reset-pwd-input')?.value
        if (!pwd || pwd.length < 6) {
          message.error('密码长度不能少于6位')
          throw new Error('密码过短')
        }
        try {
          await api.post(`/api/team/users/${userId}/reset-password`, { new_password: pwd })
          message.success('密码已重置')
        } catch (error) {
          message.error(error.response?.data?.detail || '重置失败')
          throw error
        }
      }
    })
  }

  // ========== 小组管理 ==========
  const handleAddTeam = () => {
    setEditingTeam(null)
    teamForm.resetFields()
    setTeamModalOpen(true)
  }

  const handleEditTeam = (team) => {
    setEditingTeam(team)
    teamForm.setFieldsValue({
      team_code: team.team_code,
      team_name: team.team_name,
      leader_id: team.leader_id
    })
    setTeamModalOpen(true)
  }

  const handleSaveTeam = async () => {
    try {
      const values = await teamForm.validateFields()
      
      if (editingTeam) {
        await api.put(`/api/team/teams/${editingTeam.id}`, values)
        message.success('小组已更新')
      } else {
        await api.post('/api/team/teams', values)
        message.success('小组已创建')
      }
      
      setTeamModalOpen(false)
      loadData()
    } catch (error) {
      console.error('保存小组失败:', error)
      message.error(error.response?.data?.detail || '保存失败')
    }
  }

  // 用户表格列
  const userColumns = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      width: 120,
    },
    {
      title: '显示名',
      dataIndex: 'display_name',
      key: 'display_name',
      width: 120,
      render: (text) => text || '-'
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (role) => getRoleTag(role)
    },
    {
      title: '小组',
      dataIndex: 'team_name',
      key: 'team_name',
      width: 120,
      render: (text, record) => text ? (
        <Tag color="processing">{text}</Tag>
      ) : '-'
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (date) => date ? new Date(date).toLocaleDateString('zh-CN') : '-'
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space size="small">
          <Button 
            type="link" 
            size="small" 
            icon={<EditOutlined />}
            onClick={() => handleEditUser(record)}
          >
            编辑
          </Button>
          <Button type="link" size="small" onClick={() => handleResetPassword(record.id)}>重置密码</Button>
          {record.role !== 'manager' && (
            <Popconfirm
              title="确定删除此用户？"
              onConfirm={() => handleDeleteUser(record.id)}
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      )
    }
  ]

  // 小组表格列
  const teamColumns = [
    {
      title: '小组代码',
      dataIndex: 'team_code',
      key: 'team_code',
      width: 100,
    },
    {
      title: '小组名称',
      dataIndex: 'team_name',
      key: 'team_name',
      width: 150,
    },
    {
      title: '组长',
      dataIndex: 'leader_name',
      key: 'leader_name',
      width: 120,
      render: (text) => text ? (
        <Tag color="blue" icon={<CrownOutlined />}>{text}</Tag>
      ) : '-'
    },
    {
      title: '成员数',
      dataIndex: 'member_count',
      key: 'member_count',
      width: 100,
      render: (count) => <Tag color="green">{count} 人</Tag>
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_, record) => (
        <Space>
          <Button 
            type="link" 
            size="small" 
            icon={<EditOutlined />}
            onClick={() => handleEditTeam(record)}
          >
            编辑
          </Button>
        </Space>
      )
    }
  ]

  // 渲染数据总览
  const renderOverview = () => (
    <div>
      {/* 筛选栏 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <Text strong style={{ fontSize: 16 }}>
              📅 {dayjs().format('YYYY年M月')} 数据
            </Text>
            <Text type="secondary">
              ({monthDateRange.start_date} ~ {monthDateRange.end_date})
            </Text>
          </Space>
          <Space>
            <Text>筛选小组：</Text>
            <Select 
              style={{ width: 150 }} 
              value={selectedTeamFilter}
              onChange={setSelectedTeamFilter}
              allowClear
              placeholder="全部小组"
            >
              {teams.map(t => (
                <Option key={t.id} value={t.id}>{t.team_name}</Option>
              ))}
            </Select>
            <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
            <Dropdown
              menu={{
                items: syncMenuItems,
                onClick: ({ key }) => handleSync(key)
              }}
              disabled={syncing}
            >
              <Button type="primary" icon={<CloudSyncOutlined />} loading={syncing}>
                同步最新数据 <DownOutlined />
              </Button>
            </Dropdown>
          </Space>
        </Space>
      </Card>

      {/* 小组统计卡片 */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        {teamStats.map(stat => (
          <Col xs={24} sm={12} md={8} key={stat.team_code}>
            <Card 
              hoverable
              style={{ 
                borderLeft: `4px solid ${stat.avg_roi >= 0 ? '#52c41a' : '#ff4d4f'}`,
                marginBottom: 16
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <Title level={4} style={{ margin: 0 }}>
                  <TeamOutlined style={{ marginRight: 8 }} />
                  {stat.team_name}
                </Title>
                <Tag color="blue">{stat.member_count} 人</Tag>
              </div>
              <Row gutter={8}>
                <Col span={8}>
                  <Statistic 
                    title="费用" 
                    value={stat.total_cost} 
                    precision={2} 
                    prefix="$"
                    valueStyle={{ fontSize: 14, color: '#cf1322' }}
                  />
                </Col>
                <Col span={8}>
                  <Statistic 
                    title="总佣金" 
                    value={stat.total_commission} 
                    precision={2} 
                    prefix="$"
                    valueStyle={{ fontSize: 14, color: '#4DA6FF' }}
                  />
                </Col>
                <Col span={8}>
                  <Statistic 
                    title="净佣金" 
                    value={stat.net_commission || 0} 
                    precision={2} 
                    prefix="$"
                    valueStyle={{ fontSize: 14, color: '#52c41a' }}
                  />
                </Col>
              </Row>
              <Row gutter={8} style={{ marginTop: 8 }}>
                <Col span={8}>
                  <Statistic 
                    title="拒付" 
                    value={stat.rejected_commission || 0} 
                    precision={2} 
                    prefix="$"
                    valueStyle={{ fontSize: 14, color: '#ff4d4f' }}
                  />
                </Col>
                <Col span={16}>
                  <Statistic 
                    title="利润" 
                    value={stat.total_profit} 
                    precision={2} 
                    prefix="$"
                    valueStyle={{ fontSize: 14, color: stat.total_profit >= 0 ? '#52c41a' : '#ff4d4f' }}
                  />
                </Col>
              </Row>
              <div style={{ marginTop: 12 }}>
                <Text type="secondary">ROI</Text>
                <Progress 
                  percent={Math.min(Math.abs(stat.avg_roi), 100)} 
                  status={stat.avg_roi >= 0 ? 'success' : 'exception'}
                  format={() => `${stat.avg_roi}%`}
                />
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* 成员排行榜 */}
      <Card 
        title={<><TrophyOutlined style={{ marginRight: 8, color: '#faad14' }} />成员排行榜</>}
      >
        {memberRanking.length > 0 ? (
          <Table
            dataSource={memberRanking}
            rowKey="user_id"
            pagination={false}
            columns={[
              {
                title: '排名',
                key: 'rank',
                width: 80,
                render: (_, record, index) => {
                  // 根据当前排序找出排名（使用原始索引）
                  const rank = index + 1
                  if (rank === 1) return <Tag color="gold">🥇 1</Tag>
                  if (rank === 2) return <Tag color="default">🥈 2</Tag>
                  if (rank === 3) return <Tag color="orange">🥉 3</Tag>
                  return rank
                }
              },
              {
                title: '用户',
                dataIndex: 'username',
                key: 'username',
                width: 150,
                render: (text, record) => (
                  <Space>
                    <UserOutlined />
                    {record.display_name || text}
                  </Space>
                )
              },
              {
                title: '小组',
                dataIndex: 'team_name',
                key: 'team_name',
                width: 120,
                filters: teams.map(t => ({ text: t.team_name, value: t.team_name })),
                onFilter: (value, record) => record.team_name === value,
                render: (text) => text ? <Tag color="processing">{text}</Tag> : '-'
              },
              {
                title: '费用',
                dataIndex: 'cost',
                key: 'cost',
                width: 100,
                sorter: (a, b) => (a.cost || 0) - (b.cost || 0),
                render: (v) => <Text type="danger">${(v || 0).toFixed(2)}</Text>
              },
              {
                title: '总佣金',
                dataIndex: 'commission',
                key: 'commission',
                width: 100,
                sorter: (a, b) => (a.commission || 0) - (b.commission || 0),
                render: (v) => <Text type="success">${(v || 0).toFixed(2)}</Text>
              },
              {
                title: '拒付',
                dataIndex: 'rejected_commission',
                key: 'rejected_commission',
                width: 90,
                sorter: (a, b) => (a.rejected_commission || 0) - (b.rejected_commission || 0),
                render: (v) => <Text type="danger">${(v || 0).toFixed(2)}</Text>
              },
              {
                title: '净佣金',
                dataIndex: 'net_commission',
                key: 'net_commission',
                width: 100,
                sorter: (a, b) => (a.net_commission || 0) - (b.net_commission || 0),
                render: (v) => (
                  <Text style={{ color: (v || 0) >= 0 ? '#52c41a' : '#ff4d4f', fontWeight: 600 }}>
                    {(v || 0) >= 0 ? '+' : ''}${(v || 0).toFixed(2)}
                  </Text>
                )
              },
              {
                title: 'ROI',
                dataIndex: 'roi',
                key: 'roi',
                width: 90,
                sorter: (a, b) => (a.roi || 0) - (b.roi || 0),
                defaultSortOrder: 'descend',
                render: (v) => (
                  <Tag color={(v || 0) >= 20 ? 'success' : (v || 0) >= 0 ? 'processing' : 'error'} style={{ fontSize: 14 }}>
                    {(v || 0) >= 0 ? '+' : ''}{(v || 0).toFixed(1)}%
                  </Tag>
                )
              }
            ]}
          />
        ) : (
          <Empty description="暂无数据" />
        )}
      </Card>
    </div>
  )

  // 渲染用户管理
  const renderUserManagement = () => (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
        <Space>
          <Select 
            style={{ width: 150 }} 
            value={selectedTeamFilter}
            onChange={setSelectedTeamFilter}
            allowClear
            placeholder="筛选小组"
          >
            {teams.map(t => (
              <Option key={t.id} value={t.id}>{t.team_name}</Option>
            ))}
          </Select>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAddUser}>
          新建用户
        </Button>
      </div>
      <Table
        dataSource={selectedTeamFilter 
          ? users.filter(u => u.team_id === selectedTeamFilter)
          : users
        }
        columns={userColumns}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 15 }}
      />
    </div>
  )

  // 渲染小组管理
  const renderTeamManagement = () => (
    <div>
      <div style={{ marginBottom: 16, textAlign: 'right' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAddTeam}>
          新建小组
        </Button>
      </div>
      <Table
        dataSource={teams}
        columns={teamColumns}
        rowKey="id"
        loading={loading}
        pagination={false}
      />
    </div>
  )

  const tabItems = [
    {
      key: 'overview',
      label: '数据总览',
      children: renderOverview()
    },
    {
      key: 'users',
      label: '用户管理',
      children: renderUserManagement()
    },
    {
      key: 'teams',
      label: '小组管理',
      children: renderTeamManagement()
    }
  ]

  return (
    <div>
      <Title level={3}>
        <TeamOutlined style={{ marginRight: 12 }} />
        团队管理
      </Title>

      <Spin spinning={loading}>
        <Tabs 
          activeKey={activeTab} 
          onChange={setActiveTab}
          items={tabItems}
        />
      </Spin>

      {/* 用户编辑弹窗 */}
      <Modal
        title={editingUser ? '编辑用户' : '新建用户'}
        open={userModalOpen}
        onOk={handleSaveUser}
        onCancel={() => setUserModalOpen(false)}
        width={500}
      >
        <Form form={userForm} layout="vertical">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input disabled={!!editingUser} placeholder="如 wj01, jy05" />
          </Form.Item>
          {!editingUser && (
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password placeholder="初始密码" />
            </Form.Item>
          )}
          <Form.Item name="display_name" label="显示名">
            <Input placeholder="中文名或昵称" />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            rules={[{ required: true, message: '请选择角色' }]}
          >
            <Select placeholder="选择角色">
              <Option value="member">组员</Option>
              <Option value="leader">组长</Option>
              <Option value="manager">经理</Option>
            </Select>
          </Form.Item>
          <Form.Item name="team_id" label="所属小组">
            <Select placeholder="选择小组" allowClear>
              {teams.map(t => (
                <Option key={t.id} value={t.id}>{t.team_name}</Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 小组编辑弹窗 */}
      <Modal
        title={editingTeam ? '编辑小组' : '新建小组'}
        open={teamModalOpen}
        onOk={handleSaveTeam}
        onCancel={() => setTeamModalOpen(false)}
        width={400}
      >
        <Form form={teamForm} layout="vertical">
          <Form.Item
            name="team_code"
            label="小组代码"
            rules={[{ required: true, message: '请输入小组代码' }]}
          >
            <Input disabled={!!editingTeam} placeholder="如 wj, jy, yz" />
          </Form.Item>
          <Form.Item
            name="team_name"
            label="小组名称"
            rules={[{ required: true, message: '请输入小组名称' }]}
          >
            <Input placeholder="如 文俊组" />
          </Form.Item>
          {editingTeam && (
            <Form.Item name="leader_id" label="组长">
              <Select placeholder="选择组长" allowClear>
                {users
                  .filter(u => u.team_id === editingTeam.id)
                  .map(u => (
                    <Option key={u.id} value={u.id}>
                      {u.display_name || u.username}
                    </Option>
                  ))
                }
              </Select>
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}

export default TeamManagement

