"""
API配置管理服务
统一管理各平台的API配置，支持默认配置和账号级别覆盖
"""
import json
import logging
from typing import Dict, Optional, Any
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform

logger = logging.getLogger(__name__)


# 平台默认API配置
PLATFORM_DEFAULT_CONFIGS = {
    "rewardoo": {
        "base_url": "https://api.rewardoo.com/api",
        "transaction_details_endpoint": "/transaction_details",
        "commission_details_endpoint": "/commission_details",
        "timeout": 30,
        "max_retries": 3,
        "retry_delay": 2
    },
    "rw": {
        "base_url": "https://api.rewardoo.com/api",
        "transaction_details_endpoint": "/transaction_details",
        "commission_details_endpoint": "/commission_details",
        "timeout": 30,
        "max_retries": 3,
        "retry_delay": 2
    },
    "collabglow": {
        "base_url": "https://api.collabglow.com/api",
        "transaction_endpoint": "/transaction/v3",
        "commission_validation_endpoint": "/commission_validation",
        "commission_details_endpoint": "/commission_details",
        "payment_summary_endpoint": "/payment_summary",
        "timeout": 60,
        "max_retries": 3,
        "retry_delay": 2
    },
    "cg": {
        "base_url": "https://api.collabglow.com/api",
        "transaction_endpoint": "/transaction/v3",
        "commission_validation_endpoint": "/commission_validation",
        "commission_details_endpoint": "/commission_details",
        "payment_summary_endpoint": "/payment_summary",
        "timeout": 60,
        "max_retries": 3,
        "retry_delay": 2
    },
    "linkhaitao": {
        "base_url": "https://www.linkhaitao.com",
        "performance_endpoint": "/api2.php?c=report&a=performance",
        "transaction_detail_endpoint": "/api2.php?c=report&a=transactionDetail",
        "timeout": 30,
        "max_retries": 3,
        "retry_delay": 2
    },
    "lh": {
        "base_url": "https://www.linkhaitao.com",
        "performance_endpoint": "/api2.php?c=report&a=performance",
        "transaction_detail_endpoint": "/api2.php?c=report&a=transactionDetail",
        "timeout": 30,
        "max_retries": 3,
        "retry_delay": 2
    }
}


