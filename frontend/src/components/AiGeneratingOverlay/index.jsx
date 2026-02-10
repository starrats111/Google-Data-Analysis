import React from 'react'
import { RobotOutlined } from '@ant-design/icons'
import './style.css'

/**
 * AI生成中的全屏遮罩组件
 * 用于AI报告生成时显示友好的loading状态
 */
const AiGeneratingOverlay = ({ 
  visible = false, 
  title = 'AI 分析中...', 
  description = '正在使用 Gemini AI 生成分析报告，请稍候' 
}) => {
  if (!visible) return null

  return (
    <div className="ai-overlay">
      <div className="ai-overlay-content">
        <div className="ai-overlay-icon pulse-animation">
          <RobotOutlined />
        </div>
        <div className="ai-overlay-title">{title}</div>
        <div className="ai-overlay-description">{description}</div>
        <div className="ai-overlay-progress">
          <div className="ai-overlay-progress-bar"></div>
        </div>
        <div className="ai-overlay-tips">
          💡 AI正在分析广告数据，生成优化建议...
        </div>
      </div>
    </div>
  )
}

export default AiGeneratingOverlay

