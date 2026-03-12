import React, { useState, useEffect, useCallback } from 'react'
import { Layout as AntLayout, Menu, Avatar, Dropdown, Space, Drawer, Button, Tag, Badge, Tooltip, List, Typography, Spin, Popover, Modal, Form, Select, Input, message } from 'antd'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import api from '../../services/api'
import {
  DashboardOutlined,
  BarChartOutlined,
  UserOutlined,
  LogoutOutlined,
  AccountBookOutlined,
  RocketOutlined,
  TeamOutlined,
  FileTextOutlined,
  SettingOutlined,
  DatabaseOutlined,
  MenuOutlined,
  BankOutlined,
  FileSearchOutlined,
  CrownOutlined,
  EditOutlined,
  BellOutlined,
  GiftOutlined,
  ShopOutlined,
  FundViewOutlined,
  CommentOutlined,
  GlobalOutlined,
  ExperimentOutlined,
} from '@ant-design/icons'
import { useAuth } from '../../store/authStore'
import ChangelogModal, { hasUnreadChangelog } from '../ChangelogModal'

const { Header, Sider, Content } = AntLayout

// 新手引导：仅展示一次，可跳过（localStorage）
const NEW_FEATURE_GUIDE_KEY = 'new_feature_guide_2026_03'
const getGuideSkipped = () => !!localStorage.getItem(NEW_FEATURE_GUIDE_KEY)
const setGuideSkipped = () => localStorage.setItem(NEW_FEATURE_GUIDE_KEY, '1')

