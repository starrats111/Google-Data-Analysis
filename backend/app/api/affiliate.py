"""
联盟账号管理API
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user, get_current_manager
from app.models.user import User
from app.models.affiliate_account import AffiliatePlatform, AffiliateAccount
from app.schemas.affiliate import (
    AffiliatePlatformCreate,
    AffiliatePlatformResponse,
    AffiliateAccountCreate,
    AffiliateAccountUpdate,
    AffiliateAccountResponse
)

router = APIRouter(prefix="/api/affiliate", tags=["affiliate"])


@router.get("/platforms", response_model=List[AffiliatePlatformResponse])
async def get_platforms(db: Session = Depends(get_db)):
    """获取所有联盟平台列表"""
    platforms = db.query(AffiliatePlatform).all()
    return platforms


@router.post("/platforms", response_model=AffiliatePlatformResponse, status_code=status.HTTP_201_CREATED)
async def create_platform(
    platform_data: AffiliatePlatformCreate,
    current_user: User = Depends(get_current_manager),  # 仅经理可以创建平台
    db: Session = Depends(get_db)
):
    """创建联盟平台（仅经理可用）"""
    # 检查平台名称是否已存在
    existing = db.query(AffiliatePlatform).filter(
        AffiliatePlatform.platform_name == platform_data.platform_name
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="平台名称已存在")
    
    # 检查平台代码是否已存在
    existing_code = db.query(AffiliatePlatform).filter(
        AffiliatePlatform.platform_code == platform_data.platform_code
    ).first()
    if existing_code:
        raise HTTPException(status_code=400, detail="平台代码已存在")
    
    # 创建平台
    platform = AffiliatePlatform(
        platform_name=platform_data.platform_name,
        platform_code=platform_data.platform_code,
        description=platform_data.description
    )
    db.add(platform)
    db.commit()
    db.refresh(platform)
    return platform


@router.get("/accounts/by-employees")
async def get_accounts_by_employees(
    current_user: User = Depends(get_current_manager),  # 仅经理可用
    db: Session = Depends(get_db)
):
    """获取按员工分组的联盟账号信息（经理专用）"""
    from app.models.user import UserRole
    
    # 获取所有员工
    employees = db.query(User).filter(User.role == UserRole.EMPLOYEE).all()
    
    result = []
    for employee in employees:
        # 获取该员工的所有账号
        accounts = db.query(AffiliateAccount).filter(
            AffiliateAccount.user_id == employee.id
        ).all()
        
        # 统计信息
        total_accounts = len(accounts)
        active_accounts = len([acc for acc in accounts if acc.is_active])
        
        # 按平台分组
        platforms_info = {}
        for account in accounts:
            platform_name = account.platform.platform_name
            if platform_name not in platforms_info:
                platforms_info[platform_name] = {
                    "platform_id": account.platform.id,
                    "platform_name": platform_name,
                    "accounts": []
                }
            platforms_info[platform_name]["accounts"].append({
                "id": account.id,
                "account_name": account.account_name,
                "account_code": account.account_code,
                "email": account.email,
                "is_active": account.is_active,
                "notes": account.notes,
                "created_at": account.created_at.isoformat() if account.created_at else None
            })
        
        result.append({
            "employee_id": employee.employee_id,
            "employee_username": employee.username,
            "total_accounts": total_accounts,
            "active_accounts": active_accounts,
            "platforms": list(platforms_info.values())
        })
    
    return result


@router.get("/accounts", response_model=List[AffiliateAccountResponse])
async def get_accounts(
    platform_id: Optional[int] = None,
    is_active: Optional[bool] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取联盟账号列表"""
    query = db.query(AffiliateAccount)
    
    # 权限控制：员工只能看自己的账号
    if current_user.role == "employee":
        query = query.filter(AffiliateAccount.user_id == current_user.id)
    
    # 筛选条件
    if platform_id:
        query = query.filter(AffiliateAccount.platform_id == platform_id)
    if is_active is not None:
        query = query.filter(AffiliateAccount.is_active == is_active)
    
    accounts = query.all()
    return accounts


