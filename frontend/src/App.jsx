import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import Layout from './components/Layout'
import Login from './pages/Login'
import { useAuth } from './store/authStore'

// 懒加载页面组件，减少初始加载时间
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Analysis = lazy(() => import('./pages/Analysis'))
const AffiliateAccounts = lazy(() => import('./pages/AffiliateAccounts'))
const MccAccounts = lazy(() => import('./pages/MccAccounts'))
const MccDataAggregate = lazy(() => import('./pages/MccDataAggregate'))
const PlatformData = lazy(() => import('./pages/PlatformData'))
const GoogleAdsData = lazy(() => import('./pages/GoogleAdsData'))
const Expenses = lazy(() => import('./pages/Expenses'))
const ExpenseCostDetail = lazy(() => import('./pages/ExpenseCostDetail'))
const MyAnalysis = lazy(() => import('./pages/MyAnalysis'))
const StageLabelDetail = lazy(() => import('./pages/StageLabelDetail'))
const GoogleOAuthCallback = lazy(() => import('./pages/GoogleOAuthCallback'))
const RejectionDetails = lazy(() => import('./pages/RejectionDetails'))
const AdCopyGenerator = lazy(() => import('./pages/AdCopyGenerator'))
const MyReports = lazy(() => import('./pages/MyReports'))

// 加载中的占位组件
const PageLoading = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
    <Spin size="large" tip="加载中..." />
  </div>
)

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
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/google-oauth-callback" element={<GoogleOAuthCallback />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <Layout />
              </PrivateRoute>
            }
          >
            <Route index element={<Dashboard />} />
            {/* 我的分析：先进入总入口，再从里面点 L7D / 每日分析 */}
            <Route path="my-analysis" element={<MyAnalysis />} />
            {/* L7D 分析 & 每日分析 分开路由 */}
            <Route path="analysis-l7d" element={<Analysis mode="l7d" />} />
            <Route path="analysis-daily" element={<Analysis mode="daily" />} />
            {/* 兼容老链接：/analysis 默认跳到 L7D 分析页 */}
            <Route path="analysis" element={<Navigate to="/analysis-l7d" replace />} />
            <Route path="accounts" element={<AffiliateAccounts />} />
            <Route path="mcc-accounts" element={<MccAccounts />} />
            <Route path="mcc-aggregate" element={<MccDataAggregate />} />
            <Route path="platform-data" element={<PlatformData />} />
            <Route path="google-ads-data" element={<GoogleAdsData />} />
            <Route path="expenses" element={<Expenses />} />
            <Route path="expense-cost-detail" element={<ExpenseCostDetail />} />
            <Route path="rejections" element={<RejectionDetails />} />
            <Route path="stage-label/:label" element={<StageLabelDetail />} />
            <Route path="ad-copy" element={<AdCopyGenerator />} />
            <Route path="my-reports" element={<MyReports />} />
          </Route>
        </Routes>
      </Suspense>
    </Router>
  )
}

export default App

