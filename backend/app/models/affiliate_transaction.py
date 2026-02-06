"""
联盟交易数据模型
统一存储8个平台的交易数据：CG / RW / Linkhaitao / PartnerBoost / Linkbux / Partnermatic / BrandSparkHub / CreatorFlare
"""
from sqlalchemy import Column, Integer, String, DateTime, Numeric, Text, UniqueConstraint, Index
from sqlalchemy.sql import func
from app.database import Base


class AffiliateTransaction(Base):
    """
    交易主表（最重要）
    
    解决：
    - 订单数
    - 交易金额（GMV）
    - 已确认佣金
    - 拒付佣金（全部从这里算）
    """
    __tablename__ = "affiliate_transactions"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 平台和商户信息
    platform = Column(String(32), nullable=False, index=True)  # CG / RW / Linkhaitao / ...
    merchant = Column(String(128), nullable=True, index=True)
    merchant_id = Column(String(32), nullable=True, index=True)  # 平台商家ID(MID)，如 154253
    
    # 交易标识
    transaction_id = Column(String(128), nullable=False)  # 平台唯一交易ID
    transaction_time = Column(DateTime(timezone=True), nullable=False, index=True)
    
    # 金额信息
    order_amount = Column(Numeric(12, 2), default=0, nullable=False)  # GMV
    commission_amount = Column(Numeric(12, 2), default=0, nullable=False)  # 原始佣金
    currency = Column(String(8), default="USD", nullable=False)
    
    # 状态信息
    status = Column(String(16), nullable=False, index=True)  # approved / pending / rejected
    raw_status = Column(String(32), nullable=True)  # 平台原始状态
    
    # 关联信息（可选，用于关联到账号）
    affiliate_account_id = Column(Integer, nullable=True, index=True)
    user_id = Column(Integer, nullable=True, index=True)
    
    # 元数据
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    __table_args__ = (
        UniqueConstraint("platform", "transaction_id", name="uq_affiliate_transaction_platform_txid"),
        Index("idx_affiliate_transaction_platform_time", "platform", "transaction_time"),
        Index("idx_affiliate_transaction_status_time", "status", "transaction_time"),
        Index("idx_affiliate_transaction_user_time", "user_id", "transaction_time"),
    )
    
    # 关联关系 - 通过 platform 和 transaction_id 关联，不是外键
    # 注意：由于没有外键，这个关系可能在某些情况下无法自动加载
    # 如果需要使用，建议手动查询而不是依赖关系
    # rejection = relationship(
    #     "AffiliateRejection",
    #     back_populates="transaction",
    #     uselist=False,
    #     primaryjoin="and_(AffiliateTransaction.platform == AffiliateRejection.platform, "
    #                 "AffiliateTransaction.transaction_id == AffiliateRejection.transaction_id)"
    # )


class AffiliateRejection(Base):
    """
    拒付详情表（点击用）
    
    只有 status = rejected 的交易才会进这张表
    """
    __tablename__ = "affiliate_rejections"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # 关联信息
    platform = Column(String(32), nullable=False, index=True)
    transaction_id = Column(String(128), nullable=False, index=True)
    
    # 拒付信息
    commission_amount = Column(Numeric(12, 2), default=0, nullable=False)
    reject_reason = Column(Text, nullable=True)  # 拒付原因
    reject_time = Column(DateTime(timezone=True), nullable=True, index=True)
    
    # 原始数据（便于追责）
    raw_payload = Column(Text, nullable=True)  # JSON格式存储原始API返回
    
    # 元数据
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    __table_args__ = (
        UniqueConstraint("platform", "transaction_id", name="uq_affiliate_rejection_platform_txid"),
        Index("idx_affiliate_rejection_time", "reject_time"),
    )
    
    # 关联关系 - 通过 platform 和 transaction_id 关联，不是外键
    # 注意：由于没有外键，这个关系可能在某些情况下无法自动加载
    # 如果需要使用，建议手动查询而不是依赖关系
    # transaction = relationship(
    #     "AffiliateTransaction",
    #     back_populates="rejection",
    #     primaryjoin="and_(AffiliateRejection.platform == AffiliateTransaction.platform, "
    #                 "AffiliateRejection.transaction_id == AffiliateTransaction.transaction_id)"
    # )

