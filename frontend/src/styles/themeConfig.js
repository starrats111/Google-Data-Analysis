/**
 * Ant Design 5.x 主题配置
 * 天际蓝 + 白色侧边栏 + 浅蓝灰背景
 * 
 * 设计原则：
 * - 组件级 token 仅配置 AntD 无法从全局 token 自动派生的值
 * - colorPrimary 会自动派生 Input.activeBorderColor、Pagination.itemActiveBg 等
 * - borderRadius 会自动继承到 Button、Input、Pagination 等
 */
const themeConfig = {
  token: {
    // ============ 品牌色（天际蓝体系） ============
    colorPrimary: '#4DA6FF',
    colorInfo: '#4DA6FF',
    colorLink: '#4DA6FF',
    colorLinkHover: '#1A7FDB',
    
    // ============ 背景色 ============
    colorBgContainer: '#FFFFFF',
    colorBgLayout: '#F0F5FA',
    
    // ============ 边框 ============
    colorBorder: '#E8EAED',
    colorBorderSecondary: '#F0F0F0',
    
    // ============ 圆角 ============
    borderRadius: 8,       // Button、Input、Pagination 等自动继承
    borderRadiusLG: 16,    // Card 等自动继承
    
    // ============ 文字 ============
    colorText: '#202124',
    colorTextSecondary: '#5F6368',
  },
  
  components: {
    // ============ 布局 ============
    Layout: {
      siderBg: '#FFFFFF',
      headerBg: '#FFFFFF',
      bodyBg: '#F0F5FA',
    },
    
    // ============ 菜单（白色侧边栏） ============
    // 注意：这些值无法从 colorPrimary 派生，必须显式配置
    Menu: {
      itemBg: '#FFFFFF',
      subMenuItemBg: '#FFFFFF',
      itemSelectedBg: '#EBF5FF',        // 天际蓝浅底
      itemSelectedColor: '#4DA6FF',      // 天际蓝主色
      itemColor: '#5F6368',
      itemHoverColor: '#202124',
      itemHoverBg: '#F8F9FA',
    },
    
    // ============ 表格 ============
    // 注意：这些值无法从全局 token 派生，必须显式配置
    Table: {
      headerBg: '#FAFBFC',
      headerColor: '#5F6368',
      rowHoverBg: '#F8F9FA',
      borderColor: '#E8EAED',
    },
    
    // ============ 以下组件无需配置（自动从全局 token 派生） ============
    // Card: {}        — borderRadiusLG 自动生效
    // Button: {}      — borderRadius + colorPrimary 自动生效
    // Input: {}       — borderRadius + colorPrimary 自动生效
    // Pagination: {}  — borderRadius + colorPrimary 自动生效
  },
}

export default themeConfig
