"""
Rewardoo (RW) API 服务
按照统一方案实现：TransactionDetails API + CommissionDetails API

核心API：
1. TransactionDetails API - 订单数 + 已确认佣金 + 拒付佣金（核心）
2. CommissionDetails API - 拒付原因分析（辅助）
"""
import requests
from typing import Dict, List, Optional
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)

# API 配置（根据实际API文档调整）
BASE_URL = "https://api.rewardoo.com/api"  # 请根据实际API地址调整
TRANSACTION_DETAILS_API = f"{BASE_URL}/transaction_details"  # 核心API
COMMISSION_DETAILS_API = f"{BASE_URL}/commission_details"  # 辅助API


from app.services.platform_services_base import PlatformServiceBase


class RewardooService(PlatformServiceBase):
    """
    Rewardoo API 服务类
    
    按照统一方案实现：
    - get_transactions(): 核心API，获取订单数 + 已确认佣金 + 拒付佣金（统一接口）
    - get_transaction_details(): 内部方法，调用TransactionDetails API
    - get_commission_details(): 辅助API，获取拒付原因分析
    """
    
    def __init__(self, token: str):
        """
        初始化服务
        
        Args:
            token: Rewardoo API token
        """
        self.token = token
        self.base_url = BASE_URL
    
    def get_transactions(
        self,
        begin_date: str,
        end_date: str
    ) -> Dict:
        """
        【核心API】TransactionDetails API - 获取订单数 + 已确认佣金 + 拒付佣金
        
        统一接口实现，内部调用get_transaction_details
        """
        return self.get_transaction_details(begin_date, end_date)
    
    def get_transaction_details(
        self,
        begin_date: str,
        end_date: str
    ) -> Dict:
        """
        【核心API】TransactionDetails API - 获取订单数 + 已确认佣金 + 拒付佣金
        
        必须用到的字段：
        - transaction_id: 交易ID（用于去重）
        - transaction_time: 交易时间
        - merchant: 商户
        - order_amount: 订单金额
        - commission_amount: 佣金金额
        - status: 状态（关键：approved, rejected, declined）
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
        
        Returns:
            API 响应数据，包含交易列表
        """
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}"  # 根据实际API调整认证方式
        }
        
        payload = {
            "token": self.token,
            "begin_date": begin_date,
            "end_date": end_date
        }
        
        try:
            logger.info(f"[RW TransactionDetails API] 请求交易数据: {begin_date} ~ {end_date}")
            response = requests.post(
                TRANSACTION_DETAILS_API,
                headers=headers,
                json=payload,
                timeout=30
            )
            response.raise_for_status()
            
            result = response.json()
            
            # 确保result是字典类型
            if not isinstance(result, dict):
                error_msg = f"[RW TransactionDetails API] 返回格式错误: 期望字典，但得到 {type(result).__name__}: {result}"
                logger.error(error_msg)
                raise Exception(error_msg)
            
            # 根据实际API响应格式调整
            # 假设响应格式: {"code": 0, "data": {"transactions": [...]}}
            code = result.get("code") or result.get("status_code")
            message = result.get("message", "")
            
            if code == 0 or code == "0" or result.get("success"):
                transactions = result.get("data", {}).get("transactions", []) or result.get("transactions", [])
                logger.info(f"[RW TransactionDetails API] 成功获取 {len(transactions)} 笔交易")
                return {
                    "code": "0",
                    "message": "success",
                    "data": {
                        "transactions": transactions
                    }
                }
            elif code == 1 or (isinstance(code, str) and "no data" in message.lower()):
                logger.info(f"[RW TransactionDetails API] 该日期范围内没有数据: {message}")
                return {
                    "code": "0",
                    "message": "success",
                    "data": {
                        "transactions": []
                    }
                }
            else:
                error_msg = f"[RW TransactionDetails API] 返回错误: {message} (code: {code})"
                logger.error(error_msg)
                raise Exception(error_msg)
                
        except requests.exceptions.RequestException as e:
            error_msg = f"[RW TransactionDetails API] 请求失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"[RW TransactionDetails API] 获取交易数据失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
    
    def get_commission_details(
        self,
        transaction_id: Optional[str] = None,
        begin_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> Dict:
        """
        【辅助API】CommissionDetails API - 获取拒付原因分析
        
        字段重点：
        - transaction_id: 交易ID
        - commission_amount: 佣金金额
        - status: 状态
        - reject_reason: 拒付原因
        
        注意：此API用于拒付原因分析，不是统计。统计请使用TransactionDetails API。
        
        Args:
            transaction_id: 交易ID（如果提供，则获取该交易的明细）
            begin_date: 开始日期（如果提供transaction_id则不需要）
            end_date: 结束日期（如果提供transaction_id则不需要）
        
        Returns:
            API 响应数据，包含佣金明细
        """
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}"
        }
        
        payload = {
            "token": self.token
        }
        
        if transaction_id:
            payload["transaction_id"] = transaction_id
        else:
            if not begin_date or not end_date:
                raise ValueError("必须提供 transaction_id 或 begin_date 和 end_date")
            payload["begin_date"] = begin_date
            payload["end_date"] = end_date
        
        try:
            logger.info(f"[RW CommissionDetails API] 请求佣金明细: transaction_id={transaction_id}, date_range={begin_date}~{end_date}")
            response = requests.post(
                COMMISSION_DETAILS_API,
                headers=headers,
                json=payload,
                timeout=30
            )
            response.raise_for_status()
            
            result = response.json()
            code = result.get("code") or result.get("status_code")
            message = result.get("message", "")
            
            if code == 0 or code == "0" or result.get("success"):
                details = result.get("data", {}).get("details", []) or result.get("details", [])
                logger.info(f"[RW CommissionDetails API] 成功获取 {len(details)} 条佣金明细")
                return {
                    "code": "0",
                    "message": "success",
                    "data": {
                        "details": details
                    }
                }
            else:
                error_msg = f"[RW CommissionDetails API] 返回错误: {message} (code: {code})"
                logger.error(error_msg)
                raise Exception(error_msg)
                
        except requests.exceptions.RequestException as e:
            error_msg = f"[RW CommissionDetails API] 请求失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"[RW CommissionDetails API] 获取佣金明细失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
    
    def sync_transactions(
        self,
        begin_date: str,
        end_date: str,
        max_days: int = 62
    ) -> Dict:
        """
        同步交易数据（自动处理超过62天的情况）
        
        使用TransactionDetails API，这是核心API，每天只需要拉这一个接口。
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            max_days: 单次查询最大天数（API限制62天）
        
        Returns:
            同步结果，包含交易列表
        """
        begin = datetime.strptime(begin_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
        
        if (end - begin).days > max_days:
            # 如果超过最大天数，分段查询
            logger.info(f"[RW TransactionDetails API] 日期跨度超过{max_days}天，将分段查询")
            all_transactions = []
            current_begin = begin
            
            while current_begin <= end:
                current_end = min(
                    current_begin + timedelta(days=max_days - 1),
                    end
                )
                
                result = self.get_transaction_details(
                    current_begin.strftime("%Y-%m-%d"),
                    current_end.strftime("%Y-%m-%d")
                )
                
                transactions = result.get("data", {}).get("transactions", [])
                all_transactions.extend(transactions)
                
                current_begin = current_end + timedelta(days=1)
            
            return {
                "code": "0",
                "message": "success",
                "data": {
                    "transactions": all_transactions
                }
            }
        else:
            # 单次查询
            return self.get_transaction_details(begin_date, end_date)
    
    def extract_transaction_data(self, result: Dict) -> List[Dict]:
        """
        从API响应中提取交易数据，统一字段格式
        
        Args:
            result: API 响应数据
        
        Returns:
            提取的交易数据列表，统一格式：
            {
                "transaction_id": "...",
                "transaction_time": "...",
                "merchant": "...",
                "order_amount": ...,
                "commission_amount": ...,
                "status": "..."
            }
        """
        if not result or result.get("code") != "0":
            return []
        
        transactions = result.get("data", {}).get("transactions", [])
        
        extracted = []
        for item in transactions:
            extracted.append({
                "transaction_id": item.get("transaction_id") or item.get("id"),
                "transaction_time": item.get("transaction_time") or item.get("order_date") or item.get("date"),
                "merchant": item.get("merchant") or item.get("brand") or item.get("brand_name"),
                "order_amount": float(item.get("order_amount", 0) or item.get("sale_amount", 0) or 0),
                "commission_amount": float(item.get("commission_amount", 0) or item.get("commission", 0) or 0),
                "status": item.get("status", "").strip()
            })
        
        return extracted

