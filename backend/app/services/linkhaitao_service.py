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
            commission_data = self.get_commission_data(begin_date, end_date)
            
            # 获取订单数据（可能需要分页）
            all_orders = []
            page = 1
            while True:
                order_data = self.get_order_data(begin_date, end_date, page=page, per_page=100)
                
                # 根据实际 API 响应格式调整
                if isinstance(order_data, dict):
                    orders = order_data.get("data", {}).get("list", [])
                    if not orders:
                        break
                    all_orders.extend(orders)
                    
                    # 检查是否还有更多页
                    total_pages = order_data.get("data", {}).get("total_pages", 1)
                    if page >= total_pages:
                        break
                else:
                    break
                
                page += 1
            
            # 处理数据（这里可以根据实际需求存储到数据库）
            total_commission = 0
            commission_records = []
            
            # 解析佣金数据（根据实际 API 响应格式调整）
            if isinstance(commission_data, dict):
                commission_list = commission_data.get("data", {}).get("list", [])
                for item in commission_list:
                    commission = float(item.get("sale_comm", 0) or 0)
                    total_commission += commission
                    commission_records.append({
                        "settlement_date": item.get("settlement_date"),
                        "commission": commission,
                        "brand_id": item.get("brand_id"),
                        "mcid": item.get("mcid"),
                    })
            
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


