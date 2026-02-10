import React from 'react'
import { Spin } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import './style.css'

const PageLoading = ({ tip = '加载中...' }) => {
  const antIcon = <LoadingOutlined style={{ fontSize: 48 }} spin />

  return (
    <div className="page-loading-container">
      <div className="page-loading-content">
        <div className="page-loading-spinner">
          <Spin indicator={antIcon} />
        </div>
        <div className="page-loading-text">{tip}</div>
        <div className="page-loading-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  )
}

export default PageLoading

