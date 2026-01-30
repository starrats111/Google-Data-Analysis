/**
 * 平台API配置
 * 定义每个平台需要的API字段
 */
export const PLATFORM_API_CONFIG = {
  // CollabGlow 平台
  collabglow: {
    fields: [
      {
        name: 'collabglow_token',
        label: 'CollabGlow API Token',
        type: 'password',
        placeholder: '请输入 CollabGlow API Token',
        help: '用于同步 CollabGlow 佣金数据',
        required: false
      }
    ]
  },
  
  // 可以添加更多平台配置
  // 例如：
  // amazon: {
  //   fields: [
  //     {
  //       name: 'amazon_access_key',
  //       label: 'Amazon Access Key',
  //       type: 'text',
  //       placeholder: '请输入 Amazon Access Key',
  //       help: '用于访问 Amazon Associates API',
  //       required: true
  //     },
  //     {
  //       name: 'amazon_secret_key',
  //       label: 'Amazon Secret Key',
  //       type: 'password',
  //       placeholder: '请输入 Amazon Secret Key',
  //       help: '用于访问 Amazon Associates API',
  //       required: true
  //     }
  //   ]
  // },
  
  // 默认配置（如果平台没有特定配置，使用这个）
  default: {
    fields: [
      {
        name: 'api_token',
        label: 'API Token',
        type: 'password',
        placeholder: '请输入 API Token',
        help: '用于访问平台API',
        required: false
      }
    ]
  }
}

/**
 * 根据平台代码获取API配置
 */
export const getPlatformApiConfig = (platformCode) => {
  if (!platformCode) return PLATFORM_API_CONFIG.default
  
  const code = platformCode.toLowerCase()
  return PLATFORM_API_CONFIG[code] || PLATFORM_API_CONFIG.default
}

/**
 * 从账号备注中提取API配置
 */
export const extractApiConfigFromNotes = (notes) => {
  if (!notes) return {}
  
  try {
    return JSON.parse(notes)
  } catch (e) {
    return {}
  }
}

/**
 * 将API配置合并到备注中
 */
export const mergeApiConfigToNotes = (notes, apiConfig) => {
  let notesData = {}
  
  // 解析现有备注
  if (notes) {
    try {
      notesData = JSON.parse(notes)
    } catch (e) {
      // 如果notes不是JSON，保留为other字段
      notesData = { other: notes }
    }
  }
  
  // 合并API配置
  Object.assign(notesData, apiConfig)
  
  return JSON.stringify(notesData)
}

