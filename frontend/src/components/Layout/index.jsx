import React, { useState } from 'react'
import { Layout as AntLayout, Menu, Avatar, Dropdown, Space } from 'antd'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  DashboardOutlined,
  UploadOutlined,
  BarChartOutlined,
  UserOutlined,
  LogoutOutlined,
  AccountBookOutlined,
  AppstoreOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import { useAuth } from '../../store/authStore'

const { Header, Sider, Content } = AntLayout

const Layout = () => {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuth()

  // 菜单项：恢复所有必要入口，去掉多余字眼
  const allMenuItems = [
    {
      key: '/',
      icon: <DashboardOutlined />,
      label: '数据总览',
    },
    {
      key: '/my-analysis',
      icon: <BarChartOutlined />,
      label: '我的分析',
    },
    {
      key: '/google-ads-data',
      icon: <BarChartOutlined />,
      label: '谷歌每日数据',
    },
    {
      key: '/platform-data',
      icon: <AccountBookOutlined />,
      label: '平台每日数据',
    },
    {
      key: '/expenses',
      icon: <WalletOutlined />,
      label: '我的收益',
    },
    {
      key: '/mcc-accounts',
      icon: <AccountBookOutlined />,
      label: 'MCC账号',
    },
    {
      key: '/accounts',
      icon: <AccountBookOutlined />,
      label: '平台账号',
    },
    {
      key: '/ad-campaigns',
      icon: <AppstoreOutlined />,
      label: '我的广告列表',
      roles: ['employee'], // 仅员工可见
    },
  ]

  // 根据用户角色过滤菜单项
  const menuItems = allMenuItems.filter(item => {
    if (!item.roles) return true // 没有 roles 限制的，所有人都可见
    return item.roles.includes(user?.role || '')
  })

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
  }

  const handleUserMenuClick = ({ key }) => {
    if (key === 'logout') {
      logout()
      navigate('/login')
    }
  }

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="dark"
      >
        <div style={{
          height: 64,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontSize: collapsed ? 16 : 18,
          fontWeight: 'bold'
        }}>
          {collapsed ? 'GA' : '数据分析平台'}
        </div>
        <Menu
          theme="dark"
          selectedKeys={[location.pathname]}
          mode="inline"
          items={menuItems}
          onClick={handleMenuClick}
        />
      </Sider>
      <AntLayout>
        <Header style={{
          background: '#fff',
          padding: '0 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
        }}>
          <h2 style={{ margin: 0 }}>谷歌广告数据分析平台</h2>
          <Dropdown
            menu={{
              items: userMenuItems,
              onClick: handleUserMenuClick,
            }}
            placement="bottomRight"
          >
            <Space style={{ cursor: 'pointer' }}>
              <Avatar icon={<UserOutlined />} />
              <span>{user?.username} ({user?.role === 'manager' ? '经理' : '员工'})</span>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{
          margin: '24px',
          padding: 24,
          background: '#fff',
          minHeight: 280,
        }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  )
}

export default Layout








