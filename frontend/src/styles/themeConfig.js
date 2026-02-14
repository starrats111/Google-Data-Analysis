/**
 * Ant Design 5.x 主题配置
 * @description 通过 ConfigProvider theme prop 注入
 * 
 * 注意：本配置仅包含颜色相关属性，不包含圆角、字体等样式变更
 */
const themeConfig = {
  token: {
    // 主色
    colorPrimary: '#4DA6FF',
    colorInfo: '#4DA6FF',
    colorLink: '#4DA6FF',
    colorLinkHover: '#1A7FDB',
    // 注意：不配置 fontFamily、borderRadius 等非颜色属性
  },
  
  components: {
    // 侧边栏菜单
    Menu: {
      darkItemBg: '#0C2D48',
      darkSubMenuItemBg: '#0A2540',
      darkItemSelectedBg: 'rgba(77, 166, 255, 0.2)',
      darkItemSelectedColor: '#fff',
    },
    
    // 按钮 - 仅替换阴影颜色，保持原透明度
    Button: {
      primaryColor: '#fff',
      primaryShadow: '0 2px 0 rgba(77, 166, 255, 0.1)',  // 颜色替换，透明度保持 0.1
    },
    // 注意：不配置 Card 等非颜色属性
  },
}

export default themeConfig

