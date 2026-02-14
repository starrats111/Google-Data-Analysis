import React, { useState, useEffect } from 'react'
import { Layout as AntLayout, Menu, Avatar, Dropdown, Space, Drawer, Button, Tag } from 'antd'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
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
  SendOutlined,
  CheckCircleOutlined,
  BellOutlined,
} from '@ant-design/icons'
import { useAuth } from '../../store/authStore'

const { Header, Sider, Content } = AntLayout

const Layout = () => {
  // 从 localStorage 读取持久化的 collapsed 状态
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem('sider_collapsed')
    return saved === 'true'
  })
  const [mobileDrawerVisible, setMobileDrawerVisible] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout, permissions, fetchPermissions } = useAuth()
  
  // 角色判断
  const userRole = permissions?.role || user?.role || 'member'
  const isManager = userRole === 'manager'
  const isLeader = userRole === 'leader'
  const teamInfo = permissions?.team
  
  // 露出功能授权用户列表 (wj01-wj10)
  const LUCHU_AUTHORIZED_USERS = ['wj01', 'wj02', 'wj03', 'wj04', 'wj05', 'wj06', 'wj07', 'wj08', 'wj09', 'wj10']
  const hasLuchuAccess = user?.username && LUCHU_AUTHORIZED_USERS.includes(user.username)
  
  // 首次加载时获取权限
  useEffect(() => {
    if (!permissions && user) {
      fetchPermissions()
    }
  }, [user])

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
      key: 'account-manage',
      icon: <SettingOutlined />,
      label: '账号管理',
      children: [
        { key: '/mcc-accounts', icon: <AccountBookOutlined />, label: 'MCC账号' },
        { key: '/accounts', icon: <AccountBookOutlined />, label: '平台账号' },
      ],
    },
    {
      key: 'luchu',
      icon: <EditOutlined />,
      label: '露出管理',
      children: [
        { key: '/luchu', icon: <DashboardOutlined />, label: '露出总览' },
        { key: '/luchu/create', icon: <EditOutlined />, label: '创建内容' },
        { key: '/luchu/articles', icon: <FileTextOutlined />, label: '我的文章' },
        { key: '/luchu/publish', icon: <SendOutlined />, label: '待发布' },
        { key: '/luchu/notifications', icon: <BellOutlined />, label: '通知中心' },
      ],
    },
  ]

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
      key: 'luchu',
      icon: <EditOutlined />,
      label: '露出管理',
      children: [
        { key: '/luchu', icon: <DashboardOutlined />, label: '露出总览' },
        { key: '/luchu/create', icon: <EditOutlined />, label: '创建内容' },
        { key: '/luchu/articles', icon: <FileTextOutlined />, label: '全部文章' },
        { key: '/luchu/reviews', icon: <CheckCircleOutlined />, label: '审核管理' },
        { key: '/luchu/publish', icon: <SendOutlined />, label: '发布管理' },
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
      key: 'luchu',
      icon: <EditOutlined />,
      label: '露出管理',
      children: [
        { key: '/luchu', icon: <DashboardOutlined />, label: '露出总览' },
        { key: '/luchu/create', icon: <EditOutlined />, label: '创建内容' },
        { key: '/luchu/articles', icon: <FileTextOutlined />, label: '全部文章' },
        { key: '/luchu/reviews', icon: <CheckCircleOutlined />, label: '审核管理' },
        { key: '/luchu/publish', icon: <SendOutlined />, label: '发布管理' },
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
    
    // 如果用户没有露出功能权限，过滤掉露出菜单
    if (!hasLuchuAccess) {
      items = items.filter(item => item.key !== 'luchu')
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

  const renderMenu = () => (
    <Menu
      theme="dark"
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
      <div style={{
        height: 64,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontSize: collapsed ? 16 : 18,
        fontWeight: 'bold',
        background: 'rgba(255,255,255,0.1)',
      }}>
        {collapsed ? 'GA' : '数据分析平台'}
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
          theme="dark"
          width={220}
          style={{
            overflow: 'auto',
            height: '100vh',
            position: 'fixed',
            left: 0,
            top: 0,
            bottom: 0,
            zIndex: 100,
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
        styles={{ body: { padding: 0, background: '#0C2D48' } }}
      >
        {siderContent}
      </Drawer>

      <AntLayout style={{ marginLeft: isMobile ? 0 : (collapsed ? 80 : 220), transition: 'margin-left 0.2s' }}>
        <Header style={{
          background: '#fff',
          padding: '0 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
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
        </Header>
        <Content style={{
          margin: isMobile ? '12px' : '24px',
          padding: isMobile ? 12 : 24,
          background: '#fff',
          minHeight: 280,
          borderRadius: 8,
        }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  )
}

export default Layout
