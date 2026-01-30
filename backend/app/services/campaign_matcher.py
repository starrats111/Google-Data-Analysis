"""
广告系列匹配服务
从谷歌广告系列名中提取平台名并匹配到对应的平台账号
"""
import re
from typing import Optional, List, Dict
from sqlalchemy.orm import Session
from app.models.campaign_match_rule import CampaignMatchRule
from app.models.affiliate_account import AffiliateAccount
from app.models.affiliate_account import AffiliatePlatform


class CampaignMatcher:
    """广告系列匹配器"""
    
    @staticmethod
    def extract_platform_from_campaign_name(campaign_name: str) -> Optional[str]:
        """
        从广告系列名中提取平台名
        
        支持的格式：
        1. 前缀格式：平台名_xxx 或 平台名-xxx
        2. 后缀格式：xxx_平台名 或 xxx-平台名
        3. 括号格式：xxx(平台名) 或 xxx[平台名]
        4. 包含格式：包含平台关键词
        
        Args:
            campaign_name: 广告系列名称
        
        Returns:
            提取的平台名，如果无法提取则返回None
        """
        if not campaign_name:
            return None
        
        # 常见分隔符
        separators = ['_', '-', '|', ' ', '(', ')', '[', ']', '【', '】']
        
        # 尝试从分隔符中提取
        for sep in separators:
            if sep in campaign_name:
                parts = campaign_name.split(sep)
                # 检查第一部分（可能是平台名）
                if parts[0]:
                    potential_platform = parts[0].strip().lower()
                    if len(potential_platform) > 1:  # 至少2个字符
                        return potential_platform
                # 检查最后一部分（可能是平台名）
                if len(parts) > 1 and parts[-1]:
                    potential_platform = parts[-1].strip().lower()
                    if len(potential_platform) > 1:
                        return potential_platform
        
        # 如果无法从分隔符提取，尝试查找常见平台关键词
        platform_keywords = {
            'collabglow': ['collabglow', 'collab'],
            'linkhaitao': ['linkhaitao', 'link-haitao', 'lh'],
            'amazon': ['amazon', 'amz'],
            'ebay': ['ebay'],
            'walmart': ['walmart', 'wm'],
        }
        
        campaign_lower = campaign_name.lower()
        for platform, keywords in platform_keywords.items():
            for keyword in keywords:
                if keyword in campaign_lower:
                    return platform
        
        return None
    
    @staticmethod
    def match_campaign_to_account(
        db: Session,
        user_id: int,
        campaign_name: str,
        platform_name: Optional[str] = None
    ) -> Optional[AffiliateAccount]:
        """
        匹配广告系列到平台账号
        
        Args:
            db: 数据库会话
            user_id: 用户ID
            campaign_name: 广告系列名称
            platform_name: 平台名（如果已知）
        
        Returns:
            匹配的账号，如果无法匹配则返回None
        """
        # 如果没有提供平台名，尝试从广告系列名中提取
        if not platform_name:
            platform_name = CampaignMatcher.extract_platform_from_campaign_name(campaign_name)
        
        if not platform_name:
            return None
        
        # 1. 首先尝试使用匹配规则
        rules = db.query(CampaignMatchRule).filter(
            CampaignMatchRule.user_id == user_id,
            CampaignMatchRule.is_active == True
        ).order_by(CampaignMatchRule.priority.desc()).all()
        
        for rule in rules:
            if CampaignMatcher._match_pattern(campaign_name, rule.pattern, rule.match_type):
                account = db.query(AffiliateAccount).filter(
                    AffiliateAccount.id == rule.affiliate_account_id,
                    AffiliateAccount.user_id == user_id,
                    AffiliateAccount.is_active == True
                ).first()
                if account:
                    return account
        
        # 2. 如果没有匹配规则，尝试通过平台名匹配
        platform = db.query(AffiliatePlatform).filter(
            AffiliatePlatform.platform_code.ilike(f"%{platform_name}%")
        ).first()
        
        if platform:
            # 找到该用户在该平台的第一个激活账号
            account = db.query(AffiliateAccount).filter(
                AffiliateAccount.platform_id == platform.id,
                AffiliateAccount.user_id == user_id,
                AffiliateAccount.is_active == True
            ).first()
            if account:
                return account
        
        return None
    
    @staticmethod
    def _match_pattern(text: str, pattern: str, match_type: str) -> bool:
        """匹配模式"""
        if not text or not pattern:
            return False
        
        text_lower = text.lower()
        pattern_lower = pattern.lower()
        
        if match_type == "contains":
            return pattern_lower in text_lower
        elif match_type == "prefix":
            return text_lower.startswith(pattern_lower)
        elif match_type == "suffix":
            return text_lower.endswith(pattern_lower)
        elif match_type == "regex":
            try:
                return bool(re.search(pattern, text, re.IGNORECASE))
            except:
                return False
        else:
            return False

