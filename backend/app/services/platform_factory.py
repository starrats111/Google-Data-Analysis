"""
平台服务工厂
根据平台代码创建对应的服务实例
"""
from typing import Optional
from app.services.collabglow_service import CollabGlowService
from app.services.rewardoo_service import RewardooService
from app.services.linkhaitao_service import LinkHaitaoService
from app.services.platform_services_base import PlatformServiceBase
import logging

logger = logging.getLogger(__name__)


class PlatformServiceFactory:
    """
    平台服务工厂
    
    支持8个平台：
    - CG (CollabGlow)
    - RW (Rewardoo)
    - Linkhaitao
    - PartnerBoost
    - Linkbux
    - Partnermatic
    - BrandSparkHub
    - CreatorFlare
    """
    
    @staticmethod
    def create_service(platform_code: str, token: str) -> Optional[PlatformServiceBase]:
        """
        创建平台服务实例
        
        Args:
            platform_code: 平台代码
            token: API token
        
        Returns:
            平台服务实例，如果不支持则返回None
        """
        platform_code_lower = platform_code.lower().strip()
        
        # CG (CollabGlow)
        if platform_code_lower in ["cg", "collabglow", "collab-glow"]:
            return CollabGlowService(token=token)
        
        # RW (Rewardoo)
        elif platform_code_lower in ["rw", "rewardoo", "reward-oo"]:
            return RewardooService(token=token)
        
        # Linkhaitao
        elif platform_code_lower in ["lh", "linkhaitao", "link-haitao"]:
            # 使用LinkHaitaoService，但需要适配统一接口
            from app.services.linkhaitao_service import LinkHaitaoService
            return LinkHaitaoService(token=token)
        
        # PartnerBoost
        elif platform_code_lower in ["pb", "partnerboost", "partner-boost"]:
            # TODO: 实现PartnerBoostService
            logger.warning(f"平台 {platform_code} 的服务尚未实现")
            return None
        
        # Linkbux
        elif platform_code_lower in ["lb", "linkbux", "link-bux"]:
            # TODO: 实现LinkbuxService
            logger.warning(f"平台 {platform_code} 的服务尚未实现")
            return None
        
        # Partnermatic
        elif platform_code_lower in ["pm", "partnermatic", "partner-matic"]:
            # TODO: 实现PartnermaticService
            logger.warning(f"平台 {platform_code} 的服务尚未实现")
            return None
        
        # BrandSparkHub
        elif platform_code_lower in ["bsh", "brandsparkhub", "brand-spark-hub"]:
            # TODO: 实现BrandSparkHubService
            logger.warning(f"平台 {platform_code} 的服务尚未实现")
            return None
        
        # CreatorFlare
        elif platform_code_lower in ["cf", "creatorflare", "creator-flare"]:
            # TODO: 实现CreatorFlareService
            logger.warning(f"平台 {platform_code} 的服务尚未实现")
            return None
        
        else:
            logger.warning(f"不支持的平台代码: {platform_code}")
            return None

