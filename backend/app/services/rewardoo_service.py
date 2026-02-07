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

# API 配置（根据官方API文档）
# 官方API端点: https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details
DEFAULT_BASE_URL = "https://admin.rewardoo.com"  # 默认基础URL
DEFAULT_TRANSACTION_DETAILS_API = "https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details"  # 核心API
COMMISSION_DETAILS_API = None  # 暂未使用


from app.services.platform_services_base import PlatformServiceBase
from app.services.api_config_service import ApiConfigService


class RewardooService(PlatformServiceBase):
    """
    Rewardoo API 服务类
    
    按照统一方案实现：
    - get_transactions(): 核心API，获取订单数 + 已确认佣金 + 拒付佣金（统一接口）
    - get_transaction_details(): 内部方法，调用TransactionDetails API
    - get_commission_details(): 辅助API，获取拒付原因分析
    
    支持多渠道：
    - 每个账号可以配置不同的API端点（通过base_url参数）
    - 如果未提供base_url，使用默认的BASE_URL
    """
    
    def __init__(self, token: str, base_url: Optional[str] = None):
        """
        初始化服务
        
        Args:
            token: Rewardoo API token
            base_url: 自定义API基础URL（可选，用于支持不同渠道）
                     如果未提供或为空字符串，使用默认的DEFAULT_BASE_URL
        """
        self.token = token
        # 如果base_url是None或空字符串，使用默认值
        if base_url and base_url.strip():
            self.base_url = base_url.strip().rstrip('/')
            # 如果提供的是完整URL，直接使用；否则构建完整URL
            if base_url.startswith('http'):
                self.transaction_details_api = base_url
            else:
                self.transaction_details_api = f"{self.base_url}/api.php?mod=medium&op=transaction_details"
        else:
            self.base_url = DEFAULT_BASE_URL
            self.transaction_details_api = DEFAULT_TRANSACTION_DETAILS_API
        
        logger.info(f"[RW Service] 初始化，base_url={self.base_url}, transaction_api={self.transaction_details_api}")
    
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
        end_date: str,
        page: int = 1,
        limit: int = 1000
    ) -> Dict:
        """
        【核心API】TransactionDetails API - 获取订单数 + 已确认佣金 + 拒付佣金
        
        根据官方API文档实现：
        - URL: https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details
        - 请求方式: POST application/x-www-form-urlencoded
        - 必需参数: token, begin_date, end_date
        - 日期范围限制: 不超过62天
        
        返回字段映射：
        - order_id -> transaction_id (交易ID，用于去重)
        - order_time -> transaction_time (交易时间)
        - merchant_name -> merchant (商户)
        - sale_amount -> order_amount (订单金额)
        - sale_comm -> commission_amount (佣金金额)
        - status -> status (状态：Approved/Pending/Rejected)
        
        Args:
            begin_date: 开始日期，格式 YYYY-MM-DD
            end_date: 结束日期，格式 YYYY-MM-DD
        
        Returns:
            API 响应数据，包含交易列表
        """
        # 检查日期范围（不超过62天）
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d")
            end = datetime.strptime(end_date, "%Y-%m-%d")
            days_diff = (end - begin).days
            if days_diff > 62:
                error_msg = f"[RW TransactionDetails API] 日期范围超过62天限制: {days_diff}天。请缩小日期范围。"
                logger.error(error_msg)
                raise Exception(error_msg)
        except ValueError as e:
            error_msg = f"[RW TransactionDetails API] 日期格式错误: {str(e)}"
            logger.error(error_msg)
            raise Exception(error_msg)
        
        # 使用 application/x-www-form-urlencoded 格式
        headers = {
            "Content-Type": "application/x-www-form-urlencoded"
        }
        
        # 准备POST数据（表单格式）
        data = {
            "token": self.token,
            "begin_date": begin_date,
            "end_date": end_date,
            "page": int(page) if page and int(page) > 0 else 1,
            "limit": int(limit) if limit and int(limit) > 0 else 1000  # 每页最多1000条
        }
        
        try:
            logger.info(f"[RW TransactionDetails API] 请求交易数据: {begin_date} ~ {end_date}, URL={self.transaction_details_api}")
            response = requests.post(
                self.transaction_details_api,
                headers=headers,
                data=data,  # 使用data参数，自动编码为application/x-www-form-urlencoded
                timeout=30
            )
            
            # 首先检查HTTP状态码，在尝试解析JSON之前
            if response.status_code == 404:
                error_msg = f"[RW TransactionDetails API] API端点不存在 (404)。请检查API URL是否正确。当前URL: {self.transaction_details_api}。如果Rewardoo有多个渠道，请在账号备注中配置正确的API URL（rewardoo_api_url字段）。"
                logger.error(error_msg)
                raise Exception(error_msg)
            elif response.status_code != 200:
                # 对于非200状态码，尝试获取错误信息
                try:
                    error_body = response.text[:500]
                except:
                    error_body = "无法读取错误响应"
                error_msg = f"[RW TransactionDetails API] HTTP错误 {response.status_code}: {error_body}"
                logger.error(error_msg)
                raise Exception(error_msg)
            
            # 只有状态码是200时才尝试解析JSON
            # 尝试解析JSON响应
            try:
                result = response.json()
            except ValueError as e:
                # 如果响应不是JSON，可能是HTML错误页面或其他格式
                error_msg = f"[RW TransactionDetails API] 响应不是有效的JSON格式: {response.text[:200]}"
                logger.error(error_msg)
                raise Exception(error_msg)
            except Exception as e:
                error_msg = f"[RW TransactionDetails API] 解析响应时出错: {str(e)}"
                logger.error(error_msg)
                raise Exception(error_msg)
            
            # 确保result是字典类型
            if not isinstance(result, dict):
                error_msg = f"[RW TransactionDetails API] 返回格式错误: 期望字典，但得到 {type(result).__name__}: {result}。响应状态码: {response.status_code}。响应内容: {str(result)[:200]}"
                logger.error(error_msg)
                raise Exception(error_msg)
            
            # 根据官方API文档，响应格式: {"status": {"code": 0, "msg": "Success"}, "data": {"list": [...], "total_trans": "1", ...}}
            status = result.get("status", {})
            code = status.get("code")
            message = status.get("msg", "")
            
            # 检查状态码（0表示成功）
            if code == 0 or code == "0":
                # 从data.list中获取交易列表
                data = result.get("data", {})
                transaction_list = data.get("list", [])
                total_trans = data.get("total_trans", 0)
                total_page = data.get("total_page", 1)
                total_items = data.get("total_items", 0)
                
                # 记录原始响应结构（用于调试）
                logger.info(f"[RW TransactionDetails API] 响应结构: code={code}, msg={message}, total_trans={total_trans}, total_page={total_page}, list数量={len(transaction_list)}")
                
                if len(transaction_list) == 0:
                    logger.warning(f"[RW TransactionDetails API] 返回0笔交易。原始响应: {str(result)[:500]}")
                
                logger.info(f"[RW TransactionDetails API] 成功获取 {len(transaction_list)} 笔交易（共 {total_trans} 笔），page={data.get('page')}/{total_page}")
                
                # 返回统一格式
                return {
                    "code": "0",
                    "message": message or "success",
                    "data": {
                        "transactions": transaction_list,
                        "total_trans": total_trans,
                        "total_page": total_page,
                        "total_items": total_items
                    }
                }
            else:
                # 根据API文档的错误码处理
                error_codes = {
                    1000: "Affiliate does not exist (联盟账号不存在)",
                    1001: "Invalid token (Token无效)",
                    1002: "Call frequency too high (调用频率过高)",
                    1003: "Missing required parameters or incorrect format (缺少必需参数或格式错误)",
                    1005: "uid can not exceed 200 characters (uid不能超过200字符)",
                    1006: "Query time span cannot exceed 62 days (查询时间跨度不能超过62天)"
                }
                
                error_desc = error_codes.get(code, f"未知错误 (code: {code})")
                error_msg = f"[RW TransactionDetails API] 返回错误: {message} ({error_desc})"
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
            logger.info(f"[RW CommissionDetails API] 请求佣金明细: transaction_id={transaction_id}, date_range={begin_date}~{end_date}, URL={self.commission_details_api}")
            response = requests.post(
                self.commission_details_api,
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

        def _to_int(v, default: int = 0) -> int:
            try:
                if v is None:
                    return default
                if isinstance(v, int):
                    return v
                s = str(v).strip()
                if not s:
                    return default
                return int(float(s))
            except Exception:
                return default

        def _sync_range(b: datetime, e: datetime) -> Dict:
            """
            同步一个日期范围（<= max_days），自动翻页合并所有交易。
            注意：RW 返回的 total_page / total_trans 在不同渠道可能不稳定，因此以“本页数量是否达到limit”作为继续翻页的依据。
            """
            limit = 1000
            all_tx: List[dict] = []

            first = self.get_transaction_details(b.strftime("%Y-%m-%d"), e.strftime("%Y-%m-%d"), page=1, limit=limit)
            if first.get("code") != "0":
                return first
            data = first.get("data", {}) or {}
            page_list = list(data.get("transactions", []) or [])
            all_tx.extend(page_list)

            total_trans = _to_int(data.get("total_trans"), default=0) or None
            total_page = _to_int(data.get("total_page"), default=0) or None
            # 给一个上限，避免接口异常导致无限翻页
            max_pages = total_page or (_to_int((total_trans / limit) if total_trans else 0, default=0) + 5) or 50
            if max_pages < 2:
                max_pages = 50  # 兜底：如果total_page不可靠，最多拉50页（5万条）

            p = 2
            while p <= max_pages:
                # 如果已达到预期总数，提前结束
                if total_trans and len(all_tx) >= total_trans:
                    break
                # 如果上一页不足limit，通常已到末页
                if len(page_list) < limit:
                    break
                res = self.get_transaction_details(b.strftime("%Y-%m-%d"), e.strftime("%Y-%m-%d"), page=p, limit=limit)
                if res.get("code") != "0":
                    logger.warning(f"[RW TransactionDetails API] 翻页失败 page={p}: {res.get('message')}")
                    break
                rdata = res.get("data", {}) or {}
                page_list = list(rdata.get("transactions", []) or [])
                if not page_list:
                    break
                all_tx.extend(page_list)
                p += 1

            logger.info(f"[RW TransactionDetails API] 分页汇总完成：{b.date()}~{e.date()} 拉取 {len(all_tx)} 笔交易（total_trans={total_trans}, pages_tried={p-1})")
            return {
                "code": "0",
                "message": first.get("message", "success"),
                "data": {
                    "transactions": all_tx,
                    "total_trans": total_trans or len(all_tx),
                    "total_page": total_page or p - 1,
                    "total_items": data.get("total_items", 0),
                }
            }
        
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
                
                result = _sync_range(current_begin, current_end)
                
                transactions = result.get("data", {}).get("transactions", [])
                all_transactions.extend(transactions)
                
                current_begin = current_end + timedelta(days=1)
            
            return {"code": "0", "message": "success", "data": {"transactions": all_transactions}}
        else:
            # 单次查询
            return _sync_range(begin, end)
    
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
        if not result:
            logger.warning("[RW extract_transaction_data] result为空")
            return []
        
        # 检查响应码
        code = result.get("code") or result.get("status_code")
        if code != 0 and code != "0" and not result.get("success"):
            error_msg = f"[RW extract_transaction_data] API返回错误码: {code}, message: {result.get('message', '')}"
            logger.warning(error_msg)
            return []
        
        # 根据get_transaction_details返回的格式: {"data": {"transactions": [...], ...}}
        # 或官方API文档格式: {"data": {"list": [...], ...}}
        data = result.get("data", {})
        if isinstance(data, dict):
            # 优先从data.transactions获取（get_transaction_details返回的格式）
            transactions = data.get("transactions", [])
            # 如果没有，尝试从data.list获取（官方API原始格式）
            if not transactions:
                transactions = data.get("list", [])
        elif isinstance(data, list):
            # 如果data直接是数组（兼容旧格式）
            transactions = data
        else:
            # 如果result直接包含transactions（兼容旧格式）
            transactions = result.get("transactions", [])
        
        logger.info(f"[RW extract_transaction_data] 从响应中提取到 {len(transactions)} 笔原始交易数据")
        
        if len(transactions) == 0:
            logger.warning(f"[RW extract_transaction_data] 未找到交易数据。响应结构: code={code}, data类型={type(data)}, result键={list(result.keys())}")
        
        extracted = []

        def _to_float(v) -> float:
            """
            更稳健的数字解析：
            - 兼容 int/float/字符串
            - 兼容带逗号、货币符号的字符串（如 "$1,234.56"）
            """
            if v is None:
                return 0.0
            try:
                if isinstance(v, (int, float)):
                    return float(v)
                s = str(v).strip()
                if not s:
                    return 0.0
                for ch in ["$", "¥", "￥", ","]:
                    s = s.replace(ch, "")
                return float(s)
            except Exception:
                return 0.0
        for idx, item in enumerate(transactions):
            try:
                if not isinstance(item, dict):
                    logger.warning(f"[RW extract_transaction_data] 交易项 {idx} 不是字典类型: {type(item)}")
                    continue
                
                # 根据官方API文档字段映射
                # API返回字段: order_id, order_time, merchant_name, sale_amount, sale_comm, status
                # 统一格式字段: transaction_id, transaction_time, merchant, order_amount, commission_amount, status
                
                # 状态值转换：Approved/Pending/Rejected -> approved/pending/rejected
                status_raw = str(item.get("status", "") or "").strip()
                status_lower = status_raw.lower() if status_raw else ""
                
                # 处理时间戳：order_time可能是时间戳（整数）或日期字符串
                order_time = item.get("order_time") or item.get("transaction_time") or item.get("validation_date") or item.get("date") or ""
                if order_time:
                    # 如果是时间戳（整数或数字字符串），转换为日期字符串
                    try:
                        if isinstance(order_time, (int, float)) or (isinstance(order_time, str) and order_time.isdigit()):
                            timestamp = int(float(order_time))
                            # 转换为日期时间字符串
                            from datetime import datetime
                            order_time = datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")
                    except (ValueError, OSError, OverflowError):
                        # 如果转换失败，保持原值
                        pass
                
                # 提取商家ID（MID）：RW 平台的 MID 是 mid 字段（数字ID）
                # mid 是广告系列名中的 MID（如 116022），mcid 是商家标识符（如 revisionskincare）
                mid_value = item.get("mid") or item.get("brand_id") or item.get("brandId") or item.get("m_id") or item.get("merchant_id")
                merchant_id = str(mid_value).strip() if mid_value else None
                
                extracted.append({
                    "transaction_id": item.get("order_id") or item.get("transaction_id") or item.get("rewardoo_id") or item.get("id") or f"rw_{idx}",
                    "transaction_time": order_time,
                    "merchant": item.get("merchant_name") or item.get("merchant") or item.get("brand") or item.get("brand_name") or "",
                    "order_amount": _to_float(
                        item.get("sale_amount", 0)
                        or item.get("saleAmount", 0)
                        or item.get("order_amount", 0)
                        or item.get("orderAmount", 0)
                        or item.get("order_unit", 0)
                        or 0
                    ),
                    # Rewardoo 不同渠道字段名可能不同：sale_comm / sale_commission / commissionAmount / payout / earnings 等
                    "commission_amount": _to_float(
                        item.get("sale_comm", 0)
                        or item.get("saleComm", 0)
                        or item.get("sale_commission", 0)
                        or item.get("saleCommission", 0)
                        or item.get("commission_amount", 0)
                        or item.get("commissionAmount", 0)
                        or item.get("commission", 0)
                        or item.get("payout", 0)
                        or item.get("earnings", 0)
                        or 0
                    ),
                    "status": status_lower,  # 转换为小写：approved/pending/rejected
                    "merchant_id": merchant_id,  # MID - 用于和广告系列名匹配
                    # 保留原始字段（用于调试和扩展）
                    "raw_data": item
                })
            except Exception as e:
                logger.error(f"[RW extract_transaction_data] 处理交易项 {idx} 时出错: {e}, 数据: {item}")
                continue
        
        logger.info(f"[RW extract_transaction_data] 成功提取 {len(extracted)} 笔格式化交易数据")
        return extracted

