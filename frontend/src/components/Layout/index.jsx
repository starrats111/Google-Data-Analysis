import React, { useState, useEffect } from 'react'
import { Layout as AntLayout, Menu, Avatar, Dropdown, Space, Drawer, Button } from 'antd'
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
} from '@ant-design/icons'
import { useAuth } from '../../store/authStore'

const { Header, Sider, Content } = AntLayout

const Layout = () => {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileDrawerVisible, setMobileDrawerVisible] = useState(false)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuth()
  
  const isManager = user?.role === 'manager'

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

  // 员工菜单 - 分组折叠
  const employeeMenuItems = [
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
  ]

  // 经理菜单 - 完全重设计
  const managerMenuItems = [
    {
      key: 'overview',
      icon: <DashboardOutlined />,
      label: '总览',
      children: [
        { key: '/', icon: <DashboardOutlined />, label: '团队总览' },
      ],
    },
    {
      key: 'employee-manage',
      icon: <TeamOutlined />,
      label: '员工管理',
      children: [
        { key: '/employees', icon: <TeamOutlined />, label: '员工列表' },
      ],
    },
    {
      key: 'reports',
      icon: <FileTextOutlined />,
      label: '报表中心',
      children: [
        { key: '/financial-report', icon: <BankOutlined />, label: '财务报表' },
        { key: '/report-monthly', icon: <FileTextOutlined />, label: '本月报表' },
        { key: '/report-quarterly', icon: <FileTextOutlined />, label: '本季度报表' },
        { key: '/report-yearly', icon: <FileTextOutlined />, label: '本年度报表' },
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

  const menuItems = isManager ? managerMenuItems : employeeMenuItems

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

  const [openKeys, setOpenKeys] = useState(getOpenKeys())

  useEffect(() => {
    setOpenKeys(getOpenKeys())
  }, [location.pathname, isManager])

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

  const handleUserMenuClick = ({ key }) => {
    if (key === 'logout') {
      logout()
      navigate('/login')
    }
  }

  const handleOpenChange = (keys) => {
    setOpenKeys(keys)
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
          onCollapse={setCollapsed}
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
        styles={{ body: { padding: 0, background: '#001529' } }}
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
                {user?.username} ({isManager ? '经理' : '员工'})
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
