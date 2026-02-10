import React, { useState } from 'react'
import { RobotOutlined, CloseOutlined, LoadingOutlined } from '@ant-design/icons'
import './style.css'

/**
 * AI生成中的顶部悬浮进度条组件
 * 用于AI报告生成时显示友好的loading状态，不阻塞页面操作
 */
const AiGeneratingOverlay = ({ 
  visible = false, 
  title = 'AI 分析中...', 
  campaignCount = 0,
  onMinimize
}) => {
  const [minimized, setMinimized] = useState(false)

  if (!visible) return null

  const handleMinimize = () => {
    setMinimized(true)
    onMinimize?.()
  }

  // 最小化时显示小图标
  if (minimized) {
    return (
      <div 
        className="ai-progress-minimized"
        onClick={() => setMinimized(false)}
        title="点击展开"
      >
        <RobotOutlined spin />
      </div>
    )
  }

  return (
    <div className="ai-progress-bar">
      <div className="ai-progress-bar__content">
        <div className="ai-progress-bar__left">
          <RobotOutlined className="ai-progress-bar__icon" />
          <span className="ai-progress-bar__title">{title}</span>
          {campaignCount > 0 && (
            <span className="ai-progress-bar__count">
              正在分析 {campaignCount} 个广告系列
            </span>
          )}
        </div>
        <div className="ai-progress-bar__right">
          <div className="ai-progress-bar__track">
            <div className="ai-progress-bar__fill"></div>
          </div>
          <button 
            className="ai-progress-bar__close"
            onClick={handleMinimize}
            title="最小化"
          >
            <CloseOutlined />
          </button>
        </div>
      </div>
    </div>
  )
}

export default AiGeneratingOverlay
