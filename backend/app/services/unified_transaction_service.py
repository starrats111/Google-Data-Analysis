"""
统一交易数据处理服务
支持8个平台：CG / RW / Linkhaitao / PartnerBoost / Linkbux / Partnermatic / BrandSparkHub / CreatorFlare

核心功能：
1. 统一状态映射
2. 数据入库（交易主表 + 拒付详情表）
3. 增量拉取规则
4. 去重机制
"""
from typing import Dict, List, Optional
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
import json
import logging

from app.models.affiliate_transaction import AffiliateTransaction, AffiliateRejection

logger = logging.getLogger(__name__)


class UnifiedTransactionService:
    """
    统一交易数据处理服务
    
    实现：
    - 统一状态映射
    - 数据入库（交易主表 + 拒付详情表）
    - 增量拉取规则
    - 去重机制
    """
    
    # 统一状态映射（非常关键）
    STATUS_MAP = {
        # Approved
        "approved": "approved",
        "confirmed": "approved",
        "locked": "approved",
        "paid": "approved",
        "settled": "approved",
        "effective": "approved",  # LinkHaitao的有效状态（计入已付佣金）
        
        # Pending
        "pending": "pending",
        "under_review": "pending",
        "processing": "pending",
        "waiting": "pending",
        "untreated": "pending",  # LinkHaitao的默认状态
        "preliminary effective": "pending",  # LinkHaitao的初步有效状态（待确认）
        
        # Rejected
        "rejected": "rejected",
        "declined": "rejected",
        "reversed": "rejected",
        "invalid": "rejected",
        "adjusted": "rejected",
        "cancelled": "rejected",
        "voided": "rejected",
        "expired": "rejected",  # LinkHaitao的expired状态（过期/失效，计入拒付佣金）
        "preliminary expired": "rejected",  # LinkHaitao的初步过期状态（计入拒付佣金）
    }
    
    def __init__(self, db: Session):
        self.db = db
    
    def normalize_status(self, raw_status: str) -> str:
        """
        统一状态映射
        
        Args:
            raw_status: 平台原始状态
        
        Returns:
            统一状态：approved / pending / rejected
        """
        if not raw_status:
            return "pending"
        
        raw_status_lower = raw_status.lower().strip()
        return self.STATUS_MAP.get(raw_status_lower, "pending")
    
    def normalize_and_save(
        self,
        tx: Dict,
        platform: str,
        affiliate_account_id: Optional[int] = None,
        user_id: Optional[int] = None
    ) -> AffiliateTransaction:
        """
        统一入库函数
        
        Args:
            tx: 交易数据字典，必须包含：
                - transaction_id: 交易ID
                - transaction_time: 交易时间
                - status: 状态
                - commission_amount: 佣金金额
                - order_amount: 订单金额（可选）
            platform: 平台代码
            affiliate_account_id: 联盟账号ID（可选）
            user_id: 用户ID（可选）
        
        Returns:
            保存的AffiliateTransaction对象
        """
        raw_status = tx.get("status", "").strip()
        normalized_status = self.normalize_status(raw_status)
        
        # 解析交易时间
        transaction_time = tx.get("transaction_time")
        if isinstance(transaction_time, str):
            try:
                transaction_time = datetime.fromisoformat(transaction_time.replace('Z', '+00:00'))
            except:
                try:
                    transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d %H:%M:%S")
                except:
                    transaction_time = datetime.strptime(transaction_time, "%Y-%m-%d")
        elif not isinstance(transaction_time, datetime):
            transaction_time = datetime.now()
        
        # 准备数据
        data = {
            "platform": platform,
            "merchant": tx.get("merchant") or tx.get("brand") or tx.get("brand_name"),
            "transaction_id": str(tx["transaction_id"]),
            "transaction_time": transaction_time,
            "order_amount": float(tx.get("order_amount", 0) or tx.get("sale_amount", 0) or 0),
            "commission_amount": float(tx.get("commission_amount", 0) or tx.get("commission", 0) or 0),
            "status": normalized_status,
            "raw_status": raw_status,
            "currency": tx.get("currency", "USD"),
            "affiliate_account_id": affiliate_account_id,
            "user_id": user_id,
        }
        
        # Upsert（使用唯一约束：platform + transaction_id）
        transaction_id_str = str(tx["transaction_id"]).strip()
        transaction = self.db.query(AffiliateTransaction).filter(
            AffiliateTransaction.platform == platform,
            AffiliateTransaction.transaction_id == transaction_id_str
        ).first()
        
        if transaction:
            # 更新现有记录（状态允许覆盖：pending → approved / rejected）
            # 对于佣金，如果新值更大则更新（可能是状态变化导致的佣金增加）
            # 如果原佣金为0但新佣金大于0，则更新（可能是佣金字段解析修复）
            for key, value in data.items():
                if key not in ["platform", "transaction_id"]:  # 不更新唯一键
                    if key == "commission_amount":
                        # 佣金更新策略：
                        # 1. 如果原佣金为0但新佣金>0，更新（修复佣金解析问题）
                        # 2. 如果新佣金更大，更新（状态变化可能导致佣金增加）
                        # 3. 否则保持原佣金（避免重复订单覆盖正确的佣金）
                        old_commission = getattr(transaction, key, 0) or 0
                        new_commission = float(value or 0)
                        if (old_commission == 0 and new_commission > 0) or (new_commission > old_commission):
                            setattr(transaction, key, new_commission)
                        # 否则保持原佣金不变
                    else:
                        setattr(transaction, key, value)
            transaction.updated_at = datetime.now()
        else:
            # 创建新记录
            try:
                transaction = AffiliateTransaction(**data)
                self.db.add(transaction)
                # 立即刷新，检查是否有唯一约束错误
                self.db.flush()
            except Exception as e:
                # 如果出现唯一约束错误，可能是并发插入，尝试再次查询
                if "UNIQUE constraint" in str(e) or "IntegrityError" in str(type(e).__name__):
                    logger.warning(f"[UnifiedTransactionService] 检测到唯一约束冲突，尝试重新查询: platform={platform}, transaction_id={transaction_id_str}")
                    transaction = self.db.query(AffiliateTransaction).filter(
                        AffiliateTransaction.platform == platform,
                        AffiliateTransaction.transaction_id == transaction_id_str
                    ).first()
                    if transaction:
                        # 更新现有记录
                        for key, value in data.items():
                            if key not in ["platform", "transaction_id"]:
                                setattr(transaction, key, value)
                        transaction.updated_at = datetime.now()
                    else:
                        # 如果还是找不到，重新抛出异常
                        raise
                else:
                    raise
        
        # 如果是拒付状态，保存拒付详情
        if normalized_status == "rejected":
            self.save_rejection_detail(tx, platform, transaction)
        
        return transaction
    
    def save_rejection_detail(
        self,
        tx: Dict,
        platform: str,
        transaction: AffiliateTransaction
    ) -> AffiliateRejection:
        """
        拒付详情入库
        
        只有 status = rejected 的交易才会进这张表
        
        Args:
            tx: 交易数据字典
            platform: 平台代码
            transaction: AffiliateTransaction对象
        
        Returns:
            保存的AffiliateRejection对象
        """
        # 解析拒付时间
        reject_time = tx.get("reject_time") or tx.get("transaction_time")
        if isinstance(reject_time, str):
            try:
                reject_time = datetime.fromisoformat(reject_time.replace('Z', '+00:00'))
            except:
                try:
                    reject_time = datetime.strptime(reject_time, "%Y-%m-%d %H:%M:%S")
                except:
                    reject_time = datetime.strptime(reject_time, "%Y-%m-%d")
        elif not isinstance(reject_time, datetime):
            reject_time = transaction.transaction_time
        
        txid = str(tx["transaction_id"]).strip()
        data = {
            "platform": platform,
            "transaction_id": txid,
            "commission_amount": float(tx.get("commission_amount", 0) or tx.get("commission", 0) or 0),
            "reject_reason": tx.get("reject_reason") or tx.get("rejection_reason") or tx.get("reason"),
            "reject_time": reject_time,
            # tx 里可能包含 datetime（例如 transaction_time），需要 default=str 避免序列化失败
            "raw_payload": json.dumps(tx, ensure_ascii=False, default=str) if tx else None,
        }
        
        # Upsert
        rejection = self.db.query(AffiliateRejection).filter(
            AffiliateRejection.platform == platform,
            AffiliateRejection.transaction_id == txid
        ).first()
        
        if rejection:
            # 更新现有记录
            for key, value in data.items():
                if key not in ["platform", "transaction_id"]:
                    setattr(rejection, key, value)
        else:
            # 创建新记录
            # 注意：同一次同步中可能遇到重复的 rejected 交易（或同一个 tx 被重复处理），
            # 这会导致唯一约束(platform, transaction_id)冲突。
            # 使用 savepoint + flush 做“乐观插入”，冲突则回查并更新。
            rejection = AffiliateRejection(**data)
            try:
                with self.db.begin_nested():
                    self.db.add(rejection)
                    self.db.flush()
            except IntegrityError:
                # 已存在（可能是本次事务里其他循环刚插入），回查并更新
                existing = self.db.query(AffiliateRejection).filter(
                    AffiliateRejection.platform == platform,
                    AffiliateRejection.transaction_id == txid
                ).first()
                if existing:
                    for key, value in data.items():
                        if key not in ["platform", "transaction_id"]:
                            setattr(existing, key, value)
                    rejection = existing
                else:
                    # 理论上不会发生，保守起见继续抛出
                    raise
        
        return rejection
    
    def get_last_success_time(self, platform: str) -> Optional[datetime]:
        """
        获取平台最后成功同步时间
        
        用于增量拉取：只拉 transaction_time >= last_success_time - 3 days
        
        Args:
            platform: 平台代码
        
        Returns:
            最后成功同步时间，如果没有则返回None
        """
        last_transaction = self.db.query(AffiliateTransaction).filter(
            AffiliateTransaction.platform == platform
        ).order_by(AffiliateTransaction.transaction_time.desc()).first()
        
        if last_transaction:
            # 返回3天前的时间，确保不遗漏数据
            return last_transaction.transaction_time - timedelta(days=3)
        return None
    
    def batch_save_transactions(
        self,
        transactions: List[Dict],
        platform: str,
        affiliate_account_id: Optional[int] = None,
        user_id: Optional[int] = None
    ) -> Dict:
        """
        批量保存交易数据
        
        Args:
            transactions: 交易数据列表
            platform: 平台代码
            affiliate_account_id: 联盟账号ID（可选）
            user_id: 用户ID（可选）
        
        Returns:
            保存结果统计
        """
        saved_count = 0
        updated_count = 0
        rejected_count = 0
        
        for tx in transactions:
            try:
                transaction = self.normalize_and_save(
                    tx,
                    platform,
                    affiliate_account_id,
                    user_id
                )
                
                if transaction.id:  # 新创建的记录
                    saved_count += 1
                else:  # 更新的记录
                    updated_count += 1
                
                if transaction.status == "rejected":
                    rejected_count += 1
                    
            except Exception as e:
                logger.error(f"保存交易数据失败: {e}, 交易: {tx}")
                continue
        
        self.db.commit()
        
        return {
            "saved_count": saved_count,
            "updated_count": updated_count,
            "rejected_count": rejected_count,
            "total_count": len(transactions)
        }

