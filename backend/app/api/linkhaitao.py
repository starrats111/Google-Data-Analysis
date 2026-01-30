"""
LinkHaitao API 接口
用于同步 LinkHaitao 平台的佣金和订单数据
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
from app.services.linkhaitao_service import LinkHaitaoService

router = APIRouter(prefix="/api/linkhaitao", tags=["linkhaitao"])


class SyncCommissionsOrdersRequest(BaseModel):
    """同步佣金和订单请求"""
    account_id: int  # 联盟账号ID
    begin_date: str  # 开始日期 YYYY-MM-DD
    end_date: str  # 结束日期 YYYY-MM-DD
    token: Optional[str] = None  # 如果提供，使用此token；否则从账号配置中获取


@router.post("/sync-commissions-orders")
async def sync_commissions_orders(
    request: SyncCommissionsOrdersRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    同步 LinkHaitao 佣金和订单数据
    
    需要：
    1. 在联盟账号的 notes 字段中存储 token（格式：{"linkhaitao_token": "your_token"}）
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
    
    # 检查平台是否为 LinkHaitao
    platform_code = account.platform.platform_code.lower()
    if platform_code not in ['linkhaitao', 'link-haitao']:
        raise HTTPException(status_code=400, detail="该账号不是 LinkHaitao 平台")
    
    # 获取 token
    token = request.token
    if not token:
        # 尝试从账号的 notes 字段获取 token
        import json
        try:
            if account.notes:
                notes_data = json.loads(account.notes)
                token = notes_data.get("linkhaitao_token") or notes_data.get("token")
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
        service = LinkHaitaoService(token=token)
        result = service.sync_commissions_and_orders(
            request.begin_date,
            request.end_date
        )
        
        if not result.get("success"):
            raise HTTPException(status_code=500, detail=result.get("message", "同步失败"))
        
        return {
            "success": True,
            "message": f"成功同步 {result.get('total_commission_records', 0)} 条佣金记录和 {result.get('total_orders', 0)} 条订单",
            "total_commission_records": result.get("total_commission_records", 0),
            "total_orders": result.get("total_orders", 0),
            "total_commission": result.get("total_commission", 0),
            "data": result.get("data", {})
        }
        
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
    测试 LinkHaitao API 连接
    
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
    
    # 检查平台
    platform_code = account.platform.platform_code.lower()
    if platform_code not in ['linkhaitao', 'link-haitao']:
        raise HTTPException(status_code=400, detail="该账号不是 LinkHaitao 平台")
    
    # 获取 token
    if not token:
        import json
        try:
            if account.notes:
                notes_data = json.loads(account.notes)
                token = notes_data.get("linkhaitao_token") or notes_data.get("token")
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
        
        service = LinkHaitaoService(token=token)
        result = service.test_connection()
        
        return result
        
    except Exception as e:
        return {
            "success": False,
            "message": f"连接失败: {str(e)}"
        }


@router.post("/sync-commissions-orders")
async def sync_commissions_orders(
    account_id: int,
    begin_date: str,
    end_date: str,
    token: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    同步 LinkHaitao 佣金和订单数据
    
    Args:
        account_id: 联盟账号ID
        begin_date: 开始日期，格式 YYYY-MM-DD
        end_date: 结束日期，格式 YYYY-MM-DD
        token: API Token（可选，如果不提供则从账号备注中读取）
    """
    # 获取账号信息
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == account_id,
        AffiliateAccount.user_id == current_user.id
    ).first()
    
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    
    # 检查平台是否为 LinkHaitao
    if not account.platform.platform_code.lower() in ['linkhaitao', 'link-haitao']:
        raise HTTPException(status_code=400, detail="该账号不是 LinkHaitao 平台")
    
    # 获取 Token
    if not token:
        # 从账号备注中读取 token
        import json
        try:
            if account.notes:
                notes_data = json.loads(account.notes)
                token = notes_data.get("linkhaitao_token") or notes_data.get("token")
        except:
            pass
    
    if not token:
        raise HTTPException(status_code=400, detail="未提供 API Token，请在账号备注中配置或手动输入")
    
    # 验证日期格式
    try:
        datetime.strptime(begin_date, "%Y-%m-%d")
        datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，请使用 YYYY-MM-DD 格式")
    
    # 同步数据
    service = LinkHaitaoService(token)
    result = service.sync_commissions_and_orders(begin_date, end_date)
    
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "同步失败"))
    
    return {
        "success": True,
        "message": "同步成功",
        "total_commission": result.get("total_commission", 0),
        "total_orders": result.get("total_orders", 0),
        "total_commission_records": result.get("total_commission_records", 0),
        "data": result.get("data", {})
    }

