import React from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Upload from './pages/Upload'
import Analysis from './pages/Analysis'
import AffiliateAccounts from './pages/AffiliateAccounts'
import AdCampaigns from './pages/AdCampaigns'
import Expenses from './pages/Expenses'
import StageLabelDetail from './pages/StageLabelDetail'
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
          <Route path="analysis" element={<Analysis />} />
          <Route path="accounts" element={<AffiliateAccounts />} />
          <Route path="ad-campaigns" element={<AdCampaigns />} />
          <Route path="expenses" element={<Expenses />} />
          <Route path="stage-label/:label" element={<StageLabelDetail />} />
        </Route>
      </Routes>
    </Router>
  )
}

export default App

