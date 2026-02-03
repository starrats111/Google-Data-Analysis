"""
CreatorFlare (CF) API 服务
根据API文档实现：Transaction API
"""
import requests
from typing import Dict, List, Optional
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

# API 配置
DEFAULT_BASE_URL = "https://api.creatorflare.com"
TRANSACTION_API = f"{DEFAULT_BASE_URL}/api/transaction"


class CreatorFlareService:
    """
    CreatorFlare API 服务类
    
    API文档要点：
    - 端点: POST https://api.creatorflare.com/api/transaction
    - 必需参数: source="creatorflare", token, beginDate, endDate
    - 可选参数: dataScope, status, curPage, perPage (max 2000)
    - 日期范围限制: 不超过62天
    - 响应格式: JSON
    """
    
    def __init__(self, token: str):
        """
        初始化服务
        
        Args:
            token: CreatorFlare API token
        """
        self.token = token
        logger.info(f"[CF Service] 初始化，API={TRANSACTION_API}")
    
    def sync_transactions(
        self,
        begin_date: str,
        end_date: str,
        status: Optional[List[str]] = None
    ) -> Dict:
        """
        同步交易数据（支持自动分页）
        
        Args:
            begin_date: 开始日期 YYYY-MM-DD
            end_date: 结束日期 YYYY-MM-DD
            status: 状态筛选，如 ["All"] 或 ["Pending", "Approved"]
        
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
        if status is None:
            status = ["All"]
        
        all_transactions = []
        page = 1
        per_page = 2000  # 最大每页数量
        max_pages = 1000  # 安全限制
        
        while True:
            result = self._get_transactions_paginated(
                begin_date, end_date, page=page, per_page=per_page, status=status
            )
            
            if not result.get("success"):
                return result
            
            data = result.get("data", {})
            transactions = data.get("list", [])
            all_transactions.extend(transactions)
            
            # 检查是否还有下一页
            has_next = data.get("hasNext", False)
            total_page = data.get("totalPage", 1)
            
            if not has_next or page >= total_page or len(transactions) < per_page:
                break
            
            page += 1
            if page > max_pages:
                logger.warning(f"[CF API] 分页超过最大页数 {max_pages}，停止获取")
                break
        
        logger.info(f"[CF API] 共获取 {len(all_transactions)} 条交易记录")
        
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
        per_page: int = 2000,
        status: Optional[List[str]] = None
    ) -> Dict:
        """
        获取交易数据（单页）
        
        Args:
            begin_date: 开始日期 YYYY-MM-DD
            end_date: 结束日期 YYYY-MM-DD
            page: 页码
            per_page: 每页数量（最大2000）
            status: 状态筛选
        
        Returns:
            {
                "success": bool,
                "data": {
                    "list": List[Dict],
                    "total": int,
                    "curPage": int,
                    "totalPage": int,
                    "hasNext": bool
                },
                "message": str
            }
        """
        if status is None:
            status = ["All"]
        
        payload = {
            "source": "creatorflare",
            "token": self.token,
            "beginDate": begin_date,
            "endDate": end_date,
            "curPage": page,
            "perPage": min(per_page, 2000),  # 最大2000
            "status": status
        }
        
        try:
            logger.info(f"[CF API] 请求交易数据: {begin_date} ~ {end_date}, page={page}, per_page={per_page}")
            response = requests.post(
                TRANSACTION_API,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=30
            )
            response.raise_for_status()
            result = response.json()
            
            # 检查响应状态
            code = result.get("code")
            if code != "0" and code != 0:
                error_msg = result.get("message", "Unknown error")
                
                # 错误码映射（提供更友好的错误消息）
                error_code_map = {
                    "1001": "Invalid token (Token无效，请检查Token是否正确)",
                    1001: "Invalid token (Token无效，请检查Token是否正确)",
                    "1002": "Token已过期",
                    1002: "Token已过期",
                    "1003": "权限不足",
                    1003: "权限不足",
                }
                
                # 如果错误码在映射中，使用映射的消息
                if code in error_code_map:
                    friendly_msg = error_code_map[code]
                    logger.error(f"[CF API] 请求失败: code={code}, message={error_msg}")
                    return {
                        "success": False,
                        "message": f"{friendly_msg}。原始错误: {error_msg} (code={code})",
                        "data": {}
                    }
                
                logger.error(f"[CF API] 请求失败: code={code}, message={error_msg}")
                return {
                    "success": False,
                    "message": f"API返回错误: {error_msg} (code={code})",
                    "data": {}
                }
            
            data = result.get("data", {})
            transactions = data.get("list", [])
            
            logger.info(f"[CF API] 返回 {len(transactions)} 条交易记录 (page {page})")
            
            return {
                "success": True,
                "data": {
                    "list": transactions,
                    "total": data.get("total", 0),
                    "curPage": data.get("curPage", page),
                    "totalPage": data.get("totalPage", 1),
                    "hasNext": data.get("hasNext", False)
                },
                "message": "success"
            }
            
        except requests.exceptions.RequestException as e:
            logger.error(f"[CF API] 请求异常: {e}")
            return {
                "success": False,
                "message": f"请求失败: {str(e)}",
                "data": {}
            }
        except Exception as e:
            logger.error(f"[CF API] 处理异常: {e}")
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
            # 解析订单时间（Unix时间戳）
            order_time = item.get("order_time")
            if isinstance(order_time, (int, float)):
                try:
                    transaction_time = datetime.fromtimestamp(order_time).strftime("%Y-%m-%d %H:%M:%S")
                except:
                    transaction_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
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
                "transaction_id": item.get("order_id") or item.get("creatorflare_id"),
                "transaction_time": transaction_time,
                "order_amount": _safe_float(item.get("sale_amount") or item.get("amount") or 0),
                "commission_amount": commission_amount,
                "status": item.get("status", "Pending"),
                "merchant": item.get("merchant_name") or item.get("mcid"),
                "raw_data": item
            })
        
        return transactions

