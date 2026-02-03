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
from app.services.unified_transaction_service import UnifiedTransactionService

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
        
        # 识别其他平台（LB, PM, BSH, CF等）
        is_lb = platform_code_normalized == "lb" or platform_name_normalized == "lb"
        is_pm = platform_code_normalized == "pm" or platform_name_normalized == "pm"
        is_bsh = platform_code_normalized == "bsh" or platform_name_normalized == "bsh"
        is_cf = platform_code_normalized == "cf" or platform_name_normalized == "cf"
        
        if is_collabglow:
            logger.info(f"✓ 识别为CollabGlow平台，开始同步...")
            return self._sync_collabglow_data(account, begin_date, end_date, token)
        elif is_rewardoo:
            logger.info(f"✓ 识别为Rewardoo平台，开始同步...")
            return self._sync_rewardoo_data(account, begin_date, end_date, token)
        elif is_linkhaitao:
            logger.info(f"✓ 识别为LinkHaitao平台，开始同步...")
            return self._sync_linkhaitao_data(account, begin_date, end_date, token)
        elif is_lb or is_pm or is_bsh or is_cf:
            # 使用通用平台服务
            platform_code_for_service = platform_code_normalized
            logger.info(f"✓ 识别为{platform_code_for_service.upper()}平台，使用通用服务...")
            return self._sync_generic_platform_data(account, begin_date, end_date, token, platform_code_for_service)
        else:
            # 对于其他未知平台，也尝试使用通用服务
            logger.info(f"使用通用服务处理平台: {platform_code_normalized}")
            return self._sync_generic_platform_data(account, begin_date, end_date, token, platform_code_normalized)
    
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
            
            # 如果base_url是空字符串，转换为None，让CollabGlowService使用默认值
            if api_base_url == "":
                api_base_url = None
            
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
            
            # 先保存明细交易到AffiliateTransaction表（用于查询）
            transaction_service = UnifiedTransactionService(self.db)
            transaction_saved_count = 0
            for tx in transactions_raw:
                try:
                    # 转换时间格式
                    transaction_time = tx.get('transaction_time')
                    if isinstance(transaction_time, str):
                        try:
                            transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d")
                        except:
                            try:
                                transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d %H:%M:%S")
                            except:
                                logger.warning(f"无法解析交易时间: {transaction_time}")
                                continue
                    elif not isinstance(transaction_time, datetime):
                        logger.warning(f"交易时间格式不正确: {transaction_time}")
                        continue
                    
                    # 准备交易数据
                    tx_data = {
                        "transaction_id": tx.get("transaction_id") or tx.get("order_id") or tx.get("collabgrowId") or f"cg_{tx.get('orderId', '')}",
                        "transaction_time": transaction_time,
                        "status": tx.get("status", "pending"),
                        "commission_amount": float(tx.get("commission_amount", 0) or tx.get("saleComm", 0) or 0),
                        "order_amount": float(tx.get("order_amount", 0) or tx.get("saleAmount", 0) or 0),
                        "merchant": tx.get("merchant") or tx.get("merchantName") or tx.get("mcid") or None,
                    }
                    
                    transaction_service.normalize_and_save(
                        tx=tx_data,
                        platform='cg',
                        affiliate_account_id=account.id,
                        user_id=account.user_id
                    )
                    transaction_saved_count += 1
                except Exception as e:
                    logger.warning(f"保存明细交易失败: {e}, 交易数据: {tx.get('transaction_id', 'unknown')}")
                    continue
            
            logger.info(f"[CG同步] 已保存 {transaction_saved_count} 条明细交易到AffiliateTransaction表")
            
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
                    
                    # 过滤掉rejected_rate（计算字段，不存储）
                    filtered_dict = {k: v for k, v in platform_data_dict.items() if k != 'rejected_rate'}
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            **filtered_dict
                        )
                        self.db.add(platform_data)
                    else:
                        # 更新所有字段
                        for key, value in filtered_dict.items():
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
            
            # 如果base_url是空字符串，转换为None，让RewardooService使用默认值
            if api_base_url == "":
                api_base_url = None
            
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
            
            # 先保存明细交易到AffiliateTransaction表（用于查询）
            transaction_service = UnifiedTransactionService(self.db)
            transaction_saved_count = 0
            logger.info(f"[RW同步] 开始保存 {len(transactions_raw)} 条明细交易到AffiliateTransaction表")
            
            for idx, tx in enumerate(transactions_raw):
                try:
                    # 转换时间格式
                    transaction_time = tx.get('transaction_time')
                    if not transaction_time:
                        logger.warning(f"[RW同步] 交易 {idx+1}/{len(transactions_raw)} 缺少transaction_time字段: {tx.get('transaction_id', 'unknown')}")
                        continue
                    
                    if isinstance(transaction_time, str):
                        # 如果是空字符串，跳过
                        if not transaction_time.strip():
                            logger.warning(f"[RW同步] 交易 {idx+1}/{len(transactions_raw)} 时间为空字符串: {tx.get('transaction_id', 'unknown')}")
                            continue
                        try:
                            transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d")
                        except:
                            try:
                                transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d %H:%M:%S")
                            except:
                                logger.warning(f"[RW同步] 无法解析交易时间: {transaction_time}, 交易ID: {tx.get('transaction_id', 'unknown')}")
                                continue
                    elif not isinstance(transaction_time, datetime):
                        logger.warning(f"[RW同步] 交易时间格式不正确: {transaction_time}, 类型: {type(transaction_time)}, 交易ID: {tx.get('transaction_id', 'unknown')}")
                        continue
                    
                    # 准备交易数据
                    tx_data = {
                        "transaction_id": tx.get("transaction_id") or tx.get("order_id") or f"rw_{tx.get('id', '')}",
                        "transaction_time": transaction_time,
                        "status": tx.get("status", "pending"),
                        "commission_amount": float(tx.get("commission_amount", 0) or tx.get("commission", 0) or 0),
                        "order_amount": float(tx.get("order_amount", 0) or tx.get("sale_amount", 0) or 0),
                        "merchant": tx.get("merchant") or tx.get("merchant_name") or None,
                    }
                    
                    transaction_service.normalize_and_save(
                        tx=tx_data,
                        platform='rw',
                        affiliate_account_id=account.id,
                        user_id=account.user_id
                    )
                    transaction_saved_count += 1
                except Exception as e:
                    logger.warning(f"[RW同步] 保存明细交易失败: {e}, 交易数据: {tx.get('transaction_id', 'unknown')}, 完整数据: {tx}")
                    import traceback
                    logger.debug(f"[RW同步] 错误堆栈: {traceback.format_exc()}")
                    continue
            
            logger.info(f"[RW同步] 已保存 {transaction_saved_count}/{len(transactions_raw)} 条明细交易到AffiliateTransaction表")
            
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
                    
                    # 过滤掉rejected_rate（计算字段，不存储）
                    filtered_dict = {k: v for k, v in platform_data_dict.items() if k != 'rejected_rate'}
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            **filtered_dict
                        )
                        self.db.add(platform_data)
                    else:
                        # 更新所有字段
                        for key, value in filtered_dict.items():
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
            
            logger.info(f"[LinkHaitao同步] API返回佣金数据: {len(commissions)} 条，订单数据: {len(orders)} 条")
            
            # 合并佣金和订单数据，转换为统一格式的交易列表
            all_transactions = []

            # 重要：LinkHaitaoService 返回的 orders 已包含 commission（cashback）信息。
            # commissions 与 orders 来自同一批订单，若两者都写入会导致“重复计入”（订单数/佣金翻倍）。
            # 因此这里以 orders 为准，不再把 commissions 写入交易明细。

            # 兼容历史数据：清理本次同步区间内由旧逻辑生成的重复佣金记录（transaction_id 形如 lh_comm_*）
            try:
                from app.models.affiliate_transaction import AffiliateTransaction
                begin_dt = datetime.strptime(begin_date, "%Y-%m-%d")
                end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
                dup_q = self.db.query(AffiliateTransaction).filter(
                    AffiliateTransaction.platform == "linkhaitao",
                    AffiliateTransaction.affiliate_account_id == account.id,
                    AffiliateTransaction.user_id == account.user_id,
                    AffiliateTransaction.transaction_time >= begin_dt,
                    AffiliateTransaction.transaction_time < end_dt,
                    AffiliateTransaction.transaction_id.like("lh_comm_%"),
                )
                dup_count = dup_q.count()
                if dup_count:
                    logger.info(f"[LinkHaitao同步] 清理历史重复佣金明细 {dup_count} 条（lh_comm_*）")
                    dup_q.delete(synchronize_session=False)
                    self.db.commit()
            except Exception as e:
                logger.warning(f"[LinkHaitao同步] 清理历史重复佣金明细失败（忽略，不影响继续同步）: {e}")
            
            # 将订单数据转换为交易格式
            for order in orders:
                order_date_str = order.get("date") or order.get("order_date") or order.get("transaction_time")
                if order_date_str:
                    try:
                        # 支持多种日期格式
                        date_str_clean = str(order_date_str).strip()
                        try:
                            transaction_time = datetime.strptime(date_str_clean, "%Y-%m-%d")
                        except ValueError:
                            try:
                                transaction_time = datetime.strptime(date_str_clean, "%Y-%m-%d %H:%M:%S")
                            except ValueError:
                                try:
                                    transaction_time = datetime.strptime(date_str_clean.split('T')[0], "%Y-%m-%d")
                                except ValueError:
                                    logger.warning(f"[LinkHaitao同步] 无法解析订单日期: {date_str_clean}")
                                    continue
                        
                        # LinkHaitao API返回的佣金字段：LinkHaitaoService返回的orders中，佣金字段是"commission"（来自cashback）
                        # 优先使用commission字段（LinkHaitaoService已经将cashback转换为commission）
                        commission_amount = order.get("commission")
                        if commission_amount is None:
                            # 如果commission不存在，尝试其他可能的字段名
                            commission_amount = order.get("cashback") or order.get("sale_comm") or order.get("commission_amount") or 0
                        # 处理字符串格式的佣金（可能包含$符号或逗号）
                        if isinstance(commission_amount, str):
                            commission_amount = commission_amount.replace("$", "").replace(",", "").strip()
                            try:
                                commission_amount = float(commission_amount) if commission_amount else 0
                            except (ValueError, TypeError):
                                commission_amount = 0
                        else:
                            commission_amount = float(commission_amount or 0)
                        
                        # 如果佣金为0但订单金额不为0，记录警告（可能是数据问题）
                        order_amount = float(order.get("amount", 0) or order.get("order_amount", 0) or order.get("sale_amount", 0) or 0)
                        if commission_amount == 0 and order_amount > 0:
                            logger.debug(f"[LinkHaitao同步] 订单 {order.get('order_id')} 佣金为0但订单金额为${order_amount:.2f}，原始数据: {order}")
                        
                        all_transactions.append({
                            "transaction_id": order.get("order_id") or order.get("id") or order.get("transaction_id") or f"lh_order_{order_date_str}_{order.get('amount', 0)}",
                            "transaction_time": transaction_time,
                            "status": order.get("status", "pending"),
                            "commission_amount": commission_amount,
                            "order_amount": float(order.get("amount", 0) or order.get("order_amount", 0) or order.get("sale_amount", 0) or 0),
                            "merchant": order.get("merchant") or order.get("merchant_name") or order.get("mcid") or None,
                        })
                    except Exception as e:
                        logger.warning(f"[LinkHaitao同步] 处理订单交易失败: {e}, 数据: {order}")
                    continue
                
            logger.info(f"[LinkHaitao同步] 合并后共有 {len(all_transactions)} 条交易数据")
            
            # 先保存明细交易到AffiliateTransaction表（用于查询）
            transaction_service = UnifiedTransactionService(self.db)
            transaction_saved_count = 0
            
            
            # 先保存明细交易到AffiliateTransaction表（用于查询）
            transaction_service = UnifiedTransactionService(self.db)
            transaction_saved_count = 0
            logger.info(f"[LinkHaitao同步] 准备保存 {len(all_transactions)} 条明细交易到AffiliateTransaction表")
            
            for idx, tx in enumerate(all_transactions):
                try:
                    transaction_service.normalize_and_save(
                        tx=tx,
                        platform='linkhaitao',
                        affiliate_account_id=account.id,
                        user_id=account.user_id
                    )
                    transaction_saved_count += 1
                except Exception as e:
                    logger.warning(f"[LinkHaitao同步] 保存明细交易失败 ({idx+1}/{len(all_transactions)}): {e}, 交易ID: {tx.get('transaction_id', 'unknown')}")
                    continue
            
            logger.info(f"[LinkHaitao同步] 已保存 {transaction_saved_count}/{len(all_transactions)} 条明细交易到AffiliateTransaction表")
            
            # 使用UnifiedPlatformService聚合数据并保存到PlatformData表
            if not all_transactions:
                logger.warning(f"[LinkHaitao同步] 没有交易数据，无法保存到PlatformData表")
                return {
                    "success": True,
                    "message": f"同步完成，但该日期范围（{begin_date} ~ {end_date}）内没有数据。请检查：1) Token是否正确 2) 该日期范围内是否有数据 3) 在LinkHaitao平台手动检查",
                    "saved_count": 0
                }
            
            # 使用UnifiedPlatformService按日期聚合数据（静态方法）
            date_data = UnifiedPlatformService.aggregate_by_date(
                transactions=all_transactions,
                platform='linkhaitao',
                date_field='transaction_time'
            )
            
            logger.info(f"[LinkHaitao同步] 按日期聚合后共有 {len(date_data)} 天的数据")
            
            # 保存到PlatformData表（使用与CG/RW相同的方式）
            saved_count = 0
            for trans_date, data_item in date_data.items():
                try:
                    # 使用UnifiedPlatformService.prepare_platform_data准备数据（与CG/RW保持一致）
                    date_transactions = data_item.get("transactions", [])
                    platform_data_dict = UnifiedPlatformService.prepare_platform_data(
                        transactions=date_transactions,
                        platform='linkhaitao',
                        target_date=trans_date,
                        date_field='transaction_time'
                    )
                    
                    # 过滤掉rejected_rate（这是计算字段，不应该存储）
                    filtered_dict = {k: v for k, v in platform_data_dict.items() if k != 'rejected_rate'}
                    
                    platform_data = self.db.query(PlatformData).filter(
                        PlatformData.affiliate_account_id == account.id,
                        PlatformData.date == trans_date
                    ).first()
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=trans_date,
                            **filtered_dict
                        )
                        self.db.add(platform_data)
                    else:
                        for key, value in filtered_dict.items():
                            setattr(platform_data, key, value)
                        platform_data.last_sync_at = datetime.now()
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"[LinkHaitao同步] 保存PlatformData失败: {e}, 日期: {trans_date}")
                    import traceback
                    logger.debug(f"[LinkHaitao同步] 错误堆栈: {traceback.format_exc()}")
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
    
    def _sync_generic_platform_data(
        self,
        account: AffiliateAccount,
        begin_date: str,
        end_date: str,
        token: Optional[str] = None,
        platform_code: str = ""
    ) -> Dict:
        """
        同步通用平台数据（LB, PM, BSH, CF等）
        
        支持通过账号备注配置API端点
        """
        try:
            # 获取token：优先使用传入的token，如果没有则从账号备注中读取
            import json
            if not token:
                if account.notes:
                    try:
                        notes_data = json.loads(account.notes)
                        # 尝试多种token字段名
                        token = (
                            notes_data.get(f"{platform_code}_token") or
                            notes_data.get("api_token") or
                            notes_data.get("token")
                        )
                    except:
                        pass
            
            if not token:
                return {
                    "success": False,
                    "message": f"未配置{platform_code.upper()} Token。请在同步对话框中输入Token，或在账号编辑页面的备注中配置。"
                }
            
            # 从账号备注中读取API配置
            from app.services.api_config_service import ApiConfigService
            api_config = ApiConfigService.get_account_api_config(account)
            
            # 如果配置中没有base_url，尝试从notes中读取
            base_url = api_config.get("base_url")
            if not base_url and account.notes:
                try:
                    notes_data = json.loads(account.notes)
                    base_url = (
                        notes_data.get(f"{platform_code}_api_url") or
                        notes_data.get("api_url") or
                        notes_data.get("base_url")
                    )
                except:
                    pass
            
            if not base_url:
                return {
                    "success": False,
                    "message": f"未配置{platform_code.upper()} API URL。请在账号备注中添加：{{\"{platform_code}_api_url\": \"https://api.example.com/api\"}}"
                }
            
            # 使用通用平台服务
            from app.services.generic_platform_service import GenericPlatformService
            service = GenericPlatformService(
                token=token,
                platform_code=platform_code,
                base_url=base_url,
                api_config=api_config
            )
            
            # 获取交易数据
            result = service.get_transactions(begin_date, end_date)
            
            if result.get("code") != "0":
                error_msg = result.get("message", "未知错误")
                return {
                    "success": False,
                    "message": f"同步失败: {error_msg}"
                }
            
            # 提取交易数据
            transactions_raw = service.extract_transaction_data(result)
            logger.info(f"[{platform_code.upper()}同步] 获取到 {len(transactions_raw)} 笔交易")
            
            # 先保存明细交易到AffiliateTransaction表（用于查询）
            transaction_service = UnifiedTransactionService(self.db)
            transaction_saved_count = 0
            for tx in transactions_raw:
                try:
                    # 转换时间格式
                    transaction_time = tx.get('transaction_time')
                    if isinstance(transaction_time, str):
                        try:
                            transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d")
                        except:
                            try:
                                transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d %H:%M:%S")
                            except:
                                logger.warning(f"无法解析交易时间: {transaction_time}")
                                continue
                    elif not isinstance(transaction_time, datetime):
                        logger.warning(f"交易时间格式不正确: {transaction_time}")
                        continue
                    
                    # 准备交易数据
                    tx_data = {
                        "transaction_id": tx.get("transaction_id") or tx.get("order_id") or tx.get("id") or f"{platform_code}_{tx.get('orderId', '')}",
                        "transaction_time": transaction_time,
                        "status": tx.get("status", "pending"),
                        "commission_amount": float(tx.get("commission_amount", 0) or tx.get("commission", 0) or 0),
                        "order_amount": float(tx.get("order_amount", 0) or tx.get("sale_amount", 0) or 0),
                        "merchant": tx.get("merchant") or tx.get("merchant_name") or tx.get("mcid") or None,
                    }
                    
                    transaction_service.normalize_and_save(
                        tx=tx_data,
                        platform=platform_code,
                        affiliate_account_id=account.id,
                        user_id=account.user_id
                    )
                    transaction_saved_count += 1
                except Exception as e:
                    logger.warning(f"[{platform_code.upper()}同步] 保存明细交易失败 ({idx+1}/{len(transactions_raw)}): {e}, 交易ID: {tx.get('transaction_id', 'unknown')}, 完整数据: {tx}")
                    import traceback
                    logger.debug(f"[{platform_code.upper()}同步] 错误堆栈: {traceback.format_exc()}")
                    continue
            
            logger.info(f"[{platform_code.upper()}同步] 已保存 {transaction_saved_count}/{len(transactions_raw)} 条明细交易到AffiliateTransaction表")
            
            if not transactions_raw:
                return {
                    "success": True,
                    "message": f"同步完成，但该日期范围（{begin_date} ~ {end_date}）内没有数据。请检查：1) Token是否正确 2) 该日期范围内是否有数据",
                    "saved_count": 0
                }
            
            # 使用统一服务按日期聚合数据
            from app.services.unified_platform_service import UnifiedPlatformService
            date_data = UnifiedPlatformService.aggregate_by_date(
                transactions_raw,
                platform=platform_code,
                date_field='transaction_time'
            )
            
            # 保存到数据库
            saved_count = 0
            for comm_date, data_item in date_data.items():
                try:
                    # 准备PlatformData数据
                    platform_data_dict = UnifiedPlatformService.prepare_platform_data(
                        transactions_raw,
                        platform=platform_code,
                        target_date=comm_date,
                        date_field='transaction_time'
                    )
                    
                    # 查找或创建记录
                    platform_data = self.db.query(PlatformData).filter(
                        PlatformData.affiliate_account_id == account.id,
                        PlatformData.date == comm_date
                    ).first()
                    
                    # 过滤掉rejected_rate（计算字段，不存储）
                    filtered_dict = {k: v for k, v in platform_data_dict.items() if k != 'rejected_rate'}
                    
                    if not platform_data:
                        platform_data = PlatformData(
                            affiliate_account_id=account.id,
                            user_id=account.user_id,
                            date=comm_date,
                            **filtered_dict
                        )
                        self.db.add(platform_data)
                    else:
                        # 更新所有字段
                        for key, value in filtered_dict.items():
                                setattr(platform_data, key, value)
                        platform_data.last_sync_at = datetime.now()
                    
                    saved_count += 1
                except Exception as e:
                    logger.error(f"保存{platform_code.upper()}数据失败: {e}")
                    continue
            
            self.db.commit()
            
            return {
                "success": True,
                "message": f"成功同步 {saved_count} 条记录",
                "saved_count": saved_count
            }
            
        except Exception as e:
            self.db.rollback()
            logger.error(f"同步{platform_code.upper()}数据失败: {e}")
            from app.services.api_config_service import ApiConfigService
            error_message = ApiConfigService.format_error_message(e, account, f"{platform_code.upper()} API")
            return {"success": False, "message": f"同步失败: {error_message}"}
    
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


