"""
广告系列名匹配服务
从谷歌广告系列名中提取平台名和账号代码
"""
import re
from typing import Optional, Dict, Tuple
from sqlalchemy.orm import Session
from app.models.google_ads_api_data import CampaignPlatformMapping
from app.models.affiliate_account import AffiliatePlatform


class CampaignMatcher:
    """广告系列名匹配器"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def extract_platform_from_campaign_name(
        self, 
        campaign_name: str, 
        user_id: int
    ) -> Optional[Dict[str, str]]:
        """
        从广告系列名中提取平台代码和账号代码
        
        支持的格式示例：
        - "平台名_账号名_其他信息" -> {platform: "平台名", account: "账号名"}
        - "平台名-账号名-其他" -> {platform: "平台名", account: "账号名"}
        - "平台名 账号名" -> {platform: "平台名", account: "账号名"}
        
        Args:
            campaign_name: 广告系列名称
            user_id: 用户ID
        
        Returns:
            {"platform_code": "平台代码", "account_code": "账号代码"} 或 None
        """
        if not campaign_name:
            return None
        
        # 1. 首先检查用户自定义的匹配规则（优先级最高）
        custom_mappings = self.db.query(CampaignPlatformMapping).filter(
            CampaignPlatformMapping.user_id == user_id,
            CampaignPlatformMapping.is_active == True
        ).order_by(CampaignPlatformMapping.priority.desc()).all()
        
        for mapping in custom_mappings:
            try:
                pattern = re.compile(mapping.campaign_name_pattern, re.IGNORECASE)
                if pattern.search(campaign_name):
                    return {
                        "platform_code": mapping.platform_code,
                        "account_code": mapping.account_code
                    }
            except re.error:
                continue
        
        # 2. 尝试从广告系列名中自动提取（常见格式）
        # 格式1: "序号-平台-商家-投放国家-投放时间-MID" (新格式)
        # 例如: "001-RW-bofrost-US-0126-126966" -> 提取 "RW"
        new_format_pattern = r"^\d+[_-]([a-z]{2,})[_-]"  # 序号-平台- 或 序号_平台_
        match = re.match(new_format_pattern, campaign_name, re.IGNORECASE)
        if match:
            platform_code = match.group(1).upper()  # 转换为大写（RW, CG, LH等）
            
            # 验证平台代码是否存在（支持大小写不敏感）
            platform = self.db.query(AffiliatePlatform).filter(
                AffiliatePlatform.platform_code.ilike(platform_code)
            ).first()
            
            if platform:
                # 尝试提取账号代码（MID部分，最后一个字段）
                parts = re.split(r'[_-]', campaign_name)
                account_code = parts[-1] if len(parts) > 1 else None
                return {
                    "platform_code": platform.platform_code,
                    "account_code": account_code
                }
        
        # 格式2: "平台名_账号名_其他" 或 "平台名-账号名-其他" (旧格式)
        patterns = [
            r"^([a-z0-9]+)[_-]([a-z0-9]+)[_-]",  # 平台_账号_ 或 平台-账号-
            r"^([a-z0-9]+)\s+([a-z0-9]+)\s+",    # 平台 账号 
            r"^([a-z0-9]+)[_-]([a-z0-9]+)$",      # 平台_账号 或 平台-账号
        ]
        
        for pattern in patterns:
            match = re.match(pattern, campaign_name.lower())
            if match:
                platform_code = match.group(1)
                account_code = match.group(2)
                
                # 验证平台代码是否存在
                platform = self.db.query(AffiliatePlatform).filter(
                    AffiliatePlatform.platform_code.ilike(platform_code)
                ).first()
                
                if platform:
                    return {
                        "platform_code": platform.platform_code,
                        "account_code": account_code
                    }
        
        # 3. 只提取平台名（如果格式是 "平台名_其他"）
        platform_only_patterns = [
            r"^([a-z0-9]+)[_-]",  # 平台_ 或 平台-
            r"^([a-z0-9]+)\s+",   # 平台 
        ]
        
        for pattern in platform_only_patterns:
            match = re.match(pattern, campaign_name.lower())
            if match:
                platform_code = match.group(1)
                
                # 验证平台代码是否存在
                platform = self.db.query(AffiliatePlatform).filter(
                    AffiliatePlatform.platform_code.ilike(platform_code)
                ).first()
                
                if platform:
                    return {
                        "platform_code": platform.platform_code,
                        "account_code": None
                    }
        
        return None
    
    def find_matching_affiliate_account(
        self,
        platform_code: str,
        account_code: Optional[str],
        user_id: int
    ) -> Optional[int]:
        """
        根据平台代码和账号代码查找对应的联盟账号ID
        
        Args:
            platform_code: 平台代码
            account_code: 账号代码（可选）
            user_id: 用户ID
        
        Returns:
            联盟账号ID 或 None
        """
        from app.models.affiliate_account import AffiliateAccount
        
        query = self.db.query(AffiliateAccount).join(
            AffiliatePlatform
        ).filter(
            AffiliateAccount.user_id == user_id,
            AffiliatePlatform.platform_code == platform_code,
            AffiliateAccount.is_active == True
        )
        
        if account_code:
            query = query.filter(AffiliateAccount.account_code == account_code)
        
        account = query.first()
        
        if account:
            return account.id
        
        # 如果没找到匹配的账号代码，返回该平台下的第一个账号
        if not account_code:
            account = query.first()
            if account:
                return account.id
        
        return None

