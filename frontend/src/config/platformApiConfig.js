/**
 * 平台API配置
 * 定义每个平台需要的API字段
 */
export const PLATFORM_API_CONFIG = {
  // ========== CG (CollabGlow) ==========
  cg: {
    fields: [
      {
        name: 'collabglow_token',
        label: 'CollabGlow API Token',
        type: 'password',
        placeholder: '请输入 CollabGlow API Token',
        help: '用于同步 CollabGlow 佣金数据',
        required: false
      },
      {
        name: 'collabglow_api_url',
        label: 'CollabGlow API URL（可选，用于不同渠道）',
        type: 'text',
        placeholder: '例如: https://api.collabglow.com/api',
        help: '如果CollabGlow有多个渠道，每个渠道可能有不同的API地址。留空则使用默认地址。',
        required: false
      }
    ]
  },
  // CollabGlow 平台（别名，兼容旧格式）
  collabglow: {
    fields: [
      {
        name: 'collabglow_token',
        label: 'CollabGlow API Token',
        type: 'password',
        placeholder: '请输入 CollabGlow API Token',
        help: '用于同步 CollabGlow 佣金数据',
        required: false
      },
      {
        name: 'collabglow_api_url',
        label: 'CollabGlow API URL（可选，用于不同渠道）',
        type: 'text',
        placeholder: '例如: https://api.collabglow.com/api',
        help: '如果CollabGlow有多个渠道，每个渠道可能有不同的API地址。留空则使用默认地址。',
        required: false
      }
    ]
  },
  
  // ========== LH (LinkHaitao) ==========
  lh: {
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
  // LinkHaitao 平台（别名，兼容旧格式）
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
  
  // ========== RW (Rewardoo) ==========
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
  
  // ========== LB (Linkbux) ==========
  lb: {
    fields: [
      {
        name: 'lb_token',
        label: 'Linkbux API Token',
        type: 'password',
        placeholder: '请输入 Linkbux API Token',
        help: '用于同步 Linkbux 交易数据',
        required: false
      },
      {
        name: 'lb_api_url',
        label: 'Linkbux API URL（必填）',
        type: 'text',
        placeholder: '例如: https://www.linkbux.com/api',
        help: 'Linkbux平台的API基础URL，必须配置',
        required: true
      }
    ]
  },
  
  // ========== PB (PartnerBoost) ==========
  pb: {
    fields: [
      {
        name: 'pb_token',
        label: 'PartnerBoost API Token',
        type: 'password',
        placeholder: '请输入 PartnerBoost API Token',
        help: '用于同步 PartnerBoost 交易数据',
        required: false
      },
      {
        name: 'pb_api_url',
        label: 'PartnerBoost API URL（必填）',
        type: 'text',
        placeholder: '例如: https://app.partnerboost.com/api',
        help: 'PartnerBoost平台的API基础URL，必须配置',
        required: true
      }
    ]
  },
  
  // ========== PM (Partnermatic) ==========
  pm: {
    fields: [
      {
        name: 'pm_token',
        label: 'Partnermatic API Token',
        type: 'password',
        placeholder: '请输入 Partnermatic API Token',
        help: '用于同步 Partnermatic 交易数据',
        required: false
      },
      {
        name: 'pm_api_url',
        label: 'Partnermatic API URL（必填）',
        type: 'text',
        placeholder: '例如: https://app.partnermatic.com/api',
        help: 'Partnermatic平台的API基础URL，必须配置',
        required: true
      }
    ]
  },
  
  // ========== BSH (BrandSparkHub) ==========
  bsh: {
    fields: [
      {
        name: 'bsh_token',
        label: 'BrandSparkHub API Token',
        type: 'password',
        placeholder: '请输入 BrandSparkHub API Token',
        help: '用于同步 BrandSparkHub 交易数据',
        required: false
      },
      {
        name: 'bsh_api_url',
        label: 'BrandSparkHub API URL（必填）',
        type: 'text',
        placeholder: '例如: https://www.brandsparkhub.com/api',
        help: 'BrandSparkHub平台的API基础URL，必须配置',
        required: true
      }
    ]
  },
  
  // ========== CF (CreatorFlare) ==========
  cf: {
    fields: [
      {
        name: 'cf_token',
        label: 'CreatorFlare API Token',
        type: 'password',
        placeholder: '请输入 CreatorFlare API Token',
        help: '用于同步 CreatorFlare 交易数据',
        required: false
      },
      {
        name: 'cf_api_url',
        label: 'CreatorFlare API URL（必填）',
        type: 'text',
        placeholder: '例如: https://www.creatorflare.com/api',
        help: 'CreatorFlare平台的API基础URL，必须配置',
        required: true
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
  
  const code = platformCode.toLowerCase().trim()
  
  // 直接匹配
  if (PLATFORM_API_CONFIG[code]) {
    return PLATFORM_API_CONFIG[code]
  }
  
  // 别名匹配（支持多种格式：小写缩写和全称）
  const aliasMap = {
    // CG
    'cg': 'cg',
    'collabglow': 'cg',
    // RW
    'rw': 'rw',
    'rewardoo': 'rw',
    // LH
    'lh': 'lh',
    'linkhaitao': 'lh',
    'link-haitao': 'lh',
    // LB
    'lb': 'lb',
    'linkbux': 'lb',
    // PB
    'pb': 'pb',
    'partnerboost': 'pb',
    // PM
    'pm': 'pm',
    'partnermatic': 'pm',
    // BSH
    'bsh': 'bsh',
    'brandsparkhub': 'bsh',
    // CF
    'cf': 'cf',
    'creatorflare': 'cf'
  }
  
  if (aliasMap[code]) {
    return PLATFORM_API_CONFIG[aliasMap[code]] || PLATFORM_API_CONFIG.default
  }
  
  return PLATFORM_API_CONFIG.default
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

