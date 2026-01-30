import React from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import Analysis from './pages/Analysis'
import AffiliateAccounts from './pages/AffiliateAccounts'
import MccAccounts from './pages/MccAccounts'
import AdCampaigns from './pages/AdCampaigns'
import Expenses from './pages/Expenses'
import StageLabelDetail from './pages/StageLabelDetail'
import OAuthTool from './pages/OAuthTool'
import { useAuth } from './store/authStore'

function PrivateRoute({ children }) {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? children : <Navigate to="/login" />
}

function App() {
  return (
    <Router
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/oauth-tool" element={<OAuthTool />} />
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="upload" element={<Upload />} />
          {/* L7D 分析 & 每日分析 分开路由 */}
          <Route path="analysis-l7d" element={<Analysis mode="l7d" />} />
          <Route path="analysis-daily" element={<Analysis mode="daily" />} />
          {/* 兼容老链接：/analysis 默认跳到 L7D 分析页 */}
          <Route path="analysis" element={<Navigate to="/analysis-l7d" replace />} />
          <Route path="accounts" element={<AffiliateAccounts />} />
          <Route path="mcc-accounts" element={<MccAccounts />} />
          <Route path="ad-campaigns" element={<AdCampaigns />} />
          <Route path="expenses" element={<Expenses />} />
          <Route path="stage-label/:label" element={<StageLabelDetail />} />
        </Route>
      </Routes>
    </Router>
  )
}

export default App

