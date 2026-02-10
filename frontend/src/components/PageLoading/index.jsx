import React from 'react'
import { Spin } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import './style.css'

/**
 * 页面加载组件
 * @param {string} tip - 加载提示文字
 * @param {boolean} inline - 是否为内嵌模式（用于页面内部loading，而非全屏）
 */
const PageLoading = ({ tip = '加载中...', inline = false }) => {
  const antIcon = <LoadingOutlined style={{ fontSize: inline ? 40 : 56 }} spin />

  return (
    <div className={`page-loading-container ${inline ? 'page-loading-inline' : ''}`}>
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

