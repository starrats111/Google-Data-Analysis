import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Login from './pages/Login'
import PageLoading from './components/PageLoading'
import { useAuth } from './store/authStore'

// 懒加载页面组件，减少初始加载时间
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Analysis = lazy(() => import('./pages/Analysis'))
const AffiliateAccounts = lazy(() => import('./pages/AffiliateAccounts'))
const MccAccounts = lazy(() => import('./pages/MccAccounts'))
const MccDataAggregate = lazy(() => import('./pages/MccDataAggregate'))
const PlatformData = lazy(() => import('./pages/PlatformData'))
const GoogleAdsData = lazy(() => import('./pages/GoogleAdsData'))
const DataCenter = lazy(() => import('./pages/DataCenter'))
const Expenses = lazy(() => import('./pages/Expenses'))
const ExpenseCostDetail = lazy(() => import('./pages/ExpenseCostDetail'))
const MyAnalysis = lazy(() => import('./pages/MyAnalysis'))
const StageLabelDetail = lazy(() => import('./pages/StageLabelDetail'))
const GoogleOAuthCallback = lazy(() => import('./pages/GoogleOAuthCallback'))
const RejectionDetails = lazy(() => import('./pages/RejectionDetails'))
const AdCopyGenerator = lazy(() => import('./pages/AdCopyGenerator'))
const MyReports = lazy(() => import('./pages/MyReports'))
const EmployeeList = lazy(() => import('./pages/EmployeeList'))
const EmployeeDetail = lazy(() => import('./pages/EmployeeDetail'))
const BidManagement = lazy(() => import('./pages/BidManagement'))
const FinancialReport = lazy(() => import('./pages/FinancialReport'))
const ReportMonthly = lazy(() => import('./pages/ReportMonthly'))

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
      <Suspense fallback={<PageLoading tip="页面加载中..." />}>
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
            {/* L7D 分析 - 直接进入 */}
            <Route path="analysis-l7d" element={<Analysis />} />
            {/* 兼容老链接 */}
            <Route path="analysis" element={<Navigate to="/analysis-l7d" replace />} />
            <Route path="analysis-daily" element={<Navigate to="/analysis-l7d" replace />} />
            <Route path="my-analysis" element={<Navigate to="/analysis-l7d" replace />} />
            {/* 出价管理 */}
            <Route path="bid-management" element={<BidManagement />} />
            <Route path="accounts" element={<AffiliateAccounts />} />
            <Route path="mcc-accounts" element={<MccAccounts />} />
            <Route path="mcc-aggregate" element={<MccDataAggregate />} />
            <Route path="platform-data" element={<PlatformData />} />
            <Route path="google-ads-data" element={<GoogleAdsData />} />
            <Route path="data-center" element={<DataCenter />} />
            <Route path="employees" element={<EmployeeList />} />
            <Route path="employees/:id" element={<EmployeeDetail />} />
            <Route path="expenses" element={<Expenses />} />
            <Route path="expense-cost-detail" element={<ExpenseCostDetail />} />
            <Route path="rejections" element={<RejectionDetails />} />
            <Route path="stage-label/:label" element={<StageLabelDetail />} />
            <Route path="ad-copy" element={<AdCopyGenerator />} />
            <Route path="my-reports" element={<MyReports />} />
            <Route path="financial-report" element={<FinancialReport />} />
            <Route path="report-monthly" element={<ReportMonthly />} />
          </Route>
        </Routes>
      </Suspense>
    </Router>
  )
}

export default App

