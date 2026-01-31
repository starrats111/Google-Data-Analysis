"""
平台数据同步服务
从平台API同步佣金、订单等数据
"""
from datetime import datetime, date, timedelta
from typing import List, Dict, Optional
from sqlalchemy.orm import Session
import json
import logging

from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount
from app.services.collabglow_service import CollabGlowService
from app.services.linkhaitao_service import LinkHaitaoService
from app.services.rewardoo_service import RewardooService
from app.services.unified_platform_service import UnifiedPlatformService

logger = logging.getLogger(__name__)


class PlatformDataSyncService:
    """平台数据同步服务"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def sync_account_data(
        self,
        account_id: int,
        begin_date: str,
        end_date: str,
        token: Optional[str] = None
    ) -> Dict:
        """
        同步指定账号的平台数据
        
        Args:
            account_id: 联盟账号ID
            begin_date: 开始日期 YYYY-MM-DD
            end_date: 结束日期 YYYY-MM-DD
        
        Returns:
            同步结果
        """
        from sqlalchemy.orm import joinedload
        
        account = self.db.query(AffiliateAccount).options(
            joinedload(AffiliateAccount.platform)
        ).filter(
            AffiliateAccount.id == account_id
        ).first()
        
        if not account:
            return {"success": False, "message": "账号不存在"}
        
        if not account.platform:
            return {"success": False, "message": "账号关联的平台不存在"}
        
        platform_code = account.platform.platform_code.lower() if account.platform.platform_code else ""
        platform_name = account.platform.platform_name or "未知平台"
        platform_url = getattr(account.platform, 'description', '') or ''
        
        logger.info(f"同步账号 {account.account_name} (ID: {account_id})")
        logger.info(f"平台信息 - 代码(原始): {account.platform.platform_code}, 代码(小写): {platform_code}, 名称: {platform_name}, URL: {platform_url}")
        
        # 根据平台类型选择不同的服务
        # 支持多种平台代码格式（不区分大小写）
        platform_code_normalized = platform_code.strip()
        platform_name_normalized = platform_name.strip().lower()
        
        print(f"[平台同步] 账号: {account.account_name}, 平台代码: {platform_code_normalized}, 平台名称: {platform_name_normalized}")  # 确保输出到控制台
        
        # 识别逻辑：同时检查平台代码和平台名称
        # 因为有些平台的platform_code可能是URL而不是代码
        is_collabglow = (
            platform_code_normalized in ["collabglow", "cg", "collab-glow", "collab_glow"] or
            platform_name_normalized in ["cg", "collabglow", "collab-glow"] or
            "collabglow" in platform_code_normalized or
            "collabglow" in platform_name_normalized
        )
        
        is_linkhaitao = (
            platform_code_normalized in ["linkhaitao", "link-haitao", "lh", "link_haitao"] or
            platform_name_normalized in ["lh", "linkhaitao", "link-haitao"] or
            "linkhaitao" in platform_code_normalized or
            "linkhaitao" in platform_name_normalized
        )
        
        is_rewardoo = (
            platform_code_normalized in ["rewardoo", "rw", "reward-oo", "reward_oo"] or
            platform_name_normalized in ["rw", "rewardoo", "reward-oo"] or
            "rewardoo" in platform_code_normalized or
            "rewardoo" in platform_name_normalized
        )
        
        if is_collabglow:
            logger.info(f"✓ 识别为CollabGlow平台，开始同步...")
            return self._sync_collabglow_data(account, begin_date, end_date, token)
        elif is_rewardoo:
            logger.info(f"✓ 识别为Rewardoo平台，开始同步...")
            return self._sync_rewardoo_data(account, begin_date, end_date, token)
        elif is_linkhaitao:
            logger.info(f"✓ 识别为LinkHaitao平台，开始同步...")
            return self._sync_linkhaitao_data(account, begin_date, end_date, token)
        else:
            # 对于其他平台，尝试从notes中读取通用API配置
            # 如果平台有API token配置，可以在这里扩展支持
            logger.warning(f"✗ 未识别的平台代码: '{platform_code_normalized}' (原始: '{account.platform.platform_code}'), 平台名称: {platform_name}")
            error_msg = f"平台 {platform_name}"
            if platform_url:
                error_msg += f" ({platform_url})"
            error_msg += f" 的API集成尚未实现。请联系管理员添加该平台的API支持。"
            return {"success": False, "message": error_msg}
    
    def _sync_collabglow_data(
        self,
        account: AffiliateAccount,
        begin_date: str,
        end_date: str,
        token: Optional[str] = None
    ) -> Dict:
        """同步CollabGlow数据"""
        try:
            # 获取token：优先使用传入的token，如果没有则从账号备注中读取
            import json
            if not token:
                if account.notes:
                    try:
                        notes_data = json.loads(account.notes)
                        # 优先使用collabglow_token，如果没有则使用api_token（通用token字段）
                        token = notes_data.get("collabglow_token") or notes_data.get("api_token")
                    except:
                        pass
            
            if not token:
                return {"success": False, "message": "未配置CollabGlow Token。请在同步对话框中输入Token，或在账号编辑页面的备注中配置。"}
            
            # 使用ApiConfigService获取API配置（支持多渠道）
            from app.services.api_config_service import ApiConfigService
            api_config = ApiConfigService.get_account_api_config(account)
            api_base_url = api_config.get("base_url")
            
            if api_base_url:
                logger.info(f"[CG同步] 使用API配置: base_url={api_base_url}")
            else:
                logger.info(f"[CG同步] 使用默认API配置")
            
            # 同步数据（使用统一方案）
            logger.info(f"使用Token进行同步 (Token长度: {len(token) if token else 0}, API URL: {api_base_url or '默认'})")
            service = CollabGlowService(token=token, base_url=api_base_url)
            
            # 优先使用Transaction API（核心API，可同时获取订单数、佣金和拒付数据）
            try:
                logger.info("[CG同步] 使用Transaction API（核心API：订单数+佣金+拒付）")
                result = service.sync_transactions(begin_date, end_date)
                transactions_raw = service.extract_transaction_data(result)
                logger.info(f"[CG同步] Transaction API返回 {len(transactions_raw)} 笔交易（订单）")
                print(f"[CG同步] Transaction API返回 {len(transactions_raw)} 笔交易（订单）")
            except Exception as e:
                # Transaction API失败，回退到Commission Validation API
                logger.warning(f"[CG同步] Transaction API失败: {e}，回退到Commission Validation API")
                result = service.sync_commissions(begin_date, end_date, use_transaction_api=False)
                transactions_raw = service.extract_commission_data(result)
                # 将Commission Validation API数据转换为统一格式
                transactions_raw = [
                    {
                        "transaction_id": item.get("settlement_id") or f"cg_{item.get('mcid')}_{item.get('settlement_date')}",
                        "transaction_time": item.get("settlement_date"),
                        "merchant": item.get("mcid"),
                        "order_amount": 0,
                        "commission_amount": item.get("sale_commission", 0),
                        "status": "approved"  # Commission Validation API默认是已确认的
                    }
                    for item in transactions_raw
                ]
                logger.info(f"[CG同步] Commission Validation API返回 {len(transactions_raw)} 条佣金记录")
                print(f"[CG同步] Commission Validation API返回 {len(transactions_raw)} 条佣金记录")
            
            # 如果返回0条记录，提供更详细的诊断信息
            if len(transactions_raw) == 0:
                diagnostic_msg = f"日期范围 {begin_date} ~ {end_date} 内没有数据。"
                diagnostic_msg += " 请确认：1) Token是否正确 2) 该日期范围内是否有数据 3) 在CollabGlow平台手动检查该日期范围"
                logger.warning(f"[CG同步] {diagnostic_msg}")
                print(f"[CG同步诊断] {diagnostic_msg}")
            
            if not transactions_raw:
                return {
                    "success": True,
                    "message": f"同步完成，但该日期范围（{begin_date} ~ {end_date}）内没有数据。请检查：1) Token是否正确 2) 该日期范围内是否有数据 3) 在CollabGlow平台手动检查",
                    "saved_count": 0
                }
            
            # 使用统一服务按日期聚合数据并计算6个核心指标
            date_data = UnifiedPlatformService.aggregate_by_date(
                transactions_raw,
                platform='cg',
                date_field='transaction_time'
            )
            
            # 保存到数据库
            saved_count = 0
            for comm_date, data_item in date_data.items():
                try:
                    # 准备PlatformData数据
                    platform_data_dict = UnifiedPlatformService.prepare_platform_data(
                        transactions_raw,
                        platform='cg',
                        target_date=comm_date,
                        date_field='transaction_time'
                    )
                    
                    # 查找或创建记录
                    platform_data = self.db.query(PlatformData).filter(
                        PlatformData.affiliate_account_id == account.id,
                        PlatformData.date == comm_date
                    ).first()
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            **platform_data_dict
                        )
                        self.db.add(platform_data)
                    else:
                        # 更新所有字段
                        for key, value in platform_data_dict.items():
                            if key != 'rejected_rate':  # rejected_rate是计算字段，不存储
                                setattr(platform_data, key, value)
                        platform_data.last_sync_at = datetime.now()
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"保存CollabGlow数据失败: {e}")
                    continue
            
            self.db.commit()
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条记录",
                "saved_count": saved_count
            }
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"同步CollabGlow数据失败: {e}")
            # 使用ApiConfigService格式化友好的错误消息
            from app.services.api_config_service import ApiConfigService
            # 根据错误类型选择API名称
            api_name = "Commission Validation API"
            if "Transaction API" in str(e):
                api_name = "Transaction API"
            error_message = ApiConfigService.format_error_message(e, account, api_name)
            return {"success": False, "message": f"同步失败: {error_message}"}
    
    def _sync_rewardoo_data(
        self,
        account: AffiliateAccount,
        begin_date: str,
        end_date: str,
        token: Optional[str] = None
    ) -> Dict:
        """
        同步Rewardoo数据（使用统一方案）
        
        核心API：TransactionDetails API
        辅助API：CommissionDetails API（用于拒付原因分析）
        """
        try:
            # 获取token：优先使用传入的token，如果没有则从账号备注中读取
            import json
            if not token:
                if account.notes:
                    try:
                        notes_data = json.loads(account.notes)
                        token = notes_data.get("rewardoo_token") or notes_data.get("rw_token") or notes_data.get("api_token")
                    except:
                        pass
            
            if not token:
                return {"success": False, "message": "未配置Rewardoo Token。请在同步对话框中输入Token，或在账号编辑页面的备注中配置。"}
            
            # 使用ApiConfigService获取API配置（支持多渠道）
            from app.services.api_config_service import ApiConfigService
            api_config = ApiConfigService.get_account_api_config(account)
            api_base_url = api_config.get("base_url")
            
            if api_base_url:
                logger.info(f"[RW同步] 使用API配置: base_url={api_base_url}")
            else:
                logger.info(f"[RW同步] 使用默认API配置")
            
            # 同步数据（使用TransactionDetails API，这是核心API）
            logger.info(f"使用Token进行同步 (Token长度: {len(token) if token else 0}, API URL: {api_base_url or '默认'})")
            service = RewardooService(token=token, base_url=api_base_url)
            
            logger.info("[RW同步] 使用TransactionDetails API（核心API：订单数+佣金+拒付）")
            result = service.sync_transactions(begin_date, end_date)
            
            # 确保result是字典类型
            if not isinstance(result, dict):
                error_msg = f"[RW同步] sync_transactions返回格式错误: 期望字典，但得到 {type(result).__name__}: {result}"
                logger.error(error_msg)
                return {"success": False, "message": error_msg}
            
            transactions_raw = service.extract_transaction_data(result)
            logger.info(f"[RW同步] TransactionDetails API返回 {len(transactions_raw)} 笔交易（订单）")
            print(f"[RW同步] TransactionDetails API返回 {len(transactions_raw)} 笔交易（订单）")
            
            # 如果返回0条记录，提供更详细的诊断信息
            if len(transactions_raw) == 0:
                # 检查API响应，看是否真的没有数据还是格式问题
                api_code = result.get("code") or result.get("status_code")
                api_message = result.get("message", "")
                api_data = result.get("data", {})
                
                diagnostic_msg = f"日期范围 {begin_date} ~ {end_date} 内没有数据。"
                diagnostic_msg += f" API响应: code={api_code}, message={api_message}"
                
                if isinstance(api_data, dict):
                    transactions_in_data = api_data.get("transactions", [])
                    diagnostic_msg += f", data.transactions数量={len(transactions_in_data) if isinstance(transactions_in_data, list) else 'N/A'}"
                elif isinstance(api_data, list):
                    diagnostic_msg += f", data是数组，长度={len(api_data)}"
                
                diagnostic_msg += "。请确认：1) Token是否正确 2) 该日期范围内是否有数据 3) 在Rewardoo平台手动检查该日期范围 4) API响应格式是否符合预期"
                
                logger.warning(f"[RW同步] {diagnostic_msg}")
                print(f"[RW同步诊断] {diagnostic_msg}")
            
            if not transactions_raw:
                return {
                    "success": True,
                    "message": f"同步完成，但该日期范围（{begin_date} ~ {end_date}）内没有数据。请检查：1) Token是否正确 2) 该日期范围内是否有数据 3) 在Rewardoo平台手动检查",
                    "saved_count": 0
                }
            
            # 使用统一服务按日期聚合数据并计算6个核心指标
            date_data = UnifiedPlatformService.aggregate_by_date(
                transactions_raw,
                platform='rw',
                date_field='transaction_time'
            )
            
            # 保存到数据库
            saved_count = 0
            for comm_date, data_item in date_data.items():
                try:
                    # 准备PlatformData数据
                    platform_data_dict = UnifiedPlatformService.prepare_platform_data(
                        transactions_raw,
                        platform='rw',
                        target_date=comm_date,
                        date_field='transaction_time'
                    )
                    
                    # 查找或创建记录
                    platform_data = self.db.query(PlatformData).filter(
                        PlatformData.affiliate_account_id == account.id,
                        PlatformData.date == comm_date
                    ).first()
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            **platform_data_dict
                        )
                        self.db.add(platform_data)
                    else:
                        # 更新所有字段
                        for key, value in platform_data_dict.items():
                            if key != 'rejected_rate':  # rejected_rate是计算字段，不存储
                                setattr(platform_data, key, value)
                        platform_data.last_sync_at = datetime.now()
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"保存Rewardoo数据失败: {e}")
                    continue
            
            self.db.commit()
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条记录",
                "saved_count": saved_count
            }
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"同步Rewardoo数据失败: {e}")
            # 使用ApiConfigService格式化友好的错误消息
            from app.services.api_config_service import ApiConfigService
            error_message = ApiConfigService.format_error_message(e, account, "RW TransactionDetails API")
            return {"success": False, "message": f"同步失败: {error_message}"}
    
    def _sync_linkhaitao_data(
        self,
        account: AffiliateAccount,
        begin_date: str,
        end_date: str,
        token: Optional[str] = None
    ) -> Dict:
        """同步LinkHaitao数据"""
        try:
            # 获取token：优先使用传入的token，如果没有则从账号备注中读取
            import json
            if not token:
                if account.notes:
                    try:
                        notes_data = json.loads(account.notes)
                        token = notes_data.get("linkhaitao_token") or notes_data.get("token")
                    except:
                        pass
            
            if not token:
                return {"success": False, "message": "未配置LinkHaitao Token。请在同步对话框中输入Token，或在账号编辑页面的备注中配置。"}
            
            # 同步数据
            service = LinkHaitaoService(token=token)
            result = service.sync_commissions_and_orders(begin_date, end_date)
            
            if not result.get("success"):
                return result
            
            data = result.get("data", {})
            commissions = data.get("commissions", [])
            orders = data.get("orders", [])
            
            # 按日期聚合数据
            date_data = {}
            
            # 处理佣金数据
            for comm in commissions:
                settlement_date = comm.get("settlement_date")
                if not settlement_date:
                    continue
                
                try:
                    comm_date = datetime.strptime(settlement_date, "%Y-%m-%d").date()
                    if comm_date not in date_data:
                        date_data[comm_date] = {
                            "commission": 0,
                            "orders": [],
                            "order_count": 0
                        }
                    date_data[comm_date]["commission"] += comm.get("commission", 0)
                except:
                    continue
            
            # 处理订单数据
            for order in orders:
                order_date_str = order.get("date") or order.get("order_date")
                if not order_date_str:
                    continue
                
                try:
                    order_date = datetime.strptime(order_date_str, "%Y-%m-%d").date()
                    if order_date not in date_data:
                        date_data[order_date] = {
                            "commission": 0,
                            "orders": [],
                            "order_count": 0
                        }
                    date_data[order_date]["orders"].append(order)
                    date_data[order_date]["order_count"] += 1
                except:
                    continue
            
            # 保存到数据库
            saved_count = 0
            for comm_date, data_item in date_data.items():
                try:
                    platform_data = self.db.query(PlatformData).filter(
                        PlatformData.affiliate_account_id == account.id,
                        PlatformData.date == comm_date
                    ).first()
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            commission=data_item["commission"],
                            orders=data_item["order_count"],
                            order_days_this_week=0,  # 需要计算本周出单天数
                            order_details=json.dumps(data_item["orders"]) if data_item["orders"] else None
                        )
                        self.db.add(platform_data)
                    else:
                        platform_data.commission = data_item["commission"]
                        platform_data.orders = data_item["order_count"]
                        platform_data.order_details = json.dumps(data_item["orders"]) if data_item["orders"] else None
                        platform_data.last_sync_at = datetime.now()
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"保存LinkHaitao数据失败: {e}")
                    continue
            
            self.db.commit()
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条记录",
                "saved_count": saved_count
            }
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"同步LinkHaitao数据失败: {e}")
            return {"success": False, "message": f"同步失败: {str(e)}"}
    
    def calculate_weekly_order_days(self, account_id: int, target_date: date) -> int:
        """
        计算指定日期所在周的出单天数
        
        Args:
            account_id: 联盟账号ID
            target_date: 目标日期
        
        Returns:
            本周出单天数
        """
        # 计算本周的开始日期（周一）
        days_since_monday = target_date.weekday()
        week_start = target_date - timedelta(days=days_since_monday)
        week_end = week_start + timedelta(days=6)
        
        # 查询本周有订单的日期
        order_dates = self.db.query(PlatformData.date).filter(
            PlatformData.affiliate_account_id == account_id,
            PlatformData.date >= week_start,
            PlatformData.date <= week_end,
            PlatformData.orders > 0
        ).distinct().all()
        
        return len(order_dates)
    
    def update_weekly_order_days(self, account_id: int, target_date: date):
        """更新指定日期所在周的所有记录的本周出单天数"""
        days_since_monday = target_date.weekday()
        week_start = target_date - timedelta(days=days_since_monday)
        week_end = week_start + timedelta(days=6)
        
        order_days = self.calculate_weekly_order_days(account_id, target_date)
        
        # 更新本周所有记录
        self.db.query(PlatformData).filter(
            PlatformData.affiliate_account_id == account_id,
            PlatformData.date >= week_start,
            PlatformData.date <= week_end
        ).update({
            PlatformData.order_days_this_week: order_days
        })
        
        self.db.commit()


