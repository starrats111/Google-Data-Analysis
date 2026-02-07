import React, { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { DownOutlined } from '@ant-design/icons'
import './ReportViewer.css'

/**
 * AI 分析报告查看器
 * 支持 Markdown 渲染，带有漂亮的排版和样式
 */
const ReportViewer = ({ content, campaignCount, analysisDate }) => {
  if (!content) return null
  
  // 展开状态 - 默认展开第一个卡片
  const [expandedKeys, setExpandedKeys] = useState([0])

  // 预处理内容：将分隔线 ══ 转换为 markdown hr
  const processedContent = useMemo(() => {
    let text = content
    // 将 ══ 分隔线替换为 markdown 分隔线
    text = text.replace(/[═]{3,}/g, '---')
    // 清理连续空行（最多保留2个换行）
    text = text.replace(/\n{4,}/g, '\n\n\n')
    return text
  }, [content])

  // 判断是否为广告系列标题行（而不是普通的子标题）
  // 广告系列名通常是: "### 📊 181-CG1-uaudio-US (成熟期 🏆)" 这种格式
  // 或者: "### 181-CG1-uaudio-US"
  // 子标题通常是: "### 1. 阶段评价：🏆 成熟期" 这种数字开头的格式
  const isCampaignTitle = (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('### ')) return false
    const titleContent = trimmed.replace(/^###\s*/, '').replace(/[📊🔶🔷💎⭐🎯📈📉✅❌⚠️🔴🟡🟢💰☕▲🏆✨]/g, '').trim()
    
    // 子标题特征：以数字+点开头，如 "1. 阶段评价"
    if (/^\d+\.\s/.test(titleContent)) return false
    
    // 广告系列名特征：
    // 1. 包含连字符和数字组合（如 181-CG1-uaudio-US）
    // 2. 或包含平台代码（PM1, CG1, LH1 等）
    // 3. 或包含国家代码（-US, -UK, -DE 等）
    const hasCampaignPattern = /\d+-[A-Z]{2,}\d?-/.test(titleContent) ||  // 181-CG1-
                               /-[A-Z]{2}-\d/.test(titleContent) ||       // -US-123
                               /^[A-Z]{2,}\d?-/.test(titleContent)        // CG1-开头
    
    return hasCampaignPattern
  }

  // 按广告系列分段
  const sections = useMemo(() => {
    const lines = processedContent.split('\n')
    const overview = []
    const campaigns = []
    let currentCampaign = null
    let inOverview = true

    lines.forEach((line) => {
      // 检查是否是广告系列标题
      if (isCampaignTitle(line)) {
        // 保存之前的广告系列
        if (currentCampaign) {
          campaigns.push(currentCampaign)
        }
        // 开始新的广告系列
        currentCampaign = {
          title: line,
          content: []
        }
        inOverview = false
      } else if (currentCampaign) {
        // 在广告系列内部
        currentCampaign.content.push(line)
      } else if (inOverview) {
        // 在概述区域
        overview.push(line)
      }
    })

    // 保存最后一个广告系列
    if (currentCampaign) {
      campaigns.push(currentCampaign)
    }

    return { 
      overview: overview.join('\n').trim(), 
      campaigns: campaigns.map(c => ({
        title: c.title,
        content: c.content.join('\n').trim()
      }))
    }
  }, [processedContent])

  // 从广告系列段落中提取级别标签
  const extractLevel = (text) => {
    const match = text.match(/级别[：:]\s*(S|A|B|C|D)/i) 
      || text.match(/(S级|A级|B级|C级|D级)/i)
      || text.match(/\b(S|D)\s*级/i)
    if (match) {
      const level = match[1].toUpperCase().replace('级', '')
      return level
    }
    return null
  }

  const getLevelStyle = (level) => {
    switch (level) {
      case 'S': return { color: '#52c41a', bg: '#f6ffed', border: '#b7eb8f', label: 'S级 · 优质' }
      case 'A': return { color: '#1890ff', bg: '#e6f7ff', border: '#91d5ff', label: 'A级 · 良好' }
      case 'B': return { color: '#faad14', bg: '#fffbe6', border: '#ffe58f', label: 'B级 · 观察' }
      case 'C': return { color: '#fa8c16', bg: '#fff7e6', border: '#ffd591', label: 'C级 · 注意' }
      case 'D': return { color: '#ff4d4f', bg: '#fff2f0', border: '#ffccc7', label: 'D级 · 暂停' }
      default: return { color: '#8c8c8c', bg: '#fafafa', border: '#d9d9d9', label: '评估中' }
    }
  }

  // 提取广告系列名称
  const extractCampaignName = (titleLine) => {
    return titleLine.replace(/^###\s*/, '').replace(/\*\*/g, '').trim()
  }
  
  // 从内容中提取阶段评价
  const extractPhase = (text) => {
    // 匹配 "阶段评价：🏆 成熟期" 或 "(成熟期 🏆)" 等格式
    const match = text.match(/阶段评价[：:]\s*[🏆📈📉⚠️🎯💎✨]?\s*(成熟期|观察期|试水期|候选期|关停期|成长期)/i) ||
                  text.match(/\((成熟期|观察期|试水期|候选期|关停期|成长期)\s*[🏆📈📉⚠️🎯💎✨]?\)/i) ||
                  text.match(/(成熟期|观察期|试水期|候选期|关停期|成长期)/i)
    return match ? match[1] : null
  }
  
  const getPhaseStyle = (phase) => {
    switch (phase) {
      case '成熟期': return { color: '#52c41a', bg: '#f6ffed', border: '#b7eb8f', icon: '🏆' }
      case '成长期': return { color: '#1890ff', bg: '#e6f7ff', border: '#91d5ff', icon: '📈' }
      case '观察期': return { color: '#faad14', bg: '#fffbe6', border: '#ffe58f', icon: '👀' }
      case '试水期': return { color: '#13c2c2', bg: '#e6fffb', border: '#87e8de', icon: '🌊' }
      case '候选期': return { color: '#722ed1', bg: '#f9f0ff', border: '#d3adf7', icon: '⭐' }
      case '关停期': return { color: '#ff4d4f', bg: '#fff2f0', border: '#ffccc7', icon: '⛔' }
      default: return { color: '#8c8c8c', bg: '#fafafa', border: '#d9d9d9', icon: '📊' }
    }
  }

  // 自定义 Markdown 组件
  const markdownComponents = {
    h1: ({ children }) => <h1 className="report-h1">{children}</h1>,
    h2: ({ children }) => <h2 className="report-h2">{children}</h2>,
    h3: ({ children }) => <h3 className="report-h3">{children}</h3>,
    h4: ({ children }) => <h4 className="report-h4">{children}</h4>,
    p: ({ children }) => <p className="report-p">{children}</p>,
    ul: ({ children }) => <ul className="report-ul">{children}</ul>,
    ol: ({ children }) => <ol className="report-ol">{children}</ol>,
    li: ({ children }) => <li className="report-li">{children}</li>,
    strong: ({ children }) => <strong className="report-strong">{children}</strong>,
    em: ({ children }) => <em className="report-em">{children}</em>,
    hr: () => <hr className="report-hr" />,
    blockquote: ({ children }) => <blockquote className="report-blockquote">{children}</blockquote>,
    code: ({ inline, children, ...props }) => {
      if (inline) {
        return <code className="report-inline-code">{children}</code>
      }
      return <pre className="report-code-block"><code>{children}</code></pre>
    },
    table: ({ children }) => (
      <div className="report-table-wrapper">
        <table className="report-table">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="report-thead">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr className="report-tr">{children}</tr>,
    th: ({ children }) => <th className="report-th">{children}</th>,
    td: ({ children }) => <td className="report-td">{children}</td>,
  }

  return (
    <div className="report-viewer">
      {/* 报告概述区域 */}
      {sections.overview && (
        <div className="report-overview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {sections.overview}
          </ReactMarkdown>
        </div>
      )}

      {/* 广告系列卡片 */}
      {sections.campaigns.length > 0 && (
        <div className="report-campaigns">
          {sections.campaigns.map((campaign, idx) => {
            const level = extractLevel(campaign.content)
            const levelStyle = getLevelStyle(level)
            const phase = extractPhase(campaign.content)
            const phaseStyle = getPhaseStyle(phase)
            const campaignName = extractCampaignName(campaign.title)
            const isExpanded = expandedKeys.includes(idx)

            return (
              <div key={idx} className="report-campaign-card" style={{ borderLeftColor: phase ? phaseStyle.color : levelStyle.color }}>
                {/* 卡片头部 - 可点击展开/收起 */}
                <div 
                  className="report-campaign-header"
                  onClick={() => {
                    setExpandedKeys(prev => 
                      prev.includes(idx) 
                        ? prev.filter(k => k !== idx)
                        : [...prev, idx]
                    )
                  }}
                >
                  <div className="report-campaign-title-row">
                    <span className="report-campaign-index">{idx + 1}</span>
                    <span className="report-campaign-name">{campaignName}</span>
                  </div>
                  <div className="report-campaign-badges">
                    {phase && (
                      <span 
                        className="report-phase-badge"
                        style={{ 
                          background: phaseStyle.bg, 
                          color: phaseStyle.color,
                          borderColor: phaseStyle.border
                        }}
                      >
                        {phaseStyle.icon} {phase}
                      </span>
                    )}
                    {level && (
                      <span 
                        className="report-level-badge"
                        style={{ 
                          background: levelStyle.bg, 
                          color: levelStyle.color,
                          borderColor: levelStyle.border
                        }}
                      >
                        {levelStyle.label}
                      </span>
                    )}
                    <DownOutlined 
                      className="report-expand-icon" 
                      style={{ 
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.25s ease'
                      }} 
                    />
                  </div>
                </div>

                {/* 卡片内容 - 可折叠 */}
                <div 
                  className="report-campaign-body"
                  style={{ 
                    maxHeight: isExpanded ? '2000px' : '0',
                    opacity: isExpanded ? 1 : 0,
                    padding: isExpanded ? '20px 24px' : '0 24px',
                    overflow: 'hidden',
                    transition: 'max-height 0.35s ease, opacity 0.25s ease, padding 0.25s ease'
                  }}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents}
                  >
                    {campaign.content}
                  </ReactMarkdown>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 如果没有找到结构化段落，直接渲染全部内容 */}
      {sections.campaigns.length === 0 && !sections.overview && (
        <div className="report-overview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {processedContent}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

export default ReportViewer