const Layout = () => {
  // 从 localStorage 读取持久化的 collapsed 状态
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem('sider_collapsed')
    return saved === 'true'
  })
  const [mobileDrawerVisible, setMobileDrawerVisible] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [changelogVisible, setChangelogVisible] = useState(false)
  const [changelogUnread, setChangelogUnread] = useState(false)
  const [notificationUnreadCount, setNotificationUnreadCount] = useState(0)
  const [notificationList, setNotificationList] = useState([])
  const [notificationTotal, setNotificationTotal] = useState(0)
  const [notificationPage, setNotificationPage] = useState(1)
  const [notificationLoading, setNotificationLoading] = useState(false)
  const [notificationLoadingMore, setNotificationLoadingMore] = useState(false)
  const [notificationDropdownOpen, setNotificationDropdownOpen] = useState(false)
  const [guideVisible, setGuideVisible] = useState(false)
  const [feedbackVisible, setFeedbackVisible] = useState(false)
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [feedbackForm] = Form.useForm()
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout, permissions, fetchPermissions } = useAuth()

  // 角色判断
  const userRole = permissions?.role || user?.role || 'member'
  const isManager = userRole === 'manager'
  const isLeader = userRole === 'leader'
  const teamInfo = permissions?.team


  // 首次加载时获取权限
  useEffect(() => {
    if (!permissions && user) {
      fetchPermissions()
    }
  }, [user])

  // 更新日志：登录后检查是否有未读版本
  useEffect(() => {
    if (user) {
      const unread = hasUnreadChangelog()
      setChangelogUnread(unread)
      if (unread && getGuideSkipped()) {
        setChangelogVisible(true)
      }
    }
  }, [user])

  // 新手引导：登录后若未跳过则展示一次（可跳过），优先于更新日志
  useEffect(() => {
    if (!user) return
    if (getGuideSkipped()) return
    const t = setTimeout(() => setGuideVisible(true), 600)
    return () => clearTimeout(t)
  }, [user])

  // OPT-001：消息通知未读数量（首次 + 每 60 秒轮询）
  const fetchNotificationUnreadCount = useCallback(async () => {
    if (!user) return
    try {
      const res = await api.get('/api/notifications/unread-count')
      setNotificationUnreadCount(res.data?.count ?? 0)
    } catch (_) {
      // 未登录或接口失败静默
    }
  }, [user])
  useEffect(() => {
    if (!user) return
    fetchNotificationUnreadCount()
    const timer = setInterval(fetchNotificationUnreadCount, 60000)
    return () => clearInterval(timer)
  }, [user, fetchNotificationUnreadCount])

  const NOTIFICATION_PAGE_SIZE = 20
  // OPT-001：打开铃铛时拉取通知列表（首页）
  const fetchNotificationList = useCallback(async () => {
    if (!user) return
    setNotificationLoading(true)
    setNotificationPage(1)
    try {
      const res = await api.get('/api/notifications', { params: { page: 1, page_size: NOTIFICATION_PAGE_SIZE } })
      setNotificationList(res.data?.items ?? [])
      setNotificationTotal(res.data?.total ?? 0)
    } catch (_) {
      setNotificationList([])
      setNotificationTotal(0)
    } finally {
      setNotificationLoading(false)
    }
  }, [user])
  // G-01：加载更多通知
  const fetchMoreNotifications = useCallback(async () => {
    if (!user) return
    const nextPage = notificationPage + 1
    setNotificationLoadingMore(true)
    try {
      const res = await api.get('/api/notifications', { params: { page: nextPage, page_size: NOTIFICATION_PAGE_SIZE } })
      const newItems = res.data?.items ?? []
      setNotificationList((prev) => [...prev, ...newItems])
      setNotificationPage(nextPage)
      setNotificationTotal(res.data?.total ?? notificationTotal)
    } catch (_) {
      // ignore
    } finally {
      setNotificationLoadingMore(false)
    }
  }, [user, notificationPage, notificationTotal])
  const handleNotificationOpenChange = (open) => {
    setNotificationDropdownOpen(open)
    if (open) fetchNotificationList()
  }
  const handleMarkNotificationRead = async (id) => {
    try {
      await api.put(`/api/notifications/${id}/read`)
      setNotificationList((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)))
      fetchNotificationUnreadCount()
    } catch (_) {}
  }
  const handleMarkAllNotificationsRead = async () => {
    try {
      await api.put('/api/notifications/read-all')
      setNotificationList((prev) => prev.map((n) => ({ ...n, is_read: true })))
      setNotificationUnreadCount(0)
      fetchNotificationUnreadCount()
    } catch (_) {}
  }

  // 响应式检测
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
      if (window.innerWidth >= 768) {
        setMobileDrawerVisible(false)
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // 普通组员菜单
  const memberMenuItems = [
    {
      key: 'workspace',
      icon: <DashboardOutlined />,
      label: '工作台',
      children: [
        { key: '/', icon: <DashboardOutlined />, label: '数据总览' },
        { key: '/analysis-l7d', icon: <BarChartOutlined />, label: 'L7D分析' },
        { key: '/bid-management', icon: <SettingOutlined />, label: '出价管理' },
      ],
    },
    {
      key: 'ai-tools',
      icon: <RocketOutlined />,
      label: 'AI工具',
      children: [
        { key: '/ad-copy', icon: <RocketOutlined />, label: 'AI广告词生成' },
        { key: '/my-reports', icon: <FileTextOutlined />, label: '我的报告' },
      ],
    },
    {
      key: 'data-center',
      icon: <DatabaseOutlined />,
      label: '数据查看',
      children: [
        { key: '/data-center', icon: <DatabaseOutlined />, label: '数据中心' },
      ],
    },
    {
      key: 'merchant-manage',
      icon: <ShopOutlined />,
      label: '商家管理',
      children: [
        { key: '/merchant-management', icon: <ShopOutlined />, label: '商家查找' },
        { key: '/merchant-performance', icon: <FundViewOutlined />, label: '绩效看板' },
        { key: '/ads/test-dashboard', icon: <ExperimentOutlined />, label: '测试商家' },
      ],
    },
    {
      key: 'account-manage',
      icon: <SettingOutlined />,
      label: '账号管理',
      children: [
        { key: '/mcc-accounts', icon: <AccountBookOutlined />, label: 'MCC账号' },
        { key: '/accounts', icon: <AccountBookOutlined />, label: '平台账号' },
      ],
    },
    {
      key: 'article-manage',
      icon: <FileTextOutlined />,
      label: '文章管理',
      children: [
        { key: '/articles', icon: <FileTextOutlined />, label: '文章列表' },
        { key: '/articles/publish', icon: <EditOutlined />, label: '发布文章' },
        { key: '/articles/titles', icon: <FileTextOutlined />, label: '标题库' },
        { key: '/articles/categories', icon: <DatabaseOutlined />, label: '分类管理' },
        { key: '/articles/sites', icon: <GlobalOutlined />, label: '网站管理' },
      ],
    },
    {
      key: 'feedback-manage',
      icon: <CommentOutlined />,
      label: '反馈管理',
      children: [
        { key: '/feedback-manage', icon: <CommentOutlined />, label: '反馈列表' },
      ],
    },
  ]

  const isFeedbackManager = user?.username === 'wj07'

  // 组长菜单 - 类似经理菜单格式，但用小组总览
  const leaderMenuItems = [
    {
      key: 'overview',
      icon: <DashboardOutlined />,
      label: '总览',
      children: [
        { key: '/team-overview', icon: <TeamOutlined />, label: '小组总览' },
      ],
    },
    {
      key: 'employee-manage',
      icon: <TeamOutlined />,
      label: '员工管理',
      children: [
        { key: '/employees', icon: <UserOutlined />, label: '员工列表' },
      ],
    },
    {
      key: 'report-center',
      icon: <FileTextOutlined />,
      label: '报表中心',
      children: [
        { key: '/financial-report', icon: <AccountBookOutlined />, label: '财务报表' },
        { key: '/report-monthly', icon: <FileTextOutlined />, label: '本月报表' },
        { key: '/report-quarterly', icon: <FileTextOutlined />, label: '本季度报表' },
        { key: '/report-yearly', icon: <FileTextOutlined />, label: '本年度报表' },
      ],
    },
    {
      key: 'merchant-manage',
      icon: <ShopOutlined />,
      label: '商家管理',
      children: [
        { key: '/merchant-management', icon: <ShopOutlined />, label: '商家查找' },
        { key: '/merchant-performance', icon: <FundViewOutlined />, label: '绩效看板' },
        { key: '/ads/test-dashboard', icon: <ExperimentOutlined />, label: '测试商家' },
      ],
    },
    {
      key: 'article-manage',
      icon: <FileTextOutlined />,
      label: '文章管理',
      children: [
        { key: '/articles', icon: <FileTextOutlined />, label: '文章列表' },
        { key: '/articles/publish', icon: <EditOutlined />, label: '发布文章' },
        { key: '/articles/titles', icon: <FileTextOutlined />, label: '标题库' },
        { key: '/articles/categories', icon: <DatabaseOutlined />, label: '分类管理' },
        { key: '/articles/sites', icon: <GlobalOutlined />, label: '网站管理' },
      ],
    },
    {
      key: 'system-manage',
      icon: <SettingOutlined />,
      label: '系统管理',
      children: [
        { key: '/mcc-accounts', icon: <AccountBookOutlined />, label: '所有MCC账号' },
        { key: '/accounts', icon: <AccountBookOutlined />, label: '所有平台账号' },
        { key: '/system-logs', icon: <FileSearchOutlined />, label: '系统日志' },
      ],
    },
  ]

  // 经理菜单 - 和截图格式一致，把「总览>团队总览」改为「团队管理」
  const managerMenuItems = [
    {
      key: 'overview',
      icon: <DashboardOutlined />,
      label: '总览',
      children: [
        { key: '/team-management', icon: <TeamOutlined />, label: '团队管理' },
      ],
    },
    {
      key: 'employee-manage',
      icon: <TeamOutlined />,
      label: '员工管理',
      children: [
        { key: '/employees', icon: <UserOutlined />, label: '员工列表' },
      ],
    },
    {
      key: 'report-center',
      icon: <FileTextOutlined />,
      label: '报表中心',
      children: [
        { key: '/financial-report', icon: <AccountBookOutlined />, label: '财务报表' },
        { key: '/report-monthly', icon: <FileTextOutlined />, label: '本月报表' },
        { key: '/report-quarterly', icon: <FileTextOutlined />, label: '本季度报表' },
        { key: '/report-yearly', icon: <FileTextOutlined />, label: '本年度报表' },
      ],
    },
    {
      key: 'merchant-manage',
      icon: <ShopOutlined />,
      label: '商家管理',
      children: [
        { key: '/merchant-management', icon: <ShopOutlined />, label: '商家查找' },
        { key: '/merchant-performance', icon: <FundViewOutlined />, label: '绩效看板' },
        { key: '/ads/test-dashboard', icon: <ExperimentOutlined />, label: '测试商家' },
      ],
    },
    {
      key: 'article-manage',
      icon: <FileTextOutlined />,
      label: '文章管理',
      children: [
        { key: '/articles', icon: <FileTextOutlined />, label: '文章列表' },
        { key: '/articles/publish', icon: <EditOutlined />, label: '发布文章' },
        { key: '/articles/titles', icon: <FileTextOutlined />, label: '标题库' },
        { key: '/articles/categories', icon: <DatabaseOutlined />, label: '分类管理' },
        { key: '/articles/sites', icon: <GlobalOutlined />, label: '网站管理' },
      ],
    },
    {
      key: 'system-manage',
      icon: <SettingOutlined />,
      label: '系统管理',
      children: [
        { key: '/mcc-accounts', icon: <AccountBookOutlined />, label: '所有MCC账号' },
        { key: '/accounts', icon: <AccountBookOutlined />, label: '所有平台账号' },
        { key: '/system-logs', icon: <FileSearchOutlined />, label: '系统日志' },
      ],
    },
  ]

  // 根据角色选择菜单，并根据权限过滤露出菜单
  const getMenuItems = () => {
    let items
    if (isManager) items = managerMenuItems
    else if (isLeader) items = leaderMenuItems
    else items = memberMenuItems

    if (!isFeedbackManager) {
      items = items.filter(item => item.key !== 'feedback-manage')
    }

    return items
  }

  const menuItems = getMenuItems()

  // 计算当前选中的菜单项和展开的子菜单
  const getSelectedKeys = () => {
    const path = location.pathname
    // 兼容老路径
    if (path === '/google-ads-data' || path === '/platform-data') {
      return ['/data-center']
    }
    if (path === '/my-analysis') {
      return ['/analysis-l7d']
    }
    return [path]
  }

  const getOpenKeys = () => {
    const path = location.pathname
    for (const group of menuItems) {
      if (group.children) {
        for (const item of group.children) {
          if (item.key === path || (path === '/google-ads-data' || path === '/platform-data') && item.key === '/data-center') {
            return [group.key]
          }
        }
      }
    }
    // 默认展开第一个
    return [menuItems[0]?.key]
  }

  // 从 localStorage 读取持久化的 collapsed 状态
  const [openKeys, setOpenKeys] = useState(() => {
    const saved = localStorage.getItem('sider_open_keys')
    if (saved) {
      try {
        return JSON.parse(saved)
      } catch {
        return getOpenKeys()
      }
    }
    return getOpenKeys()
  })

  // 确保当前路径对应的菜单组是展开的（合并到现有的 openKeys 中）
  useEffect(() => {
    const currentGroupKey = getOpenKeys()[0]
    if (currentGroupKey && !openKeys.includes(currentGroupKey)) {
      const newOpenKeys = [...openKeys, currentGroupKey]
      setOpenKeys(newOpenKeys)
      localStorage.setItem('sider_open_keys', JSON.stringify(newOpenKeys))
    }
  }, [location.pathname])

  // 角色变化时重新初始化菜单
  useEffect(() => {
    setOpenKeys(getOpenKeys())
  }, [isManager, isLeader])

  const userMenuItems = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人资料',
    },
    {
      key: 'guide',
      icon: <GiftOutlined />,
      label: '新功能引导',
    },
    {
      key: 'feedback',
      icon: <EditOutlined />,
      label: '提交反馈',
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
    },
  ]

  const handleMenuClick = ({ key }) => {
    navigate(key)
    if (isMobile) {
      setMobileDrawerVisible(false)
    }
  }

  const handleUserMenuClick = async ({ key }) => {
    if (key === 'guide') {
      setGuideVisible(true)
      return
    }
    if (key === 'feedback') {
      feedbackForm.setFieldsValue({
        feedback_type: 'data_issue',
        subject: '',
        content: '',
      })
      setFeedbackVisible(true)
      return
    }
    if (key === 'logout') {
      await logout()
      navigate('/login')
    }
  }

  const handleOpenChange = (keys) => {
    setOpenKeys(keys)
    // 持久化展开状态
    localStorage.setItem('sider_open_keys', JSON.stringify(keys))
  }

  const submitFeedback = async () => {
    try {
      const values = await feedbackForm.validateFields()
      setFeedbackSubmitting(true)
      await api.post('/api/feedback', {
        feedback_type: values.feedback_type,
        subject: values.subject,
        content: values.content,
        page_path: location.pathname,
      })
      message.success('反馈已提交给维护人员 wj07')
      setFeedbackVisible(false)
      feedbackForm.resetFields()
    } catch (error) {
      if (error?.errorFields) return
      message.error(error.response?.data?.detail || '反馈提交失败')
    } finally {
      setFeedbackSubmitting(false)
    }
  }

  const renderMenu = () => (
    <Menu
      theme="light"
      selectedKeys={getSelectedKeys()}
      openKeys={openKeys}
      onOpenChange={handleOpenChange}
      mode="inline"
      items={menuItems}
      onClick={handleMenuClick}
    />
  )

  const siderContent = (
    <>
      <div className="sidebar-logo">
        <span className={`sidebar-logo-text ${collapsed ? 'sidebar-logo-collapsed' : ''}`}>
          {collapsed ? 'GA' : '数据分析平台'}
        </span>
      </div>
      {renderMenu()}
    </>
  )

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      {/* 桌面端侧边栏 */}
      {!isMobile && (
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={(value) => {
            setCollapsed(value)
            localStorage.setItem('sider_collapsed', value.toString())
          }}
          width={220}
          style={{
            overflow: 'auto',
            height: '100vh',
            position: 'fixed',
            left: 0,
            top: 0,
            bottom: 0,
            zIndex: 100,
            background: '#FFFFFF',
            borderRight: '1px solid #E8EAED',
          }}
        >
          {siderContent}
        </Sider>
      )}

      {/* 移动端抽屉 */}
      <Drawer
        placement="left"
        closable={false}
        onClose={() => setMobileDrawerVisible(false)}
        open={mobileDrawerVisible}
        width={220}
        styles={{ body: { padding: 0, background: '#FFFFFF' } }}
      >
        {siderContent}
      </Drawer>

      <AntLayout style={{ marginLeft: isMobile ? 0 : (collapsed ? 80 : 220), transition: 'margin-left 0.2s', background: '#F0F5FA' }}>
        <Header style={{
          background: '#fff',
          padding: '0 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          position: 'sticky',
          top: 0,
          zIndex: 99,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {isMobile && (
              <Button
                type="text"
                icon={<MenuOutlined />}
                onClick={() => setMobileDrawerVisible(true)}
              />
            )}
            <h2 style={{ margin: 0, fontSize: isMobile ? 16 : 18 }}>
              谷歌广告数据分析平台
            </h2>
          </div>
          <Space size={12} align="center">
            {/* OPT-001 消息通知铃铛 */}
            <Popover
              open={notificationDropdownOpen}
              onOpenChange={handleNotificationOpenChange}
              trigger="click"
              placement="bottomRight"
              content={
                <div style={{ width: 360, maxWidth: '90vw' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <Typography.Text strong>消息通知</Typography.Text>
                    {notificationUnreadCount > 0 && (
                      <Button type="link" size="small" onClick={handleMarkAllNotificationsRead}>
                        全部已读
                      </Button>
                    )}
                  </div>
                  <Spin spinning={notificationLoading}>
                    <List
                      size="small"
                      dataSource={notificationList}
                      locale={{ emptyText: '暂无通知' }}
                      style={{ maxHeight: 400, overflow: 'auto' }}
                      renderItem={(item) => (
                        <List.Item
                          key={item.id}
                          style={{ cursor: item.is_read ? 'default' : 'pointer', opacity: item.is_read ? 0.85 : 1 }}
                          onClick={() => !item.is_read && handleMarkNotificationRead(item.id)}
                        >
                          <List.Item.Meta
                            avatar={
                              <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.is_read ? '#d9d9d9' : '#ff4d4f', flexShrink: 0, marginTop: 6 }} />
                            }
                            title={<Typography.Text ellipsis style={{ fontSize: 13 }}>{item.title}</Typography.Text>}
                            description={
                              <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ rows: 2 }}>
                                {item.content}
                                <br />
                                {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}
                              </Typography.Text>
                            }
                          />
                        </List.Item>
                      )}
                    />
                  </Spin>
                  <div style={{ textAlign: 'center', marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 8, display: 'flex', justifyContent: 'center', gap: 16 }}>
                    {notificationList.length < notificationTotal && (
                      <Button type="link" size="small" loading={notificationLoadingMore} onClick={fetchMoreNotifications}>
                        查看更多
                      </Button>
                    )}
                    <Typography.Link type="secondary" style={{ fontSize: 12 }} onClick={() => setNotificationDropdownOpen(false)}>
                      关闭
                    </Typography.Link>
                  </div>
                </div>
              }
            >
              <Tooltip title="消息通知">
                <Badge count={notificationUnreadCount} offset={[-2, 2]} size="small">
                  <Button
                    type="text"
                    icon={<BellOutlined style={{ fontSize: 18 }} />}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  />
                </Badge>
              </Tooltip>
            </Popover>
            <Tooltip title="更新日志">
              <Badge dot={changelogUnread} offset={[-2, 2]}>
                <Button
                  type="text"
                  icon={<GiftOutlined style={{ fontSize: 18 }} />}
                  onClick={() => setChangelogVisible(true)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                />
              </Badge>
            </Tooltip>
            <Dropdown
            menu={{
              items: userMenuItems,
              onClick: handleUserMenuClick,
            }}
            placement="bottomRight"
          >
            <Space style={{ cursor: 'pointer' }}>
              <Avatar icon={<UserOutlined />} />
              <span style={{ display: isMobile ? 'none' : 'inline' }}>
                {user?.display_name || user?.username}
                {isManager && <Tag color="gold" style={{ marginLeft: 8 }}>经理</Tag>}
                {isLeader && <Tag color="blue" style={{ marginLeft: 8 }}>{teamInfo?.name || '组长'}</Tag>}
                {!isManager && !isLeader && <Tag color="default" style={{ marginLeft: 8 }}>员工</Tag>}
              </span>
            </Space>
          </Dropdown>
          </Space>
          <ChangelogModal
            open={changelogVisible}
            onClose={() => {
              setChangelogVisible(false)
              setChangelogUnread(false)
            }}
          />
          <Modal
            title="新功能引导"
            open={guideVisible}
            onCancel={() => {
              setGuideSkipped()
              setGuideVisible(false)
              if (hasUnreadChangelog()) setChangelogVisible(true)
            }}
            footer={[
              <Button
                key="skip"
                onClick={() => {
                  setGuideSkipped()
                  setGuideVisible(false)
                  if (hasUnreadChangelog()) setChangelogVisible(true)
                }}
              >
                跳过
              </Button>,
              <Button
                key="ok"
                type="primary"
                onClick={() => {
                  setGuideSkipped()
                  setGuideVisible(false)
                  setChangelogVisible(true)
                }}
              >
                查看更新日志
              </Button>,
            ]}
          >
            <div style={{ lineHeight: 1.8 }}>
              <p><b>欢迎使用新版平台</b>，已为你准备好以下能力：</p>
              <ul style={{ paddingLeft: 20 }}>
                <li>脚本模式支持公开 CSV 链接读取，无需 Google API 授权</li>
                <li>MCC 配置新增新手引导，按步骤完成即可稳定同步</li>
                <li>错误提示更清晰，数据校验更严格，避免常见填错</li>
                <li>新增商家管理模块：商家目录与分配、绩效看板</li>
              </ul>
              <p style={{ color: '#666', marginTop: 8 }}>
                你可以随时在右上角“礼物”图标再次查看更新日志。
              </p>
            </div>
          </Modal>

          <Modal
            title="提交反馈"
            open={feedbackVisible}
            onCancel={() => {
              setFeedbackVisible(false)
              feedbackForm.resetFields()
            }}
            onOk={submitFeedback}
            confirmLoading={feedbackSubmitting}
            okText="提交反馈"
            cancelText="取消"
            destroyOnHidden
          >
            <Form form={feedbackForm} layout="vertical">
              <Form.Item
                label="反馈类型"
                name="feedback_type"
                rules={[{ required: true, message: '请选择反馈类型' }]}
              >
                <Select>
                  <Select.Option value="data_issue">数据误差</Select.Option>
                  <Select.Option value="feature_experience">功能体验不理想</Select.Option>
                  <Select.Option value="bug_report">功能异常/报错</Select.Option>
                  <Select.Option value="feature_request">新功能建议</Select.Option>
                  <Select.Option value="other">其他</Select.Option>
                </Select>
              </Form.Item>

              <Form.Item label="反馈标题" name="subject" rules={[{ required: true, message: '请输入反馈标题' }]}>
                <Input maxLength={120} placeholder="例如：LH 商家佣金与后台不一致" />
              </Form.Item>

              <Form.Item
                label="详细描述"
                name="content"
                rules={[
                  { required: true, message: '请描述具体问题' },
                  { min: 5, message: '至少输入 5 个字符' },
                ]}
              >
                <Input.TextArea
                  rows={6}
                  maxLength={3000}
                  placeholder="请尽量写清楚：\n1) 问题现象\n2) 出现页面/时间范围\n3) 期望结果"
                />
              </Form.Item>

              <Typography.Text type="secondary">
                反馈将直接发送给维护人员 wj07。当前页面：{location.pathname}
              </Typography.Text>
            </Form>
          </Modal>
        </Header>

        <Content style={{ margin: isMobile ? '12px' : '16px', minHeight: 280 }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  )
}

export default Layout
