import { create } from 'zustand'
import api from '../services/api'

export const useAuth = create((set) => ({
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),

  login: async (username, password) => {
    const formData = new FormData()
    formData.append('username', username)
    formData.append('password', password)

    const response = await api.post('/api/auth/login', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })

    const { access_token, user } = response.data
    localStorage.setItem('token', access_token)
    localStorage.setItem('user', JSON.stringify(user))

    set({ user, token: access_token, isAuthenticated: true })
    return user
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








