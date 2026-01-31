"""
联盟交易数据API
提供4个核心指标查询和拒付详情页
"""
from typing import Optional, List
from datetime import datetime, date
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, or_
from decimal import Decimal

from app.database import get_db
from app.middleware.auth import get_current_user, get_current_manager
from app.models.user import User
from app.models.affiliate_transaction import AffiliateTransaction, AffiliateRejection
from app.schemas.affiliate_transaction import (
    TransactionSummaryResponse,
    RejectionDetailResponse
)

router = APIRouter(prefix="/api/affiliate-transactions", tags=["affiliate-transactions"])


@router.get("/summary", response_model=TransactionSummaryResponse)
async def get_transaction_summary(
    start_date: date = Query(..., description="开始日期"),
    end_date: date = Query(..., description="结束日期"),
    platform: Optional[str] = Query(None, description="平台代码（可选）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取4个核心指标
    
    1. 订单数
    2. 交易金额（GMV）
    3. 已确认佣金
    4. 拒付佣金
    """
    # 构建查询条件
    query = db.query(AffiliateTransaction).filter(
        AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
        AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
    )
    
    # 权限控制：员工只能看自己的数据
    if current_user.role == "employee":
        query = query.filter(AffiliateTransaction.user_id == current_user.id)
    
    # 平台筛选
    if platform:
        query = query.filter(AffiliateTransaction.platform == platform)
    
    # 指标1: 订单数
    total_orders = query.count()
    
    # 指标2: 交易金额（GMV）
    gmv_result = query.with_entities(
        func.sum(AffiliateTransaction.order_amount).label("gmv")
    ).first()
    gmv = float(gmv_result[0] or 0)
    
    # 指标3: 已确认佣金
    approved_commission_result = query.filter(
        AffiliateTransaction.status == "approved"
    ).with_entities(
        func.sum(AffiliateTransaction.commission_amount).label("commission")
    ).first()
    approved_commission = float(approved_commission_result[0] or 0)
    
    # 指标4: 拒付佣金
    rejected_commission_result = query.filter(
        AffiliateTransaction.status == "rejected"
    ).with_entities(
        func.sum(AffiliateTransaction.commission_amount).label("rejected_commission")
    ).first()
    rejected_commission = float(rejected_commission_result[0] or 0)
    
    return {
        "total_orders": total_orders,
        "gmv": round(gmv, 2),
        "approved_commission": round(approved_commission, 2),
        "rejected_commission": round(rejected_commission, 2),
        "start_date": start_date,
        "end_date": end_date,
        "platform": platform
    }


@router.get("/rejections", response_model=List[RejectionDetailResponse])
async def get_rejection_details(
    start_date: date = Query(..., description="开始日期"),
    end_date: date = Query(..., description="结束日期"),
    platform: Optional[str] = Query(None, description="平台代码（可选）"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取拒付详情页数据
    
    点击「拒付佣金」→ 跳转拒付详情页
    显示：订单级明细、拒付原因、商家/平台/时间
    """
    # 构建查询条件
    query = db.query(
        AffiliateTransaction.platform,
        AffiliateTransaction.merchant,
        AffiliateTransaction.transaction_id,
        AffiliateTransaction.transaction_time,
        AffiliateTransaction.order_amount,
        AffiliateRejection.commission_amount,
        AffiliateRejection.reject_reason,
        AffiliateRejection.reject_time
    ).join(
        AffiliateRejection,
        and_(
            AffiliateTransaction.platform == AffiliateRejection.platform,
            AffiliateTransaction.transaction_id == AffiliateRejection.transaction_id
        )
    ).filter(
        AffiliateTransaction.transaction_time >= datetime.combine(start_date, datetime.min.time()),
        AffiliateTransaction.transaction_time <= datetime.combine(end_date, datetime.max.time())
    )
    
    # 权限控制：员工只能看自己的数据
    if current_user.role == "employee":
        query = query.filter(AffiliateTransaction.user_id == current_user.id)
    
    # 平台筛选
    if platform:
        query = query.filter(AffiliateTransaction.platform == platform)
    
    # 按拒付时间倒序排列
    results = query.order_by(AffiliateRejection.reject_time.desc()).all()
    
    return [
        {
            "platform": r.platform,
            "merchant": r.merchant,
            "transaction_id": r.transaction_id,
            "transaction_time": r.transaction_time,
            "order_amount": float(r.order_amount or 0),
            "commission_amount": float(r.commission_amount or 0),
            "reject_reason": r.reject_reason,
            "reject_time": r.reject_time
        }
        for r in results
    ]

