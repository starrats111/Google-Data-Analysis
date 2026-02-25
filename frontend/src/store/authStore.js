import { create } from 'zustand'
import api from '../services/api'
import { setToken as setHolderToken, clearToken as clearHolderToken } from '../services/tokenHolder'

// 跨标签页同步（SEC-7）：当一个标签页登出/刷新 Token 时通知其他标签页
let broadcastChannel = null
try {
  broadcastChannel = new BroadcastChannel('auth_sync')
} catch (_) {
  // BroadcastChannel 不可用时静默降级
}

export const useAuth = create((set, get) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: null,
  isAuthenticated: false,
  permissions: JSON.parse(localStorage.getItem('permissions') || 'null'),
  _initialized: false,

  /**
   * 启动时调用：尝试用 httpOnly Refresh Token Cookie 静默获取 Access Token
   * 成功则恢复登录态，失败则跳登录页
   */
  initAuth: async () => {
    if (get()._initialized) return
    set({ _initialized: true })

    const savedUser = JSON.parse(localStorage.getItem('user') || 'null')
    if (!savedUser) return

    try {
      const response = await api.post('/api/auth/refresh')
      const newToken = response.data.access_token
      setHolderToken(newToken)
      set({ token: newToken, isAuthenticated: true, user: savedUser })
      await get().fetchPermissions()
    } catch (_) {
      localStorage.removeItem('user')
      localStorage.removeItem('permissions')
      set({ user: null, token: null, isAuthenticated: false, permissions: null })
    }
  },

  login: async (username, password) => {
    try {
      const body = new URLSearchParams()
      body.append('username', username)
      body.append('password', password)

      const response = await api.post('/api/auth/login', body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      const { access_token, user } = response.data
      localStorage.setItem('user', JSON.stringify(user))
      setHolderToken(access_token)

      try {
        sessionStorage.clear()
      } catch (_) {}

      set({ user, token: access_token, isAuthenticated: true })

      await get().fetchPermissions()

      if (broadcastChannel) {
        broadcastChannel.postMessage({ type: 'LOGIN' })
      }

      return user
    } catch (error) {
      if (error.response) {
        throw new Error(error.response.data?.detail || '登录失败，请检查用户名和密码')
      } else if (error.request) {
        throw new Error('无法连接到服务器，请检查网络连接或联系管理员')
      } else {
        throw new Error(error.message || '登录失败，请稍后重试')
      }
    }
  },

  logout: async () => {
    try {
      await api.post('/api/auth/logout')
    } catch (_) {}

    clearHolderToken()
    localStorage.removeItem('user')
    localStorage.removeItem('permissions')

    try {
      sessionStorage.clear()
    } catch (_) {}

    set({ user: null, token: null, isAuthenticated: false, permissions: null })

    if (broadcastChannel) {
      broadcastChannel.postMessage({ type: 'LOGOUT' })
    }
  },

  setToken: (newToken) => {
    setHolderToken(newToken)
    set({ token: newToken, isAuthenticated: !!newToken })
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

  isManager: () => get().permissions?.is_manager || false,
  isLeader: () => get().permissions?.is_leader || false,
  canViewTeam: () => get().permissions?.can_view_team || false,
  canManageUsers: () => get().permissions?.can_manage_users || false,
}))

// 监听其他标签页的登出/登录事件
if (broadcastChannel) {
  broadcastChannel.onmessage = (event) => {
    if (event.data?.type === 'LOGOUT') {
      useAuth.setState({
        user: null, token: null, isAuthenticated: false, permissions: null
      })
      localStorage.removeItem('user')
      localStorage.removeItem('permissions')
      window.location.href = '/login'
    }
  }
}