class ApiConfigService:
    """API配置管理服务"""
    
    @staticmethod
    def get_platform_config(platform_code: str) -> Dict[str, Any]:
        """
        获取平台的默认API配置
        
        Args:
            platform_code: 平台代码（如 'rw', 'rewardoo', 'cg', 'collabglow'）
        
        Returns:
            平台API配置字典
        """
        code_lower = (platform_code or "").lower()
        config = PLATFORM_DEFAULT_CONFIGS.get(code_lower)
        
        if not config:
            logger.warning(f"未找到平台 {platform_code} 的默认配置，返回空配置")
            return {}
        
        return config.copy()
    
    @staticmethod
    def get_account_api_config(account: AffiliateAccount) -> Dict[str, Any]:
        """
        获取账号的API配置（合并默认配置和账号自定义配置）
        
        Args:
            account: 联盟账号对象
        
        Returns:
            合并后的API配置字典
        """
        # 获取平台默认配置
        platform_code = account.platform.platform_code if account.platform else None
        default_config = ApiConfigService.get_platform_config(platform_code)
        
        # 从账号备注中读取自定义配置
        custom_config = {}
        if account.notes:
            try:
                notes_data = json.loads(account.notes)
                
                # 根据平台类型提取相关配置
                platform_code_lower = (platform_code or "").lower()
                
                if platform_code_lower in ["rewardoo", "rw"]:
                    # Rewardoo配置
                    if notes_data.get("rewardoo_api_url") or notes_data.get("rw_api_url") or notes_data.get("api_url"):
                        custom_config["base_url"] = (
                            notes_data.get("rewardoo_api_url") or 
                            notes_data.get("rw_api_url") or 
                            notes_data.get("api_url")
                        )
                
                elif platform_code_lower in ["collabglow", "cg"]:
                    # CollabGlow配置
                    if notes_data.get("collabglow_api_url") or notes_data.get("cg_api_url") or notes_data.get("api_url"):
                        custom_config["base_url"] = (
                            notes_data.get("collabglow_api_url") or 
                            notes_data.get("cg_api_url") or
                            notes_data.get("api_url")
                        )
                
                elif platform_code_lower in ["linkhaitao", "lh"]:
                    # LinkHaitao配置
                    if notes_data.get("linkhaitao_api_url") or notes_data.get("lh_api_url"):
                        custom_config["base_url"] = (
                            notes_data.get("linkhaitao_api_url") or 
                            notes_data.get("lh_api_url")
                        )
                
            except (json.JSONDecodeError, AttributeError) as e:
                logger.warning(f"解析账号 {account.id} 的备注配置失败: {e}")
        
        # 合并配置（自定义配置覆盖默认配置）
        merged_config = {**default_config, **custom_config}
        
        return merged_config
    
    @staticmethod
    def get_api_url(account: AffiliateAccount, endpoint_key: str = "base_url") -> Optional[str]:
        """
        获取账号的API URL
        
        Args:
            account: 联盟账号对象
            endpoint_key: 端点键名（如 'base_url', 'transaction_details_endpoint'）
        
        Returns:
            API URL字符串，如果不存在则返回None
        """
        config = ApiConfigService.get_account_api_config(account)
        return config.get(endpoint_key)
    
    @staticmethod
    def get_full_api_url(account: AffiliateAccount, endpoint_key: str) -> Optional[str]:
        """
        获取完整的API URL（base_url + endpoint）
        
        Args:
            account: 联盟账号对象
            endpoint_key: 端点键名（如 'transaction_details_endpoint'）
        
        Returns:
            完整的API URL，如果不存在则返回None
        """
        config = ApiConfigService.get_account_api_config(account)
        base_url = config.get("base_url", "").rstrip("/")
        endpoint = config.get(endpoint_key, "").lstrip("/")
        
        if not base_url or not endpoint:
            return None
        
        return f"{base_url}/{endpoint}" if endpoint else base_url
    
    @staticmethod
    def format_error_message(error: Exception, account: AffiliateAccount, api_name: str) -> str:
        """
        格式化错误消息，提供友好的配置提示
        
        Args:
            error: 异常对象
            account: 联盟账号对象
            api_name: API名称（如 'TransactionDetails API'）
        
        Returns:
            格式化的错误消息
        """
        error_str = str(error)
        platform_code = account.platform.platform_code if account.platform else "unknown"
        platform_code_lower = (platform_code or "").lower()
        
        # 获取当前使用的API配置
        config = ApiConfigService.get_account_api_config(account)
        current_base_url = config.get("base_url", "未配置")
        
        # 构建友好的错误消息
        if "404" in error_str or "not found" in error_str.lower():
            message = f"[{api_name}] API端点不存在 (404)。\n\n"
            message += f"当前使用的API URL: {current_base_url}\n\n"
            message += "可能的原因：\n"
            message += "1. API URL配置不正确\n"
            message += "2. 该平台有多个渠道，需要使用不同的API地址\n\n"
            message += "解决方法：\n"
            message += "1. 在账号备注中配置正确的API URL（JSON格式）：\n"
            
            if platform_code_lower in ["rewardoo", "rw"]:
                message += '   {"rewardoo_api_url": "https://正确的API地址/api"}\n'
            elif platform_code_lower in ["collabglow", "cg"]:
                message += '   {"collabglow_api_url": "https://正确的API地址/api"}\n'
            elif platform_code_lower in ["linkhaitao", "lh"]:
                message += '   {"linkhaitao_api_url": "https://正确的API地址"}\n'
            
            message += "\n2. 或联系平台技术支持获取正确的API端点\n"
            message += "\n3. 查看文档: 平台API配置文档.md"
            
        elif "timeout" in error_str.lower() or "timed out" in error_str.lower():
            message = f"[{api_name}] 请求超时。\n\n"
            message += f"当前使用的API URL: {current_base_url}\n\n"
            message += "系统已自动重试3次，如果仍然失败，可能的原因：\n"
            message += "1. 网络连接不稳定\n"
            message += "2. API服务器响应慢\n"
            message += "3. 日期范围太大，数据量过多\n\n"
            message += "解决方法：\n"
            message += "1. 检查网络连接\n"
            message += "2. 缩小日期范围，分批同步\n"
            message += "3. 稍后重试\n"
            message += "4. 联系平台技术支持\n"
            
        elif "401" in error_str or "unauthorized" in error_str.lower():
            message = f"[{api_name}] 未授权 (401)。\n\n"
            message += "可能的原因：\n"
            message += "1. API Token无效或已过期\n"
            message += "2. Token没有访问该API的权限\n\n"
            message += "解决方法：\n"
            message += "1. 检查API Token是否正确\n"
            message += "2. 在平台后台重新生成Token\n"
            message += "3. 确认Token有访问该API的权限\n"
            
        else:
            message = f"[{api_name}] 请求失败: {error_str}\n\n"
            message += f"当前使用的API URL: {current_base_url}\n\n"
            message += "请检查：\n"
            message += "1. API配置是否正确\n"
            message += "2. 网络连接是否正常\n"
            message += "3. 查看后端日志获取详细错误信息\n"
            message += "4. 联系平台技术支持\n"
        
        return message

