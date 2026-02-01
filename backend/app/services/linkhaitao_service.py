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
        # LinkHaitao Order Report API
        self.order_report_api = f"{self.base_url}/api.php?mod=medium&op=cashback2"
    
    def get_order_report_data(
        self, 
        begin_date: str, 
        end_date: str,
        page: int = 1,
        per_page: int = 40000
    ) -> Dict:
        """
        获取订单报告数据（包含佣金和订单信息）
        
        根据LinkHaitao API文档：https://www.linkhaitao.com/api.php?mod=medium&op=cashback2
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
            page: 页码，默认1
            per_page: 每页数量，默认40000（最大）
        
        Returns:
            API 响应数据
        """
        params = {
            "token": self.token,
            "begin_date": begin_date,
            "end_date": end_date,
            "page": page,
            "per_page": per_page,
            "status": "all"  # 获取所有状态的订单
        }
        
        try:
            logger.info(f"[LinkHaitao API] 请求订单报告: {begin_date} ~ {end_date}, page={page}, per_page={per_page}")
            response = requests.get(self.order_report_api, params=params, timeout=30)
            response.raise_for_status()
            result = response.json()
            
            # 检查响应状态
            status = result.get("status", {})
            code = status.get("code")
            msg = status.get("msg", "")
            
            if code != 0:
                error_msg = f"LinkHaitao API返回错误: code={code}, msg={msg}"
                logger.error(error_msg)
                raise Exception(error_msg)
            
            logger.info(f"[LinkHaitao API] 订单报告响应: code={code}, msg={msg}, data数量={len(result.get('data', []))}")
            return result
        except requests.exceptions.RequestException as e:
            logger.error(f"LinkHaitao 获取订单报告失败: {e}")
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
        
        根据LinkHaitao API文档，使用Order Report API获取订单和佣金数据
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
        
        Returns:
            同步结果
        """
        try:
            # 使用Order Report API获取订单和佣金数据
            all_orders = []
            page = 1
            per_page = 40000  # 最大每页数量
            
            while True:
                order_report = self.get_order_report_data(begin_date, end_date, page=page, per_page=per_page)
                
                # 根据API文档，响应格式: {"status": {"code": 0, "msg": "success"}, "data": [...]}
                orders = order_report.get("data", [])
                
                if not orders:
                    logger.info(f"[LinkHaitao API] 第{page}页没有订单数据，停止分页")
                    break
                
                logger.info(f"[LinkHaitao API] 第{page}页获取到 {len(orders)} 条订单")
                all_orders.extend(orders)
                
                # 检查是否还有更多页（根据offset和per_page判断）
                offset = order_report.get("offset", 0)
                per_page_actual = order_report.get("per_page", per_page)
                
                # 如果返回的数据少于per_page，说明已经是最后一页
                if len(orders) < per_page_actual:
                    logger.info(f"[LinkHaitao API] 已获取所有页，当前页数据量 {len(orders)} < {per_page_actual}")
                    break
                
                page += 1
                if page > 100:  # 防止无限循环
                    logger.warning(f"[LinkHaitao API] 分页超过100页，停止获取")
                    break
            
            # 处理订单数据，转换为佣金和订单格式
            total_commission = 0
            commission_records = []
            order_records = []
            
            for item in all_orders:
                if not isinstance(item, dict):
                    logger.warning(f"[LinkHaitao API] 订单记录不是字典类型: {type(item)}")
                    continue
                
                # 根据API文档字段映射
                # API返回字段: order_id, order_time, sale_amount, cashback, status, mcid, advertiser_name
                # 转换为统一格式
                cashback = float(item.get("cashback", 0) or 0)
                sale_amount = float(item.get("sale_amount", 0) or 0)
                order_time = item.get("order_time") or item.get("report_time")
                
                # 转换时间戳为日期字符串
                if order_time:
                    try:
                        if isinstance(order_time, str) and order_time.isdigit():
                            order_time = int(order_time)
                        if isinstance(order_time, int):
                            from datetime import datetime
                            order_date = datetime.fromtimestamp(order_time).strftime("%Y-%m-%d")
                        else:
                            order_date = str(order_time)[:10]  # 取前10个字符作为日期
                    except:
                        order_date = None
                else:
                    order_date = None
                
                total_commission += cashback
                
                # 佣金记录
                commission_records.append({
                    "settlement_date": order_date,
                    "commission": cashback,
                    "mcid": item.get("mcid") or item.get("m_id"),
                    "transaction_id": item.get("order_id") or item.get("sign_id"),
                    "merchant": item.get("advertiser_name") or item.get("mcid"),
                })
                
                # 订单记录
                order_records.append({
                    "order_id": item.get("order_id"),
                    "date": order_date,
                    "amount": sale_amount,
                    "commission": cashback,
                    "status": item.get("status", "untreated"),
                    "merchant": item.get("advertiser_name") or item.get("mcid"),
                })
            
            logger.info(f"[LinkHaitao API] 汇总结果: 佣金记录 {len(commission_records)} 条，订单 {len(order_records)} 条，总佣金 {total_commission}")
            
            return {
                "success": True,
                "total_commission": total_commission,
                "total_orders": len(order_records),
                "total_commission_records": len(commission_records),
                "commissions": commission_records[:10],  # 只返回前10条作为预览
                "orders": order_records[:10],  # 只返回前10条作为预览
                "data": {
                    "commissions": commission_records,
                    "orders": order_records
                }
            }
        except Exception as e:
            logger.error(f"LinkHaitao 同步数据失败: {e}")
            import traceback
            logger.error(f"错误堆栈: {traceback.format_exc()}")
            return {
                "success": False,
                "message": f"同步失败: {str(e)}"
            }


