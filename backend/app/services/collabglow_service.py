"""
CollabGlow API 服务
用于获取佣金数据并同步到系统
"""
import requests
from typing import Dict, List, Optional
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)

# API 配置
API_URL = "https://api.collabglow.com/api/commission_validation"
SOURCE = "collabglow"


class CollabGlowService:
    """CollabGlow API 服务类"""
    
    def __init__(self, token: str):
        """
        初始化服务
        
        Args:
            token: CollabGlow API token
        """
        self.token = token
        self.api_url = API_URL
        self.source = SOURCE
    
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
        headers = {
            "Content-Type": "application/json"
        }
        
        payload = {
            "source": self.source,
            "token": self.token,
            "beginDate": begin_date,
            "endDate": end_date
        }
        
        try:
            logger.info(f"请求 CollabGlow API: {begin_date} ~ {end_date}")
            response = requests.post(
                self.api_url, 
                headers=headers, 
                json=payload, 
                timeout=30
            )
            response.raise_for_status()
            
            result = response.json()
            code = result.get("code")
            message = result.get("message", "")
            
            if code == "0":
                data = result.get("data", {})
                commission_list = data.get("list", [])
                logger.info(f"成功获取 {len(commission_list)} 条佣金记录")
                return result
            else:
                error_msg = f"API 返回错误: {message} (code: {code})"
                logger.error(error_msg)
                raise Exception(error_msg)
                
        except requests.exceptions.RequestException as e:
            error_msg = f"请求失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"获取佣金数据失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
    
    def extract_commission_data(self, result: Dict) -> List[Dict]:
        """
        从 API 响应中提取佣金数据
        
        Args:
            result: API 响应数据
        
        Returns:
            提取的佣金数据列表
        """
        if not result or result.get("code") != "0":
            return []
        
        data = result.get("data", {})
        commission_list = data.get("list", [])
        
        extracted = []
        for item in commission_list:
            extracted.append({
                "brand_id": item.get("brand_id", 0),
                "mcid": item.get("mcid"),
                "sale_commission": float(item.get("sale_comm", 0) or 0),
                "settlement_date": item.get("settlement_date"),
                "note": item.get("note"),
                "settlement_id": item.get("settlement_id")
            })
        
        return extracted
    
    def sync_commissions(
        self, 
        begin_date: str, 
        end_date: str,
        max_days: int = 62
    ) -> Dict:
        """
        同步佣金数据（自动处理超过62天的情况）
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            max_days: 单次查询最大天数（API限制62天）
        
        Returns:
            同步结果
        """
        begin = datetime.strptime(begin_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
        
        if (end - begin).days > max_days:
            # 如果超过最大天数，分段查询
            logger.info(f"日期跨度超过{max_days}天，将分段查询")
            all_commissions = []
            current_begin = begin
            
            while current_begin <= end:
                current_end = min(
                    current_begin + timedelta(days=max_days - 1),
                    end
                )
                
                result = self.get_commission_data(
                    current_begin.strftime("%Y-%m-%d"),
                    current_end.strftime("%Y-%m-%d")
                )
                
                commissions = self.extract_commission_data(result)
                all_commissions.extend(commissions)
                
                current_begin = current_end + timedelta(days=1)
            
            return {
                "code": "0",
                "message": "success",
                "data": {
                    "list": all_commissions
                }
            }
        else:
            # 单次查询
            result = self.get_commission_data(begin_date, end_date)
            return {
                "code": "0",
                "message": "success",
                "data": {
                    "list": self.extract_commission_data(result)
                }
            }

