"""
CollabGlow API 服务
用于获取佣金数据、订单数据并同步到系统

根据API职责划分：
1. Transaction API / V3 - 核心API，用于获取订单数和佣金金额（一笔transaction = 一笔订单）
2. Commission Details API - 用于获取单笔订单佣金明细（拆到SKU/action）
3. Commission Validation API - 用于验证是否有效、是否通过（仅状态，不是统计）
4. Payment Summary API - 用于汇总到账金额（这是付款，不是订单）
"""
import requests
from typing import Dict, List, Optional
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)

# API 配置
SOURCE = "collabglow"
BASE_URL = "https://api.collabglow.com/api"

# 各API端点（根据实际API文档调整）
COMMISSION_VALIDATION_API = f"{BASE_URL}/commission_validation"  # 佣金验证API（仅状态）
TRANSACTION_API = f"{BASE_URL}/transaction"  # Transaction API（核心：订单数+佣金金额）
TRANSACTION_API_V3 = f"{BASE_URL}/transaction/v3"  # Transaction API V3（核心：订单数+佣金金额）
COMMISSION_DETAILS_API = f"{BASE_URL}/commission_details"  # 佣金明细API（单笔订单明细）
PAYMENT_SUMMARY_API = f"{BASE_URL}/payment_summary"  # 付款汇总API（到账金额）


from app.services.platform_services_base import PlatformServiceBase


