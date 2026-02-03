"""
统一平台数据处理服务
实现CG（CollabGlow）+ RW（Rewardoo）统一方案

核心目标：每天稳定产出6个核心指标，且不重算、不漏算、不被拒付误导

统一数据模型：
- 订单 & 拒付判断 → Transaction 级 API
- 拒付原因 / 佣金拆分 → Commission 级 API
- 对账 → Summary / Payment API（仅核对，不参与分析）
"""
from typing import Dict, List, Optional
from datetime import datetime, date
from collections import defaultdict
import json
import logging

logger = logging.getLogger(__name__)


class UnifiedPlatformService:
    """
    统一平台数据处理服务
    
    支持CG和RW平台，使用统一的数据模型和状态映射
    """
    
    # 统一状态映射表
    STATUS_MAPPING = {
        # 已确认状态
        "approved": ["approved", "locked"],
        # 待处理状态
        "pending": ["pending", "processing"],
        # 拒付状态
        "rejected": ["rejected", "declined", "reversed", "cancelled"]
    }
    
    @staticmethod
    def normalize_status(platform: str, raw_status: str) -> str:
        """
        统一状态映射
        
        Args:
            platform: 平台代码（'cg' 或 'rw'）
            raw_status: 原始状态
        
        Returns:
            统一状态：'approved', 'pending', 'rejected'
        """
        raw_status_lower = raw_status.lower().strip()
        
        # CG平台状态映射
        if platform.lower() in ['cg', 'collabglow']:
            if raw_status_lower in ['approved', 'locked']:
                return 'approved'
            elif raw_status_lower in ['pending', 'processing']:
                return 'pending'
            elif raw_status_lower in ['reversed', 'cancelled']:
                return 'rejected'
        
        # RW平台状态映射
        elif platform.lower() in ['rw', 'rewardoo']:
            if raw_status_lower == 'approved':
                return 'approved'
            elif raw_status_lower == 'pending':
                return 'pending'
            elif raw_status_lower in ['rejected', 'declined']:
                return 'rejected'
        
        # LinkHaitao平台状态映射
        elif platform.lower() in ['lh', 'linkhaitao', 'link-haitao']:
            # LinkHaitao的状态值：
            # - Effective -> approved（有效/已确认，计入已付佣金）
            # - Preliminary Effective -> pending（初步有效，待确认）
            # - pending -> pending（待处理）
            # - Expired -> rejected（过期，计入拒付佣金）
            # - Preliminary Expired -> rejected（初步过期，计入拒付佣金）
            # - untreated -> pending（未处理）
            if raw_status_lower in ['approved', 'confirmed', 'paid', 'settled', 'locked', 'effective']:
                return 'approved'
            elif raw_status_lower in ['pending', 'processing', 'waiting', 'untreated', 'preliminary effective']:
                return 'pending'
            elif raw_status_lower in ['rejected', 'declined', 'reversed', 'cancelled', 'invalid', 'adjusted', 'voided', 'expired', 'preliminary expired']:
                # expired和preliminary expired（过期/失效）应该映射为rejected，计入拒付佣金
                return 'rejected'
        
        # 默认映射
        if raw_status_lower in ['approved', 'locked', 'confirmed', 'paid', 'settled']:
            return 'approved'
        elif raw_status_lower in ['pending', 'processing', 'waiting', 'untreated']:
            return 'pending'
        elif raw_status_lower in ['rejected', 'declined', 'reversed', 'cancelled', 'invalid', 'adjusted', 'voided']:
            return 'rejected'
        
        # 未知状态，默认pending
        logger.warning(f"未知状态: {raw_status}, 平台: {platform}, 默认映射为pending")
        return 'pending'
    
    @staticmethod
    def calculate_6_core_metrics(transactions: List[Dict], platform: str = 'cg') -> Dict:
        """
        计算6个核心指标
        
        指标1: 总订单数
        指标2: 已确认订单数
        指标3: 总佣金（已确认）
        指标4: 拒付订单数
        指标5: 拒付佣金
        指标6: 拒付率
        
        Args:
            transactions: 交易列表，每个交易包含：
                - transaction_id: 交易ID（用于去重）
                - status: 状态
                - commission_amount: 佣金金额
                - order_amount: 订单金额（可选）
            platform: 平台代码
        
        Returns:
            包含6个核心指标的字典
        """
        # 使用transaction_id去重
        seen_transactions = set()
        unique_transactions = []
        
        for trans in transactions:
            transaction_id = trans.get("transaction_id") or trans.get("id") or trans.get("action_id")
            if not transaction_id:
                logger.warning(f"交易缺少transaction_id: {trans}")
                continue
            
            if transaction_id in seen_transactions:
                logger.debug(f"跳过重复交易: {transaction_id}")
                continue
            
            seen_transactions.add(transaction_id)
            unique_transactions.append(trans)
        
        # 初始化指标
        total_orders = len(unique_transactions)
        approved_orders = 0
        # 佣金口径：
        # - total_commission：所有状态的佣金总和（approved + pending + rejected）
        # - approved_commission：已付佣金（approved状态）
        # - rejected_commission：拒付佣金（rejected状态）
        # 这样净佣金可用 total_commission - rejected_commission（效仿平台数据页口径）
        total_commission = 0.0
        approved_commission = 0.0
        rejected_orders = 0
        rejected_commission = 0.0
        total_order_amount = 0.0
        
        # 按状态分类统计
        for trans in unique_transactions:
            raw_status = trans.get("status", "").strip()
            normalized_status = UnifiedPlatformService.normalize_status(platform, raw_status)
            
            commission_amount = float(trans.get("commission_amount", 0) or trans.get("commission", 0) or 0)
            order_amount = float(trans.get("order_amount", 0) or trans.get("sale_amount", 0) or 0)
            
            total_order_amount += order_amount
            
            # 所有状态都计入总佣金
            total_commission += commission_amount

            if normalized_status == 'approved':
                approved_orders += 1
                approved_commission += commission_amount
            elif normalized_status == 'rejected':
                rejected_orders += 1
                rejected_commission += commission_amount
        
        # 计算拒付率
        rejected_rate = (rejected_orders / total_orders * 100) if total_orders > 0 else 0.0
        
        return {
            # 指标1: 总订单数
            "total_orders": total_orders,
            # 指标2: 已确认订单数
            "approved_orders": approved_orders,
            # 指标3: 总佣金（所有状态）
            "total_commission": round(total_commission, 2),
            # 指标4: 拒付订单数
            "rejected_orders": rejected_orders,
            # 指标5: 拒付佣金
            "rejected_commission": round(rejected_commission, 2),
            # 指标6: 拒付率（百分比）
            "rejected_rate": round(rejected_rate, 2),
            # 已付佣金（approved状态）
            "approved_commission": round(approved_commission, 2),
            # 辅助数据
            "total_order_amount": round(total_order_amount, 2),
            "unique_transaction_count": len(seen_transactions)
        }
    
    @staticmethod
    def aggregate_by_date(
        transactions: List[Dict],
        platform: str = 'cg',
        date_field: str = 'transaction_time'
    ) -> Dict[date, Dict]:
        """
        按日期聚合交易数据
        
        Args:
            transactions: 交易列表
            platform: 平台代码
            date_field: 日期字段名（transaction_time, order_date, settlement_date等）
        
        Returns:
            按日期聚合的数据字典 {date: {metrics, transactions}}
        """
        date_data = defaultdict(lambda: {
            "transactions": [],
            "metrics": {
                "total_orders": 0,
                "approved_orders": 0,
                "total_commission": 0.0,
                "rejected_orders": 0,
                "rejected_commission": 0.0,
                "rejected_rate": 0.0,
                "total_order_amount": 0.0
            }
        })
        
        for trans in transactions:
            # 解析日期
            date_str = trans.get(date_field) or trans.get("order_date") or trans.get("settlement_date")
            if not date_str:
                logger.warning(f"交易缺少日期字段: {trans}")
                continue
            
            try:
                if isinstance(date_str, str):
                    # 尝试多种日期格式
                    date_str_clean = date_str.strip()
                    try:
                        # 格式1: YYYY-MM-DD
                        trans_date = datetime.strptime(date_str_clean, "%Y-%m-%d").date()
                    except ValueError:
                        try:
                            # 格式2: YYYY-MM-DD HH:MM:SS
                            trans_date = datetime.strptime(date_str_clean, "%Y-%m-%d %H:%M:%S").date()
                        except ValueError:
                            try:
                                # 格式3: YYYY-MM-DDTHH:MM:SS (ISO格式)
                                trans_date = datetime.strptime(date_str_clean, "%Y-%m-%dT%H:%M:%S").date()
                            except ValueError:
                                try:
                                    # 格式4: YYYY-MM-DD HH:MM:SS.ffffff (带微秒)
                                    trans_date = datetime.strptime(date_str_clean.split('.')[0], "%Y-%m-%d %H:%M:%S").date()
                                except ValueError:
                                    # 如果都失败，记录错误
                                    logger.warning(f"无法解析日期格式: {date_str_clean}")
                                    continue
                elif isinstance(date_str, datetime):
                    trans_date = date_str.date()
                elif isinstance(date_str, date):
                    trans_date = date_str
                else:
                    logger.warning(f"日期字段类型不正确: {type(date_str)}, 值: {date_str}")
                    continue
            except Exception as e:
                logger.error(f"解析日期失败: {date_str}, 错误: {e}")
                continue
            
            date_data[trans_date]["transactions"].append(trans)
        
        # 计算每日指标
        for trans_date, data in date_data.items():
            metrics = UnifiedPlatformService.calculate_6_core_metrics(
                data["transactions"],
                platform
            )
            date_data[trans_date]["metrics"] = metrics
        
        return dict(date_data)
    
    @staticmethod
    def prepare_platform_data(
        transactions: List[Dict],
        platform: str,
        target_date: date,
        date_field: str = 'transaction_time'
    ) -> Dict:
        """
        准备PlatformData所需的数据
        
        Args:
            transactions: 交易列表
            platform: 平台代码
            target_date: 目标日期
            date_field: 日期字段名
        
        Returns:
            包含所有PlatformData字段的字典
        """
        # 筛选目标日期的交易
        date_transactions = []
        for trans in transactions:
            date_str = trans.get(date_field) or trans.get("order_date") or trans.get("settlement_date")
            if not date_str:
                continue
            
            try:
                if isinstance(date_str, str):
                    # 尝试多种日期格式
                    date_str_clean = date_str.strip()
                    try:
                        # 格式1: YYYY-MM-DD
                        trans_date = datetime.strptime(date_str_clean, "%Y-%m-%d").date()
                    except ValueError:
                        try:
                            # 格式2: YYYY-MM-DD HH:MM:SS
                            trans_date = datetime.strptime(date_str_clean, "%Y-%m-%d %H:%M:%S").date()
                        except ValueError:
                            try:
                                # 格式3: YYYY-MM-DDTHH:MM:SS (ISO格式)
                                trans_date = datetime.strptime(date_str_clean, "%Y-%m-%dT%H:%M:%S").date()
                            except ValueError:
                                try:
                                    # 格式4: YYYY-MM-DD HH:MM:SS.ffffff (带微秒)
                                    trans_date = datetime.strptime(date_str_clean.split('.')[0], "%Y-%m-%d %H:%M:%S").date()
                                except ValueError:
                                    continue
                elif isinstance(date_str, datetime):
                    trans_date = date_str.date()
                elif isinstance(date_str, date):
                    trans_date = date_str
                else:
                    continue
            except:
                continue
            
            if trans_date == target_date:
                date_transactions.append(trans)
        
        # 计算指标
        metrics = UnifiedPlatformService.calculate_6_core_metrics(date_transactions, platform)
        
        # 准备订单详情JSON（用于去重和审计）
        order_details = []
        seen_ids = set()
        for trans in date_transactions:
            transaction_id = trans.get("transaction_id") or trans.get("id") or trans.get("action_id")
            if transaction_id and transaction_id not in seen_ids:
                seen_ids.add(transaction_id)
                
                # 处理transaction_time，确保是字符串格式
                transaction_time = trans.get("transaction_time") or trans.get("order_date")
                if isinstance(transaction_time, datetime):
                    transaction_time = transaction_time.strftime("%Y-%m-%d %H:%M:%S")
                elif isinstance(transaction_time, date):
                    transaction_time = transaction_time.strftime("%Y-%m-%d")
                elif transaction_time is not None:
                    transaction_time = str(transaction_time)
                else:
                    transaction_time = None
                
                order_details.append({
                    "transaction_id": transaction_id,
                    "status": trans.get("status"),
                    "normalized_status": UnifiedPlatformService.normalize_status(platform, trans.get("status", "")),
                    "commission_amount": trans.get("commission_amount") or trans.get("commission", 0),
                    "order_amount": trans.get("order_amount") or trans.get("sale_amount", 0),
                    "merchant": trans.get("merchant"),
                    "transaction_time": transaction_time
                })
        
        return {
            # 核心指标
            "orders": metrics["total_orders"],
            "approved_orders": metrics["approved_orders"],
            "commission": metrics["total_commission"],
            "rejected_orders": metrics["rejected_orders"],
            "rejected_commission": metrics["rejected_commission"],
            # 辅助字段
            "order_amount": metrics["total_order_amount"],
            "order_details": json.dumps(order_details, ensure_ascii=False) if order_details else None,
            # 元数据
            "rejected_rate": metrics["rejected_rate"]
        }

