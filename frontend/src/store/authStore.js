import { create } from 'zustand'
import api from '../services/api'

export const useAuth = create((set, get) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),
  permissions: JSON.parse(localStorage.getItem('permissions') || 'null'),

  login: async (username, password) => {
    try {
      // FastAPI OAuth2PasswordRequestForm expects x-www-form-urlencoded, not multipart/form-data
      const body = new URLSearchParams()
      body.append('username', username)
      body.append('password', password)

      const response = await api.post('/api/auth/login', body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const { access_token, user } = response.data
      localStorage.setItem('token', access_token)
      localStorage.setItem('user', JSON.stringify(user))
      
      // 清理之前用户的缓存数据
      try {
        sessionStorage.clear()
      } catch (e) {
        // 忽略缓存清除错误
      }

      set({ user, token: access_token, isAuthenticated: true })
      
      // 获取用户权限信息
      await get().fetchPermissions()
      
      return user
    } catch (error) {
      // 提供更详细的错误信息
      if (error.response) {
        // 服务器返回了错误响应
        throw new Error(error.response.data?.detail || '登录失败，请检查用户名和密码')
      } else if (error.request) {
        // 请求已发出但没有收到响应
        throw new Error('无法连接到服务器，请检查网络连接或联系管理员')
      } else {
        // 其他错误
        throw new Error(error.message || '登录失败，请稍后重试')
      }
    }
  },

  logout: () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    localStorage.removeItem('permissions')
    // 清理所有缓存数据，避免用户切换后看到其他用户的数据
    try {
      sessionStorage.clear()
    } catch (e) {
      // 忽略缓存清除错误
    }
    set({ user: null, token: null, isAuthenticated: false, permissions: null })
  },

  getCurrentUser: async () => {
    try {
      const response = await api.get('/api/auth/me')
      const user = response.data
      localStorage.setItem('user', JSON.stringify(user))
      set({ user })
      return user
    } catch (error) {
      console.error('获取用户信息失败', error)
    }
  },
  
  fetchPermissions: async () => {
    try {
      const response = await api.get('/api/team/me/info')
      const data = response.data
      const permissions = {
        ...data.permissions,
        role: data.role,
        team: data.team
      }
      localStorage.setItem('permissions', JSON.stringify(permissions))
      set({ permissions })
      return permissions
    } catch (error) {
      console.error('获取权限信息失败', error)
      // 设置默认权限（普通成员）
      const defaultPerms = {
        is_manager: false,
        is_leader: false,
        can_view_all_teams: false,
        can_view_team: false,
        can_manage_users: false,
        can_edit_team_members: false,
        role: 'member',
        team: null
      }
      set({ permissions: defaultPerms })
      return defaultPerms
    }
  },
  
  // 便捷方法
  isManager: () => get().permissions?.is_manager || false,
  isLeader: () => get().permissions?.is_leader || false,
  canViewTeam: () => get().permissions?.can_view_team || false,
  canManageUsers: () => get().permissions?.can_manage_users || false,
}))