@router.post("/accounts", response_model=AffiliateAccountResponse, status_code=status.HTTP_201_CREATED)
async def create_account(
    account_data: AffiliateAccountCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """创建联盟账号"""
    # 验证平台是否存在
    platform = db.query(AffiliatePlatform).filter(
        AffiliatePlatform.id == account_data.platform_id
    ).first()
    if not platform:
        raise HTTPException(status_code=404, detail="联盟平台不存在")
    
    # 检查是否已存在相同账号名
    existing = db.query(AffiliateAccount).filter(
        AffiliateAccount.user_id == current_user.id,
        AffiliateAccount.platform_id == account_data.platform_id,
        AffiliateAccount.account_name == account_data.account_name
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="该平台下已存在相同名称的账号")
    
    # 创建账号
    account = AffiliateAccount(
        user_id=current_user.id,
        platform_id=account_data.platform_id,
        account_name=account_data.account_name,
        account_code=account_data.account_code,
        email=account_data.email,
        is_active=account_data.is_active,
        notes=account_data.notes
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


@router.put("/accounts/{account_id}", response_model=AffiliateAccountResponse)
async def update_account(
    account_id: int,
    account_data: AffiliateAccountUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """更新联盟账号"""
    account = db.query(AffiliateAccount).filter(AffiliateAccount.id == account_id).first()
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    
    # 权限控制：只能更新自己的账号
    if account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权修改此账号")
    
    # 更新字段
    if account_data.account_name is not None:
        account.account_name = account_data.account_name
    if account_data.account_code is not None:
        account.account_code = account_data.account_code
    if account_data.email is not None:
        account.email = account_data.email
    if account_data.is_active is not None:
        account.is_active = account_data.is_active
    if account_data.notes is not None:
        account.notes = account_data.notes
    
    db.commit()
    db.refresh(account)
    return account


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除联盟账号"""
    account = db.query(AffiliateAccount).filter(AffiliateAccount.id == account_id).first()
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    
    # 权限控制：只能删除自己的账号
    if account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权删除此账号")
    
    # 检查是否有关联数据
    from app.models.data_upload import DataUpload
    from app.models.analysis_result import AnalysisResult
    
    uploads_count = db.query(DataUpload).filter(
        DataUpload.affiliate_account_id == account_id
    ).count()
    
    results_count = db.query(AnalysisResult).filter(
        AnalysisResult.affiliate_account_id == account_id
    ).count()
    
    if uploads_count > 0 or results_count > 0:
        raise HTTPException(
            status_code=400,
            detail="该账号有关联的数据上传或分析结果，无法删除。请先停用账号。"
        )
    
    db.delete(account)
    db.commit()
    return None


@router.post("/accounts/{account_id}/sync")
async def sync_account_data(
    account_id: int,
    request_data: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    同步平台账号数据（通用接口，支持所有平台）
    
    Args:
        account_id: 联盟账号ID
        request_data: 请求数据，包含 begin_date, end_date, token
    """
    # 从请求体中提取参数
    begin_date = request_data.get("begin_date")
    end_date = request_data.get("end_date")
    token = request_data.get("token")
    
    if not begin_date or not end_date:
        raise HTTPException(status_code=400, detail="缺少必要参数: begin_date 和 end_date")
    from app.services.platform_data_sync import PlatformDataSyncService
    
    # 检查账号是否存在
    account = db.query(AffiliateAccount).filter(AffiliateAccount.id == account_id).first()
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    
    # 权限控制：只能同步自己的账号
    if account.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="无权同步此账号")
    
    # 如果提供了token，更新到账号备注中
    if token:
        import json
        notes_data = {}
        if account.notes:
            try:
                notes_data = json.loads(account.notes)
            except:
                pass
        
        # 根据平台代码确定token字段名
        platform_code = account.platform.platform_code.lower()
        if platform_code == "collabglow":
            notes_data["collabglow_token"] = token
        elif platform_code in ["linkhaitao", "link-haitao"]:
            notes_data["linkhaitao_token"] = token
        else:
            # 通用token字段
            notes_data["api_token"] = token
        
        account.notes = json.dumps(notes_data)
        db.commit()
    
    # 调用同步服务
    sync_service = PlatformDataSyncService(db)
    result = sync_service.sync_account_data(account_id, begin_date, end_date)
    
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "同步失败"))
    
    return result




