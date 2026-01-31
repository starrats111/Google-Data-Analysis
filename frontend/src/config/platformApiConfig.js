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
  
  // LinkHaitao 平台
  linkhaitao: {
    fields: [
      {
        name: 'linkhaitao_token',
        label: 'LinkHaitao API Token',
        type: 'password',
        placeholder: '请输入 LinkHaitao API Token',
        help: '用于同步 LinkHaitao 佣金和订单数据',
        required: false
      }
    ]
  },
  
  // Link-Haitao 平台（别名）
  'link-haitao': {
    fields: [
      {
        name: 'linkhaitao_token',
        label: 'LinkHaitao API Token',
        type: 'password',
        placeholder: '请输入 LinkHaitao API Token',
        help: '用于同步 LinkHaitao 佣金和订单数据',
        required: false
      }
    ]
  },
  
  // Rewardoo 平台
  rewardoo: {
    fields: [
      {
        name: 'rewardoo_token',
        label: 'Rewardoo API Token',
        type: 'password',
        placeholder: '请输入 Rewardoo API Token',
        help: '用于同步 Rewardoo 交易数据（TransactionDetails API）',
        required: false
      },
      {
        name: 'rewardoo_api_url',
        label: 'Rewardoo API URL（可选，用于不同渠道）',
        type: 'text',
        placeholder: '例如: https://api.rewardoo.com/api 或 https://api-channel1.rewardoo.com/api',
        help: '如果Rewardoo有多个渠道，每个渠道可能有不同的API地址。留空则使用默认地址。',
        required: false
      }
    ]
  },
  
  // RW 平台（Rewardoo的别名）
  rw: {
    fields: [
      {
        name: 'rewardoo_token',
        label: 'Rewardoo API Token',
        type: 'password',
        placeholder: '请输入 Rewardoo API Token',
        help: '用于同步 Rewardoo 交易数据（TransactionDetails API）',
        required: false
      },
      {
        name: 'rewardoo_api_url',
        label: 'Rewardoo API URL（可选，用于不同渠道）',
        type: 'text',
        placeholder: '例如: https://api.rewardoo.com/api 或 https://api-channel1.rewardoo.com/api',
        help: '如果Rewardoo有多个渠道，每个渠道可能有不同的API地址。留空则使用默认地址。',
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

