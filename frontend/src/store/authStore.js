import { create } from 'zustand'
import api from '../services/api'

export const useAuth = create((set) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),

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

      set({ user, token: access_token, isAuthenticated: true })
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
    set({ user: null, token: null, isAuthenticated: false })
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
}))












