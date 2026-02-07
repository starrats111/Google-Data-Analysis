"""
平台服务基类
为8个平台提供统一的接口规范
"""
from abc import ABC, abstractmethod
from typing import Dict, List
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class PlatformServiceBase(ABC):
    """
    平台服务基类
    
    所有平台服务必须实现以下方法：
    - get_transactions(): 获取交易数据（主API）
    - get_rejection_details(): 获取拒付详情（辅助API，可选）
    """
    
    def __init__(self, token: str):
        """
        初始化服务
        
        Args:
            token: 平台API token
        """
        self.token = token
    
    @abstractmethod
    def get_transactions(
        self,
        begin_date: str,
        end_date: str
    ) -> Dict:
        """
        获取交易数据（主API）
        
        必须返回统一格式：
        {
            "code": "0",
            "message": "success",
            "data": {
                "transactions": [
                    {
                        "transaction_id": "...",
                        "transaction_time": "...",
                        "merchant": "...",
                        "order_amount": ...,
                        "commission_amount": ...,
                        "status": "...",
                        "reject_reason": "..." (可选)
                    }
                ]
            }
        }
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
        
        Returns:
            API 响应数据
        """
        pass
    
    def get_rejection_details(
        self,
        transaction_id: str = None,
        begin_date: str = None,
        end_date: str = None
    ) -> Dict:
        """
        获取拒付详情（辅助API，可选实现）
        
        Args:
            transaction_id: 交易ID（如果提供，则获取该交易的明细）
            begin_date: 开始日期
            end_date: 结束日期
        
        Returns:
            API 响应数据
        """
        # 默认实现：返回空
        return {
            "code": "0",
            "message": "success",
            "data": {
                "details": []
            }
        }
    
    def extract_transaction_data(self, result: Dict) -> List[Dict]:
        """
        从API响应中提取交易数据，统一字段格式
        
        Args:
            result: API 响应数据
        
        Returns:
            提取的交易数据列表，统一格式
        """
        if not result or result.get("code") != "0":
            return []
        
        transactions = result.get("data", {}).get("transactions", []) or result.get("data", {}).get("list", [])
        
        extracted = []
        for item in transactions:
            # 提取商家ID（MID）：尝试多个可能的字段
            brand_id = item.get("brand_id") or item.get("brandId") or item.get("m_id") or item.get("mcid") or item.get("merchant_id")
            merchant_id = str(brand_id).strip() if brand_id else None
            
            extracted.append({
                "transaction_id": item.get("transaction_id") or item.get("id") or item.get("action_id"),
                "transaction_time": item.get("transaction_time") or item.get("order_date") or item.get("date") or item.get("settlement_date"),
                "merchant": item.get("merchant") or item.get("brand") or item.get("brand_name") or item.get("mcid"),
                "order_amount": float(item.get("order_amount", 0) or item.get("sale_amount", 0) or 0),
                "commission_amount": float(item.get("commission_amount", 0) or item.get("commission", 0) or item.get("sale_comm", 0) or 0),
                "status": item.get("status", "").strip(),
                "reject_reason": item.get("reject_reason") or item.get("rejection_reason") or item.get("reason"),
                "currency": item.get("currency", "USD"),
                "merchant_id": merchant_id  # MID - 用于和广告系列名匹配
            })
        
        return extracted

