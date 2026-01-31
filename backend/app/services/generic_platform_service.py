"""
通用平台服务
用于支持尚未有专门服务的平台（LB, PM, BSH, CF等）
支持通过账号备注配置API端点
"""
import requests
import json
import logging
from typing import Dict, List, Optional
from datetime import datetime, timedelta
from app.services.platform_services_base import PlatformServiceBase

logger = logging.getLogger(__name__)


class GenericPlatformService(PlatformServiceBase):
    """
    通用平台服务类
    
    支持通过账号备注配置API端点，适用于：
    - LB
    - PM
    - BSH
    - CF
    以及其他尚未有专门服务的平台
    """
    
    def __init__(self, token: str, platform_code: str, base_url: Optional[str] = None, api_config: Optional[Dict] = None):
        """
        初始化服务
        
        Args:
            token: API Token
            platform_code: 平台代码（如 'lb', 'pm', 'bsh', 'cf'）
            base_url: API基础URL（可选）
            api_config: API配置字典（可选，包含endpoints等）
        """
        super().__init__(token)
        self.platform_code = platform_code.lower()
        self.api_config = api_config or {}
        self.base_url = base_url or self.api_config.get("base_url", "")
        
        # 从配置中获取端点
        self.transaction_endpoint = self.api_config.get("transaction_endpoint", "/transaction") or "/transaction"
        self.transaction_api = f"{self.base_url}{self.transaction_endpoint}" if self.base_url else None
        
        logger.info(f"[{platform_code.upper()} Service] 初始化，base_url={self.base_url}, endpoint={self.transaction_endpoint}")
    
    def get_transactions(
        self,
        begin_date: str,
        end_date: str
    ) -> Dict:
        """
        获取交易数据
        
        尝试多种常见的API格式和端点
        """
        if not self.base_url:
            return {
                "code": "1",
                "message": f"未配置{self.platform_code.upper()}平台的API URL。请在账号备注中配置api_url字段。",
                "data": {"transactions": []}
            }
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}"
        }
        
        # 尝试多种payload格式
        payloads = [
            {
                "token": self.token,
                "begin_date": begin_date,
                "end_date": end_date
            },
            {
                "token": self.token,
                "beginDate": begin_date,
                "endDate": end_date
            },
            {
                "api_token": self.token,
                "start_date": begin_date,
                "end_date": end_date
            },
            {
                "token": self.token,
                "date_from": begin_date,
                "date_to": end_date
            },
        ]
        
        # 尝试多个可能的端点
        endpoints_to_try = [
            self.transaction_endpoint,
            "/transaction",
            "/transactions",
            "/api/transaction",
            "/api/transactions",
            "/v1/transaction",
        ]
        
        for endpoint in endpoints_to_try:
            full_url = f"{self.base_url.rstrip('/')}/{endpoint.lstrip('/')}"
            
            for payload in payloads:
                try:
                    logger.info(f"[{self.platform_code.upper()} API] 尝试: {full_url}")
                    response = requests.post(
                        full_url,
                        headers=headers,
                        json=payload,
                        timeout=60
                    )
                    
                    if response.status_code == 200:
                        try:
                            result = response.json()
                            # 检查响应格式
                            if isinstance(result, dict):
                                # 尝试标准化响应格式
                                if "transactions" in result or "data" in result or "list" in result:
                                    logger.info(f"[{self.platform_code.upper()} API] ✓ 成功获取数据: {full_url}")
                                    return self._normalize_response(result)
                        except:
                            pass
                    
                    elif response.status_code == 401:
                        # 端点存在但token无效
                        logger.info(f"[{self.platform_code.upper()} API] 端点存在但token无效: {full_url}")
                        return {
                            "code": "1",
                            "message": "API Token无效或已过期",
                            "data": {"transactions": []}
                        }
                    
                except requests.exceptions.Timeout:
                    continue
                except requests.exceptions.ConnectionError:
                    continue
                except Exception as e:
                    logger.debug(f"[{self.platform_code.upper()} API] 端点 {full_url} 不可用: {e}")
                    continue
        
        # 所有尝试都失败
        error_msg = f"无法连接到{self.platform_code.upper()} API。请检查：1) API URL是否正确 2) Token是否有效 3) 网络连接是否正常"
        logger.error(f"[{self.platform_code.upper()} API] {error_msg}")
        return {
            "code": "1",
            "message": error_msg,
            "data": {"transactions": []}
        }
    
    def _normalize_response(self, result: Dict) -> Dict:
        """
        标准化API响应格式
        
        Args:
            result: 原始API响应
        
        Returns:
            标准化后的响应格式
        """
        # 尝试提取transactions
        transactions = (
            result.get("data", {}).get("transactions", []) or
            result.get("data", {}).get("list", []) or
            result.get("transactions", []) or
            result.get("list", []) or
            result.get("data", []) or
            []
        )
        
        return {
            "code": "0",
            "message": "success",
            "data": {
                "transactions": transactions if isinstance(transactions, list) else []
            }
        }
    
    def extract_transaction_data(self, result: Dict) -> List[Dict]:
        """
        从API响应中提取交易数据，统一字段格式
        """
        if not result or result.get("code") != "0":
            return []
        
        transactions = result.get("data", {}).get("transactions", []) or result.get("data", {}).get("list", [])
        
        extracted = []
        for item in transactions:
            if not isinstance(item, dict):
                continue
            
            extracted.append({
                "transaction_id": item.get("transaction_id") or item.get("id") or item.get("order_id") or f"{self.platform_code}_{len(extracted)}",
                "transaction_time": item.get("transaction_time") or item.get("order_date") or item.get("date") or item.get("settlement_date"),
                "merchant": item.get("merchant") or item.get("brand") or item.get("brand_name") or item.get("mcid") or "",
                "order_amount": float(item.get("order_amount", 0) or item.get("sale_amount", 0) or item.get("amount", 0) or 0),
                "commission_amount": float(item.get("commission_amount", 0) or item.get("commission", 0) or item.get("sale_comm", 0) or 0),
                "status": str(item.get("status", "") or item.get("transaction_status", "") or "").strip(),
                "reject_reason": item.get("reject_reason") or item.get("rejection_reason") or item.get("reason") or ""
            })
        
        return extracted

