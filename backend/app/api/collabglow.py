"""
CollabGlow API 接口
用于同步 CollabGlow 平台的佣金数据
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from datetime import datetime, timedelta

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.affiliate_account import AffiliateAccount
from app.services.collabglow_service import CollabGlowService

router = APIRouter(prefix="/api/collabglow", tags=["collabglow"])


class SyncCommissionsRequest(BaseModel):
    """同步佣金请求"""
    account_id: int  # 联盟账号ID
    begin_date: str  # 开始日期 YYYY-MM-DD
    end_date: str  # 结束日期 YYYY-MM-DD
    token: Optional[str] = None  # 如果提供，使用此token；否则从账号配置中获取


class SyncCommissionsResponse(BaseModel):
    """同步佣金响应"""
    success: bool
    message: str
    total_records: int
    total_commission: float
    data: list


@router.post("/sync-commissions", response_model=SyncCommissionsResponse)
async def sync_commissions(
    request: SyncCommissionsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    同步 CollabGlow 佣金数据
    
    需要：
    1. 在联盟账号的 notes 字段中存储 token（格式：{"collabglow_token": "your_token"}）
    2. 或者直接在请求中提供 token
    """
    # 获取联盟账号
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == request.account_id
    ).first()
    
    if not account:
        raise HTTPException(status_code=404, detail="联盟账号不存在")
    
    # 权限检查：员工只能同步自己的账号
    if current_user.role == "employee" and account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此账号")
    
    # 获取 token
    token = request.token
    if not token:
        # 尝试从账号的 notes 字段获取 token
        import json
        try:
            if account.notes:
                notes_data = json.loads(account.notes)
                token = notes_data.get("collabglow_token")
        except:
            pass
        
        if not token:
            raise HTTPException(
                status_code=400, 
                detail="未提供 token，请在请求中提供 token 或在账号备注中配置"
            )
    
    # 验证日期格式
    try:
        datetime.strptime(request.begin_date, "%Y-%m-%d")
        datetime.strptime(request.end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    # 创建服务并同步数据
    try:
        service = CollabGlowService(token=token)
        result = service.sync_commissions(
            request.begin_date,
            request.end_date
        )
        
        commissions = result.get("data", {}).get("list", [])
        total_commission = sum(c.get("sale_commission", 0) for c in commissions)
        
        return SyncCommissionsResponse(
            success=True,
            message=f"成功同步 {len(commissions)} 条佣金记录",
            total_records=len(commissions),
            total_commission=total_commission,
            data=commissions
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"同步失败: {str(e)}")


@router.get("/test-connection")
async def test_connection(
    account_id: int,
    token: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    测试 CollabGlow API 连接
    
    使用最近7天的数据测试
    """
    # 获取联盟账号
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == account_id
    ).first()
    
    if not account:
        raise HTTPException(status_code=404, detail="联盟账号不存在")
    
    # 权限检查
    if current_user.role == "employee" and account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权访问此账号")
    
    # 获取 token
    if not token:
        import json
        try:
            if account.notes:
                notes_data = json.loads(account.notes)
                token = notes_data.get("collabglow_token")
        except:
            pass
        
        if not token:
            raise HTTPException(
                status_code=400, 
                detail="未提供 token"
            )
    
    # 测试连接
    try:
        end_date = datetime.now()
        begin_date = end_date - timedelta(days=7)
        
        service = CollabGlowService(token=token)
        result = service.get_commission_data(
            begin_date.strftime("%Y-%m-%d"),
            end_date.strftime("%Y-%m-%d")
        )
        
        commissions = service.extract_commission_data(result)
        
        return {
            "success": True,
            "message": "连接成功",
            "test_period": f"{begin_date.strftime('%Y-%m-%d')} ~ {end_date.strftime('%Y-%m-%d')}",
            "records_found": len(commissions),
            "sample_data": commissions[:3] if commissions else []
        }
        
    except Exception as e:
        return {
            "success": False,
            "message": f"连接失败: {str(e)}"
        }


