"""
PartnerBoost (PB) API 服务
根据API文档实现：Transaction API
"""
import requests
from typing import Dict, List, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

# API 配置
DEFAULT_BASE_URL = "https://app.partnerboost.com"
TRANSACTION_API = f"{DEFAULT_BASE_URL}/api.php?mod=medium&op=transaction"


class PartnerBoostService:
    """
    PartnerBoost API 服务类
    
    API文档要点：
    - 端点: GET/POST https://app.partnerboost.com/api.php?mod=medium&op=transaction
    - 必需参数: token, begin_date, end_date (或 validation_date_begin, validation_date_end)
    - 可选参数: status, page, limit (max 2000)
    - 日期范围限制: 不超过62天
    - 响应格式: JSON (默认) 或 XML
    """
    
    def __init__(self, token: str):
        """
        初始化服务
        
        Args:
            token: PartnerBoost API token
        """
        self.token = token
        logger.info(f"[PB Service] 初始化，API={TRANSACTION_API}")
    
    def sync_transactions(
        self,
        begin_date: str,
        end_date: str,
        status: Optional[str] = "All"
    ) -> Dict:
        """
        同步交易数据（支持自动分页）
        
        Args:
            begin_date: 开始日期 YYYY-MM-DD
            end_date: 结束日期 YYYY-MM-DD
            status: 状态筛选 (All/Pending/Approved/Rejected/Normal)
        
        Returns:
            {
                "success": bool,
                "data": {
                    "transactions": List[Dict],
                    "total": int
                },
                "message": str
            }
        """
        all_transactions = []
        page = 1
        limit = 2000  # 最大每页数量
        max_pages = 1000  # 安全限制
        
        while True:
            result = self._get_transactions_paginated(
                begin_date, end_date, page=page, limit=limit, status=status
            )
            
            if not result.get("success"):
                return result
            
            data = result.get("data", {})
            transactions = data.get("list", [])
            all_transactions.extend(transactions)
            
            # 检查是否还有下一页
            total_page = data.get("total_page", 1)
            
            if page >= total_page or len(transactions) < limit:
                break
            
            page += 1
            if page > max_pages:
                logger.warning(f"[PB API] 分页超过最大页数 {max_pages}，停止获取")
                break
        
        logger.info(f"[PB API] 共获取 {len(all_transactions)} 条交易记录")
        
        return {
            "success": True,
            "data": {
                "transactions": all_transactions,
                "total": len(all_transactions)
            },
            "message": f"成功获取 {len(all_transactions)} 条交易记录"
        }
    
    def _get_transactions_paginated(
        self,
        begin_date: str,
        end_date: str,
        page: int = 1,
        limit: int = 2000,
        status: Optional[str] = "All"
    ) -> Dict:
        """
        获取交易数据（单页，使用GET方法）
        
        Args:
            begin_date: 开始日期 YYYY-MM-DD
            end_date: 结束日期 YYYY-MM-DD
            page: 页码
            limit: 每页数量（最大2000）
            status: 状态筛选
        
        Returns:
            {
                "success": bool,
                "data": {
                    "list": List[Dict],
                    "total_trans": int,
                    "total_page": int
                },
                "message": str
            }
        """
        params = {
            "token": self.token,
            "begin_date": begin_date,
            "end_date": end_date,
            "page": page,
            "limit": min(limit, 2000),  # 最大2000
            "type": "json"  # 使用JSON格式
        }
        
        if status and status != "All":
            params["status"] = status
        
        try:
            logger.info(f"[PB API] 请求交易数据: {begin_date} ~ {end_date}, page={page}, limit={limit}")
            response = requests.get(
                TRANSACTION_API,
                params=params,
                timeout=30
            )
            response.raise_for_status()
            result = response.json()
            
            # 检查响应状态
            status_info = result.get("status", {})
            code = status_info.get("code")
            if code != 0:
                error_msg = status_info.get("msg", "Unknown error")
                logger.error(f"[PB API] 请求失败: code={code}, msg={error_msg}")
                return {
                    "success": False,
                    "message": f"API返回错误: {error_msg} (code={code})",
                    "data": {}
                }
            
            data = result.get("data", {})
            transactions = data.get("list", [])
            
            logger.info(f"[PB API] 返回 {len(transactions)} 条交易记录 (page {page})")
            
            return {
                "success": True,
                "data": {
                    "list": transactions,
                    "total_trans": data.get("total_trans", 0),
                    "total_page": data.get("total_page", 1)
                },
                "message": "success"
            }
            
        except requests.exceptions.RequestException as e:
            logger.error(f"[PB API] 请求异常: {e}")
            return {
                "success": False,
                "message": f"请求失败: {str(e)}",
                "data": {}
            }
        except Exception as e:
            logger.error(f"[PB API] 处理异常: {e}")
            return {
                "success": False,
                "message": f"处理失败: {str(e)}",
                "data": {}
            }
    
    def extract_transaction_data(self, result: Dict) -> List[Dict]:
        """
        提取交易数据并转换为统一格式
        
        Args:
            result: API返回的原始数据
        
        Returns:
            转换后的交易列表
        """
        transactions = []
        data = result.get("data", {})
        transaction_list = data.get("list", [])
        
        for item in transaction_list:
            # 解析订单时间（Unix时间戳或字符串）
            order_time = item.get("order_time")
            if isinstance(order_time, (int, float)):
                try:
                    transaction_time = datetime.fromtimestamp(order_time).strftime("%Y-%m-%d %H:%M:%S")
                except:
                    transaction_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            elif isinstance(order_time, str):
                transaction_time = order_time
            else:
                transaction_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            
            # 解析佣金金额
            def _safe_float(value):
                if value is None:
                    return 0.0
                if isinstance(value, str):
                    value = value.replace("$", "").replace(",", "").strip()
                try:
                    return float(value)
                except (ValueError, TypeError):
                    return 0.0
            
            commission_amount = _safe_float(
                item.get("sale_comm") or item.get("commission_amount") or item.get("commission") or 0
            )
            
            transactions.append({
                "transaction_id": item.get("order_id") or item.get("partnerboost_id"),
                "transaction_time": transaction_time,
                "order_amount": _safe_float(item.get("sale_amount") or item.get("amount") or 0),
                "commission_amount": commission_amount,
                "status": item.get("status", "Pending"),
                "merchant": item.get("merchant_name") or item.get("mcid"),
                "raw_data": item
            })
        
        return transactions

