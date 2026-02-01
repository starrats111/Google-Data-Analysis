"""
LinkHaitao API 服务
用于获取佣金数据和订单数据并同步到系统
"""
import requests
from typing import Dict, List, Optional
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


class LinkHaitaoService:
    """LinkHaitao API 服务类"""
    
    def __init__(self, token: str):
        """
        初始化服务
        
        Args:
            token: LinkHaitao API token
        """
        self.token = token
        self.base_url = "https://www.linkhaitao.com"
    
    def get_commission_data(
        self, 
        begin_date: str, 
        end_date: str
    ) -> Dict:
        """
        获取佣金数据
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
        
        Returns:
            API 响应数据
        """
        # LinkHaitao 佣金数据 API（根据实际文档调整）
        url = f"{self.base_url}/api2.php?c=report&a=performance"
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}"  # 根据实际认证方式调整
        }
        
        params = {
            "token": self.token,
            "begin_date": begin_date,
            "end_date": end_date,
        }
        
        try:
            response = requests.get(url, headers=headers, params=params, timeout=30)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"LinkHaitao 获取佣金数据失败: {e}")
            raise
    
    def get_order_data(
        self,
        begin_date: str,
        end_date: str,
        page: int = 1,
        per_page: int = 100
    ) -> Dict:
        """
        获取订单数据
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
            page: 页码，默认1
            per_page: 每页数量，默认100
        
        Returns:
            API 响应数据
        """
        # LinkHaitao 订单数据 API（根据实际文档调整）
        url = f"{self.base_url}/api2.php?c=report&a=transactionDetail"
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}"  # 根据实际认证方式调整
        }
        
        params = {
            "token": self.token,
            "begin_date": begin_date,
            "end_date": end_date,
            "page": page,
            "per_page": per_page,
        }
        
        try:
            response = requests.get(url, headers=headers, params=params, timeout=30)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"LinkHaitao 获取订单数据失败: {e}")
            raise
    
    def test_connection(self) -> Dict:
        """
        测试 API 连接
        
        Returns:
            测试结果
        """
        try:
            # 测试获取最近7天的数据
            end_date = datetime.now().strftime("%Y-%m-%d")
            begin_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
            
            # 尝试获取佣金数据
            commission_data = self.get_commission_data(begin_date, end_date)
            
            return {
                "success": True,
                "message": "连接成功",
                "data": commission_data
            }
        except Exception as e:
            return {
                "success": False,
                "message": f"连接失败: {str(e)}"
            }
    
    def sync_commissions_and_orders(
        self,
        begin_date: str,
        end_date: str
    ) -> Dict:
        """
        同步佣金和订单数据
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
        
        Returns:
            同步结果
        """
        try:
            # 获取佣金数据
            logger.info(f"[LinkHaitao API] 请求佣金数据: {begin_date} ~ {end_date}")
            commission_data = self.get_commission_data(begin_date, end_date)
            logger.info(f"[LinkHaitao API] 佣金数据响应类型: {type(commission_data)}, 键: {list(commission_data.keys()) if isinstance(commission_data, dict) else 'N/A'}")
            if isinstance(commission_data, dict):
                payload = commission_data.get("payload")
                logger.info(f"[LinkHaitao API] 佣金payload类型: {type(payload)}, 如果是字典，键: {list(payload.keys()) if isinstance(payload, dict) else 'N/A'}")
                if isinstance(payload, dict):
                    logger.info(f"[LinkHaitao API] 佣金payload内容预览: {str(payload)[:500]}")
            
            # 获取订单数据（可能需要分页）
            logger.info(f"[LinkHaitao API] 请求订单数据: {begin_date} ~ {end_date}")
            all_orders = []
            page = 1
            while True:
                order_data = self.get_order_data(begin_date, end_date, page=page, per_page=100)
                logger.info(f"[LinkHaitao API] 订单数据响应类型: {type(order_data)}, 键: {list(order_data.keys()) if isinstance(order_data, dict) else 'N/A'}")
                if isinstance(order_data, dict):
                    payload = order_data.get("payload")
                    logger.info(f"[LinkHaitao API] 订单payload类型: {type(payload)}, 如果是字典，键: {list(payload.keys()) if isinstance(payload, dict) else 'N/A'}")
                    if isinstance(payload, dict):
                        logger.info(f"[LinkHaitao API] 订单payload内容预览: {str(payload)[:500]}")
                
                # 根据实际 API 响应格式调整
                if isinstance(order_data, dict):
                    # LinkHaitao的payload是列表，不是字典
                    payload = order_data.get("payload", [])
                    if isinstance(payload, list):
                        orders = payload
                    elif isinstance(payload, dict):
                        # 如果payload是字典，尝试从字典中提取列表
                        orders = (
                            payload.get("list", []) or
                            payload.get("transactions", []) or
                            payload.get("orders", []) or
                            payload.get("data", []) or
                            []
                        )
                    else:
                        # 如果payload不是列表也不是字典，尝试其他格式
                        orders = (
                            order_data.get("data", {}).get("list", []) or
                            order_data.get("data", {}).get("transactions", []) or
                            order_data.get("data", {}).get("orders", []) or
                            order_data.get("list", []) or
                            order_data.get("transactions", []) or
                            order_data.get("orders", []) or
                            []
                        )
                    
                    if not orders:
                        logger.info(f"[LinkHaitao API] 第{page}页没有订单数据，停止分页")
                        break
                    
                    logger.info(f"[LinkHaitao API] 第{page}页获取到 {len(orders)} 条订单")
                    all_orders.extend(orders)
                    
                    # 检查是否还有更多页（LinkHaitao的payload是列表，分页信息可能在响应根级别）
                    total_pages = (
                        order_data.get("total_pages") or
                        order_data.get("totalPage") or
                        order_data.get("data", {}).get("total_pages") or
                        order_data.get("data", {}).get("totalPage") or
                        1
                    )
                    if page >= total_pages:
                        logger.info(f"[LinkHaitao API] 已获取所有页，共 {total_pages} 页")
                        break
                else:
                    logger.warning(f"[LinkHaitao API] 订单数据响应不是字典类型: {type(order_data)}")
                    break
                
                page += 1
                if page > 100:  # 防止无限循环
                    logger.warning(f"[LinkHaitao API] 分页超过100页，停止获取")
                    break
            
            # 处理数据（这里可以根据实际需求存储到数据库）
            total_commission = 0
            commission_records = []
            
            # 解析佣金数据（根据实际 API 响应格式调整）
            if isinstance(commission_data, dict):
                # LinkHaitao的payload是列表，不是字典
                payload = commission_data.get("payload", [])
                if isinstance(payload, list):
                    commission_list = payload
                elif isinstance(payload, dict):
                    # 如果payload是字典，尝试从字典中提取列表
                    commission_list = (
                        payload.get("list", []) or
                        payload.get("commissions", []) or
                        payload.get("transactions", []) or
                        payload.get("data", []) or
                        []
                    )
                else:
                    # 如果payload不是列表也不是字典，尝试其他格式
                    commission_list = (
                        commission_data.get("data", {}).get("list", []) or
                        commission_data.get("data", {}).get("commissions", []) or
                        commission_data.get("data", {}).get("transactions", []) or
                        commission_data.get("list", []) or
                        commission_data.get("commissions", []) or
                        commission_data.get("transactions", []) or
                        []
                    )
                
                logger.info(f"[LinkHaitao API] 从响应中提取到 {len(commission_list)} 条佣金记录")
                
                for item in commission_list:
                    if not isinstance(item, dict):
                        logger.warning(f"[LinkHaitao API] 佣金记录不是字典类型: {type(item)}")
                        continue
                    
                    commission = float(item.get("sale_comm", 0) or item.get("commission", 0) or item.get("saleComm", 0) or 0)
                    total_commission += commission
                    commission_records.append({
                        "settlement_date": item.get("settlement_date") or item.get("settlementDate") or item.get("date"),
                        "commission": commission,
                        "brand_id": item.get("brand_id") or item.get("brandId"),
                        "mcid": item.get("mcid") or item.get("mcid"),
                        "transaction_id": item.get("transaction_id") or item.get("transactionId") or item.get("id"),
                        "merchant": item.get("merchant") or item.get("merchant_name") or item.get("merchantName") or item.get("mcid"),
                    })
            
            logger.info(f"[LinkHaitao API] 汇总结果: 佣金记录 {len(commission_records)} 条，订单 {len(all_orders)} 条，总佣金 {total_commission}")
            
            return {
                "success": True,
                "total_commission": total_commission,
                "total_orders": len(all_orders),
                "total_commission_records": len(commission_records),
                "commissions": commission_records[:10],  # 只返回前10条作为预览
                "orders": all_orders[:10],  # 只返回前10条作为预览
                "data": {
                    "commissions": commission_records,
                    "orders": all_orders
                }
            }
        except Exception as e:
            logger.error(f"LinkHaitao 同步数据失败: {e}")
            return {
                "success": False,
                "message": f"同步失败: {str(e)}"
            }


