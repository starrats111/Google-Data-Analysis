"""
平台数据API
用于查看和管理平台数据
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from typing import Optional, List
from datetime import date, datetime
from pydantic import BaseModel
import logging

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/platform-data", tags=["platform-data"])


class PlatformDataResponse(BaseModel):
    """平台数据响应"""
    id: int
    affiliate_account_id: int
    account_name: str
    platform_name: str
    date: str
    commission: float
    orders: int
    order_days_this_week: int
    last_sync_at: Optional[str]
    
    class Config:
        from_attributes = True


@router.get("/", response_model=List[PlatformDataResponse])
async def get_platform_data(
    platform_id: Optional[int] = Query(None, description="平台ID"),
    account_id: Optional[int] = Query(None, description="账号ID"),
    begin_date: Optional[str] = Query(None, description="开始日期 YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="结束日期 YYYY-MM-DD"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取平台数据
    
    支持按平台、账号、日期范围筛选
    """
    try:
        # 使用 joinedload 预加载关联数据，避免 N+1 查询问题
        query = db.query(PlatformData).options(
            joinedload(PlatformData.affiliate_account).joinedload(AffiliateAccount.platform)
        ).filter(
            PlatformData.user_id == current_user.id
        )
        
        # 权限检查：员工只能查看自己的数据
        if current_user.role == "employee":
            query = query.filter(PlatformData.user_id == current_user.id)
        
        # 筛选条件
        if platform_id:
            query = query.join(AffiliateAccount).filter(AffiliateAccount.platform_id == platform_id)
        
        if account_id:
            query = query.filter(PlatformData.affiliate_account_id == account_id)
        
        if begin_date:
            try:
                begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
                query = query.filter(PlatformData.date >= begin)
            except ValueError:
                raise HTTPException(status_code=400, detail="开始日期格式错误")
        
        if end_date:
            try:
                end = datetime.strptime(end_date, "%Y-%m-%d").date()
                query = query.filter(PlatformData.date <= end)
            except ValueError:
                raise HTTPException(status_code=400, detail="结束日期格式错误")
        
        # 按日期倒序排列
        query = query.order_by(PlatformData.date.desc(), PlatformData.affiliate_account_id)
        
        results = query.all()
        
        # 转换为响应格式
        response_data = []
        for item in results:
            try:
                account = item.affiliate_account
                if not account:
                    logger.warning(f"平台数据 {item.id} 的关联账号不存在，跳过")
                    continue
                
                platform_name = account.platform.platform_name if account.platform else "未知平台"
                
                response_data.append({
                    "id": item.id,
                    "affiliate_account_id": item.affiliate_account_id,
                    "account_name": account.account_name,
                    "platform_name": platform_name,
                    "date": item.date.isoformat(),
                    "commission": float(item.commission or 0.0),
                    "orders": int(item.orders or 0),
                    "order_days_this_week": int(item.order_days_this_week or 0),
                    "last_sync_at": item.last_sync_at.isoformat() if item.last_sync_at else None
                })
            except Exception as e:
                logger.error(f"处理平台数据 {item.id} 时出错: {e}", exc_info=True)
                continue
        
        return response_data
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取平台数据失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"查询失败: {str(e)}")