class CollabGlowService(PlatformServiceBase):
    """
    CollabGlow API 服务类
    
    支持多个API端点，根据需求选择：
    - get_transactions(): 获取订单数和佣金金额（核心API，推荐使用）
    - get_commission_details(): 获取单笔订单佣金明细
    - get_commission_data(): 验证佣金是否有效、是否通过（仅状态）
    - get_payment_summary(): 获取汇总到账金额（付款数据）
    
    支持多渠道：
    - 每个账号可以配置不同的API端点（通过base_url参数）
    - 如果未提供base_url，使用默认的BASE_URL
    """
    
    def __init__(self, token: str, base_url: Optional[str] = None):
        """
        初始化服务
        
        Args:
            token: CollabGlow API token
            base_url: 自定义API基础URL（可选，用于支持不同渠道）
                     如果未提供，使用默认的BASE_URL
        """
        self.token = token
        self.source = SOURCE
        self.base_url = base_url or BASE_URL
        # 根据base_url构建API端点
        self.transaction_api_v3 = f"{self.base_url}/transaction/v3"
        self.transaction_api = f"{self.base_url}/transaction"
        self.commission_validation_api = f"{self.base_url}/commission_validation"
        self.commission_details_api = f"{self.base_url}/commission_details"
        self.payment_summary_api = f"{self.base_url}/payment_summary"
        
        logger.info(f"[CG Service] 初始化，base_url={self.base_url}")
    
    def get_transactions(
        self,
        begin_date: str,
        end_date: str,
        use_v3: bool = True
    ) -> Dict:
        """
        【核心API】Transaction API / V3 - 获取订单数和佣金金额
        
        职责：
        - 订单数 (Orders / Transactions): 一笔 transaction = 一笔订单 ✓
        - 佣金金额 (已确认/可结算): 通常含 commission 字段 ✓
        
        这是获取"佣金+订单数"的核心API，推荐优先使用此API。
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
            use_v3: 是否使用V3版本（默认True）
        
        Returns:
            API 响应数据，包含 transactions 列表
        """
        api_url = self.transaction_api_v3 if use_v3 else self.transaction_api
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
            logger.info(f"[Transaction API] 请求订单和佣金数据: {begin_date} ~ {end_date}")
            # 增加超时时间到60秒，并添加重试机制
            max_retries = 3
            retry_delay = 2  # 重试间隔（秒）
            
            for attempt in range(max_retries):
                try:
                    response = requests.post(
                        api_url,
                        headers=headers,
                        json=payload,
                        timeout=60  # 增加到60秒
                    )
                    response.raise_for_status()
                    break  # 成功则跳出重试循环
                except requests.exceptions.Timeout as e:
                    if attempt < max_retries - 1:
                        logger.warning(f"[Transaction API] 请求超时，第 {attempt + 1}/{max_retries} 次尝试，{retry_delay}秒后重试...")
                        import time
                        time.sleep(retry_delay)
                        continue
                    else:
                        error_msg = f"[Transaction API] 请求超时（已重试{max_retries}次）: {str(e)}"
                        logger.error(error_msg)
                        raise Exception(error_msg)
                except requests.exceptions.RequestException as e:
                    if attempt < max_retries - 1:
                        logger.warning(f"[Transaction API] 请求失败，第 {attempt + 1}/{max_retries} 次尝试，{retry_delay}秒后重试...")
                        import time
                        time.sleep(retry_delay)
                        continue
                    else:
                        raise
            
            result = response.json()
            code = result.get("code")
            message = result.get("message", "")
            
            if code == "0":
                data = result.get("data", {})
                transaction_list = data.get("list", []) or data.get("transactions", [])
                logger.info(f"[Transaction API] 成功获取 {len(transaction_list)} 笔交易（订单）")
                return result
            elif code == "1" and ("no data" in message.lower() or "没有数据" in message.lower() or "not found" in message.lower()):
                logger.info(f"[Transaction API] 该日期范围内没有数据: {message}")
                return {
                    "code": "0",
                    "message": "success",
                    "data": {
                        "list": [],
                        "transactions": []
                    }
                }
            else:
                error_msg = f"[Transaction API] 返回错误: {message} (code: {code})"
                logger.error(error_msg)
                raise Exception(error_msg)
                
        except requests.exceptions.RequestException as e:
            error_msg = f"[Transaction API] 请求失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"[Transaction API] 获取交易数据失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
    
    def get_commission_details(
        self,
        transaction_id: Optional[str] = None,
        begin_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> Dict:
        """
        【辅助API】Commission Details API - 获取单笔订单佣金明细
        
        职责：
        - 单笔订单佣金明细: 拆到 SKU / action ✓
        
        用于获取详细的佣金拆分信息，通常需要配合Transaction API使用。
        
        Args:
            transaction_id: 交易ID（如果提供，则获取该交易的明细）
            begin_date: 开始日期（如果提供transaction_id则不需要）
            end_date: 结束日期（如果提供transaction_id则不需要）
        
        Returns:
            API 响应数据，包含详细的佣金明细
        """
        headers = {
            "Content-Type": "application/json"
        }
        
        payload = {
            "source": self.source,
            "token": self.token
        }
        
        if transaction_id:
            payload["transaction_id"] = transaction_id
        else:
            if not begin_date or not end_date:
                raise ValueError("必须提供 transaction_id 或 begin_date 和 end_date")
            payload["beginDate"] = begin_date
            payload["endDate"] = end_date
        
        try:
            logger.info(f"[Commission Details API] 请求佣金明细: transaction_id={transaction_id}, date_range={begin_date}~{end_date}")
            # 增加超时时间到60秒
            response = requests.post(
                COMMISSION_DETAILS_API,
                headers=headers,
                json=payload,
                timeout=60
            )
            response.raise_for_status()
            
            result = response.json()
            code = result.get("code")
            message = result.get("message", "")
            
            if code == "0":
                data = result.get("data", {})
                details_list = data.get("list", []) or data.get("details", [])
                logger.info(f"[Commission Details API] 成功获取 {len(details_list)} 条佣金明细")
                return result
            else:
                error_msg = f"[Commission Details API] 返回错误: {message} (code: {code})"
                logger.error(error_msg)
                raise Exception(error_msg)
                
        except requests.exceptions.RequestException as e:
            error_msg = f"[Commission Details API] 请求失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"[Commission Details API] 获取佣金明细失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
    
    def get_commission_data(
        self, 
        begin_date: str, 
        end_date: str
    ) -> Dict:
        """
        【状态验证API】Commission Validation API - 验证佣金是否有效、是否通过
        
        职责：
        - 是否有效、是否通过: 仅状态，不是统计 △
        
        注意：此API主要用于验证状态，不推荐用于统计。如需统计订单数和佣金金额，请使用 get_transactions()。
        
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
            logger.info(f"[Commission Validation API] 请求佣金验证: {begin_date} ~ {end_date}, URL={self.commission_validation_api}")
            # 增加超时时间到60秒，并添加重试机制
            max_retries = 3
            retry_delay = 2  # 重试间隔（秒）
            
            for attempt in range(max_retries):
                try:
                    response = requests.post(
                        self.commission_validation_api,
                        headers=headers,
                        json=payload,
                        timeout=60  # 增加到60秒
                    )
                    response.raise_for_status()
                    break  # 成功则跳出重试循环
                except requests.exceptions.Timeout as e:
                    if attempt < max_retries - 1:
                        logger.warning(f"[Commission Validation API] 请求超时，第 {attempt + 1}/{max_retries} 次尝试，{retry_delay}秒后重试...")
                        import time
                        time.sleep(retry_delay)
                        continue
                    else:
                        error_msg = f"[Commission Validation API] 请求超时（已重试{max_retries}次）: {str(e)}"
                        logger.error(error_msg)
                        raise Exception(error_msg)
                except requests.exceptions.RequestException as e:
                    if attempt < max_retries - 1:
                        logger.warning(f"[Commission Validation API] 请求失败，第 {attempt + 1}/{max_retries} 次尝试，{retry_delay}秒后重试...")
                        import time
                        time.sleep(retry_delay)
                        continue
                    else:
                        raise
            response.raise_for_status()
            
            result = response.json()
            code = result.get("code")
            message = result.get("message", "")
            
            if code == "0":
                data = result.get("data", {})
                commission_list = data.get("list", [])
                logger.info(f"[Commission Validation API] 成功获取 {len(commission_list)} 条佣金验证记录")
                return result
            elif code == "1" and ("no data" in message.lower() or "没有数据" in message.lower() or "not found" in message.lower()):
                # "无数据"不是错误，而是正常情况，返回空列表
                logger.info(f"[Commission Validation API] 该日期范围内没有数据: {message}")
                return {
                    "code": "0",
                    "message": "success",
                    "data": {
                        "list": []
                    }
                }
            else:
                error_msg = f"[Commission Validation API] 返回错误: {message} (code: {code})"
                logger.error(error_msg)
                raise Exception(error_msg)
                
        except requests.exceptions.RequestException as e:
            error_msg = f"[Commission Validation API] 请求失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"[Commission Validation API] 获取佣金验证数据失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
    
    def get_payment_summary(
        self,
        begin_date: str,
        end_date: str
    ) -> Dict:
        """
        【付款API】Payment Summary API - 获取汇总到账金额
        
        职责：
        - 汇总到账金额: 这是"付款"，不是订单 ✗
        
        注意：此API返回的是付款数据，不是订单数据。如需订单数和佣金金额，请使用 get_transactions()。
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
        
        Returns:
            API 响应数据，包含付款汇总信息
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
            logger.info(f"[Payment Summary API] 请求付款汇总: {begin_date} ~ {end_date}, URL={self.payment_summary_api}")
            # 增加超时时间到60秒
            response = requests.post(
                self.payment_summary_api,
                headers=headers,
                json=payload,
                timeout=60
            )
            response.raise_for_status()
            
            result = response.json()
            code = result.get("code")
            message = result.get("message", "")
            
            if code == "0":
                data = result.get("data", {})
                logger.info(f"[Payment Summary API] 成功获取付款汇总数据")
                return result
            else:
                error_msg = f"[Payment Summary API] 返回错误: {message} (code: {code})"
                logger.error(error_msg)
                raise Exception(error_msg)
                
        except requests.exceptions.RequestException as e:
            error_msg = f"[Payment Summary API] 请求失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        except Exception as e:
            error_msg = f"[Payment Summary API] 获取付款汇总失败: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
    
    def extract_transaction_data(self, result: Dict) -> List[Dict]:
        """
        从 Transaction API 响应中提取交易（订单）数据，统一字段格式
        
        按照统一方案，CG平台字段映射：
        - transaction_id → action_id / transaction_id
        - order_amount → sale_amount
        - commission_amount → commission
        - status → approved / locked / reversed
        
        Args:
            result: Transaction API 响应数据
        
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
        
        data = result.get("data", {})
        transaction_list = data.get("list", []) or data.get("transactions", [])
        
        extracted = []
        for item in transaction_list:
            # CG平台状态映射：reversed = 拒付
            raw_status = item.get("status", "").strip()
            
            extracted.append({
                "transaction_id": item.get("transaction_id") or item.get("action_id") or item.get("id"),
                "transaction_time": item.get("transaction_time") or item.get("order_date") or item.get("date") or item.get("settlement_date"),
                "merchant": item.get("merchant") or item.get("brand") or item.get("brand_name") or item.get("mcid"),
                "order_amount": float(item.get("order_amount", 0) or item.get("sale_amount", 0) or 0),
                "commission_amount": float(item.get("commission_amount", 0) or item.get("commission", 0) or item.get("sale_comm", 0) or 0),
                "status": raw_status,  # 保持原始状态，由统一服务处理映射
                # 保留原始字段用于兼容
                "settlement_date": item.get("settlement_date"),
                "brand_id": item.get("brand_id", 0),
                "mcid": item.get("mcid"),
                "note": item.get("note")
            })
        
        return extracted
    
    def extract_commission_data(self, result: Dict) -> List[Dict]:
        """
        从 Commission Validation API 响应中提取佣金验证数据
        
        注意：此方法用于验证API，不推荐用于统计。如需统计，请使用 extract_transaction_data()。
        
        Args:
            result: Commission Validation API 响应数据
        
        Returns:
            提取的佣金验证数据列表
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
                "settlement_id": item.get("settlement_id"),
                "is_valid": item.get("is_valid"),  # 验证状态
                "is_approved": item.get("is_approved")  # 审批状态
            })
        
        return extracted
    
    def sync_transactions(
        self,
        begin_date: str,
        end_date: str,
        max_days: int = 62,
        use_v3: bool = True
    ) -> Dict:
        """
        【推荐使用】同步交易（订单）和佣金数据
        
        使用 Transaction API 获取订单数和佣金金额，这是核心API。
        一笔 transaction = 一笔订单，通常含 commission 字段。
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            max_days: 单次查询最大天数（API限制62天）
            use_v3: 是否使用V3版本（默认True）
        
        Returns:
            同步结果，包含交易（订单）列表
        """
        begin = datetime.strptime(begin_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
        
        if (end - begin).days > max_days:
            # 如果超过最大天数，分段查询
            logger.info(f"[Transaction API] 日期跨度超过{max_days}天，将分段查询")
            all_transactions = []
            current_begin = begin
            
            while current_begin <= end:
                current_end = min(
                    current_begin + timedelta(days=max_days - 1),
                    end
                )
                
                result = self.get_transactions(
                    current_begin.strftime("%Y-%m-%d"),
                    current_end.strftime("%Y-%m-%d"),
                    use_v3=use_v3
                )
                
                transactions = self.extract_transaction_data(result)
                all_transactions.extend(transactions)
                
                current_begin = current_end + timedelta(days=1)
            
            return {
                "code": "0",
                "message": "success",
                "data": {
                    "list": all_transactions,
                    "transactions": all_transactions
                }
            }
        else:
            # 单次查询
            result = self.get_transactions(begin_date, end_date, use_v3=use_v3)
            return {
                "code": "0",
                "message": "success",
                "data": {
                    "list": self.extract_transaction_data(result),
                    "transactions": self.extract_transaction_data(result)
                }
            }
    
    def sync_commissions(
        self, 
        begin_date: str, 
        end_date: str,
        max_days: int = 62,
        use_transaction_api: bool = False
    ) -> Dict:
        """
        同步佣金数据（自动处理超过62天的情况）
        
        注意：
        - 如果 use_transaction_api=True，使用 Transaction API（推荐，可同时获取订单数和佣金）
        - 如果 use_transaction_api=False，使用 Commission Validation API（仅状态验证）
        
        Args:
            begin_date: 开始日期
            end_date: 结束日期
            max_days: 单次查询最大天数（API限制62天）
            use_transaction_api: 是否使用Transaction API（推荐True）
        
        Returns:
            同步结果
        """
        if use_transaction_api:
            # 使用Transaction API（推荐）
            return self.sync_transactions(begin_date, end_date, max_days)
        else:
            # 使用Commission Validation API（仅状态验证）
            begin = datetime.strptime(begin_date, "%Y-%m-%d")
            end = datetime.strptime(end_date, "%Y-%m-%d")
            
            if (end - begin).days > max_days:
                # 如果超过最大天数，分段查询
                logger.info(f"[Commission Validation API] 日期跨度超过{max_days}天，将分段查询")
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


