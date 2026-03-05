import React, { Suspense, useEffect, useState } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Login from './pages/Login'
import PageLoading from './components/PageLoading'
import ErrorBoundary from './components/ErrorBoundary'
import { lazyWithRetry } from './utils/lazyWithRetry'
import { useAuth } from './store/authStore'

// 懒加载页面组件（带重试机制），减少初始加载时间
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'))
const Analysis = lazyWithRetry(() => import('./pages/Analysis'))
const AffiliateAccounts = lazyWithRetry(() => import('./pages/AffiliateAccounts'))
const MccAccounts = lazyWithRetry(() => import('./pages/MccAccounts'))
const MccDataAggregate = lazyWithRetry(() => import('./pages/MccDataAggregate'))
const PlatformData = lazyWithRetry(() => import('./pages/PlatformData'))
const GoogleAdsData = lazyWithRetry(() => import('./pages/GoogleAdsData'))
const DataCenter = lazyWithRetry(() => import('./pages/DataCenter'))
const ExpenseCostDetail = lazyWithRetry(() => import('./pages/ExpenseCostDetail'))
const MyAnalysis = lazyWithRetry(() => import('./pages/MyAnalysis'))
const StageLabelDetail = lazyWithRetry(() => import('./pages/StageLabelDetail'))
const RejectionDetails = lazyWithRetry(() => import('./pages/RejectionDetails'))
const AdCopyGenerator = lazyWithRetry(() => import('./pages/AdCopyGenerator'))
const MyReports = lazyWithRetry(() => import('./pages/MyReports'))
const EmployeeList = lazyWithRetry(() => import('./pages/EmployeeList'))
const EmployeeDetail = lazyWithRetry(() => import('./pages/EmployeeDetail'))
const BidManagement = lazyWithRetry(() => import('./pages/BidManagement'))
const FinancialReport = lazyWithRetry(() => import('./pages/FinancialReport'))
const ReportMonthly = lazyWithRetry(() => import('./pages/ReportMonthly'))
const ReportQuarterly = lazyWithRetry(() => import('./pages/ReportQuarterly'))
const ReportYearly = lazyWithRetry(() => import('./pages/ReportYearly'))
const SystemLogs = lazyWithRetry(() => import('./pages/SystemLogs'))
const TeamManagement = lazyWithRetry(() => import('./pages/TeamManagement'))
const TeamOverview = lazyWithRetry(() => import('./pages/TeamOverview'))

// 商家管理
const MerchantManagement = lazyWithRetry(() => import('./pages/MerchantManagement'))
const MerchantPerformance = lazyWithRetry(() => import('./pages/MerchantPerformance'))

// 反馈管理（wj07）
const FeedbackManage = lazyWithRetry(() => import('./pages/FeedbackManage'))

// 文章发布系统（OPT-011）
const ArticleList = lazyWithRetry(() => import('./pages/articles/ArticleList'))
const ArticleEdit = lazyWithRetry(() => import('./pages/articles/ArticleEdit'))
const ArticleCategories = lazyWithRetry(() => import('./pages/articles/ArticleCategories'))
const ArticleTitles = lazyWithRetry(() => import('./pages/articles/ArticleTitles'))
const PublishWizard = lazyWithRetry(() => import('./components/PublishWizard'))


function PrivateRoute({ children }) {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? children : <Navigate to="/login" />
}

function App() {
  const [ready, setReady] = useState(false)
  const initAuth = useAuth(s => s.initAuth)

  useEffect(() => {
    initAuth().finally(() => setReady(true))
  }, [initAuth])

  if (!ready) {
    return <PageLoading tip="正在恢复登录状态..." />
  }

  return (
    <ErrorBoundary>
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <Suspense fallback={<PageLoading tip="页面加载中..." />}>
          <Routes>
            <Route path="/login" element={<Login />} />
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
              <Route path="expense-cost-detail" element={<ExpenseCostDetail />} />
              <Route path="rejections" element={<RejectionDetails />} />
              <Route path="stage-label/:label" element={<StageLabelDetail />} />
              <Route path="ad-copy" element={<AdCopyGenerator />} />
              <Route path="my-reports" element={<MyReports />} />
              <Route path="financial-report" element={<FinancialReport />} />
              <Route path="report-monthly" element={<ReportMonthly />} />
              <Route path="report-quarterly" element={<ReportQuarterly />} />
              <Route path="report-yearly" element={<ReportYearly />} />
              <Route path="system-logs" element={<SystemLogs />} />
              <Route path="team-management" element={<TeamManagement />} />
              <Route path="team-overview" element={<TeamOverview />} />
              {/* 商家任务分配 */}
              <Route path="merchant-management" element={<MerchantManagement />} />
              <Route path="merchant-performance" element={<MerchantPerformance />} />
              {/* 反馈管理 */}
              <Route path="feedback-manage" element={<FeedbackManage />} />
              {/* 文章发布系统（OPT-011） */}
              <Route path="articles" element={<ArticleList />} />
              <Route path="articles/edit/:id" element={<ArticleEdit />} />
              <Route path="articles/new" element={<ArticleEdit />} />
              <Route path="articles/publish" element={<PublishWizard />} />
              <Route path="articles/categories" element={<ArticleCategories />} />
              <Route path="articles/titles" element={<ArticleTitles />} />
            </Route>
          </Routes>
        </Suspense>
      </Router>
    </ErrorBoundary>
  )
}

export default App
