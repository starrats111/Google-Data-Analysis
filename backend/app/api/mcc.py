"""
MCC管理API
用于管理Google MCC账号和数据聚合
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel
from datetime import date, datetime

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData
from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount

router = APIRouter(prefix="/api/mcc", tags=["mcc"])


class MccAccountCreate(BaseModel):
    """创建MCC账号请求"""
    mcc_id: str
    mcc_name: str
    email: str
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    refresh_token: Optional[str] = None


class MccAccountUpdate(BaseModel):
    """更新MCC账号请求"""
    mcc_name: Optional[str] = None
    email: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    refresh_token: Optional[str] = None
    is_active: Optional[bool] = None


class MccAccountResponse(BaseModel):
    """MCC账号响应"""
    id: int
    mcc_id: str
    mcc_name: str
    email: str
    is_active: bool
    created_at: str
    updated_at: Optional[str]
    data_count: int  # 该MCC的数据条数
    
    class Config:
        from_attributes = True


@router.post("/accounts", response_model=MccAccountResponse)
async def create_mcc_account(
    mcc_data: MccAccountCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """创建MCC账号"""
    # 检查MCC ID是否已存在
    existing = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.mcc_id == mcc_data.mcc_id
    ).first()
    
    if existing:
        raise HTTPException(status_code=400, detail="MCC ID已存在")
    
    # 创建MCC账号
    mcc_account = GoogleMccAccount(
        user_id=current_user.id,
        mcc_id=mcc_data.mcc_id,
        mcc_name=mcc_data.mcc_name,
        email=mcc_data.email,
        client_id=mcc_data.client_id,
        client_secret=mcc_data.client_secret,
        refresh_token=mcc_data.refresh_token,
        is_active=True
    )
    
    db.add(mcc_account)
    db.commit()
    db.refresh(mcc_account)
    
    # 获取数据条数
    data_count = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.mcc_id == mcc_account.id
    ).count()
    
    return {
        "id": mcc_account.id,
        "mcc_id": mcc_account.mcc_id,
        "mcc_name": mcc_account.mcc_name,
        "email": mcc_account.email,
        "is_active": mcc_account.is_active,
        "created_at": mcc_account.created_at.isoformat(),
        "updated_at": mcc_account.updated_at.isoformat() if mcc_account.updated_at else None,
        "data_count": data_count
    }


@router.get("/accounts", response_model=List[MccAccountResponse])
async def get_mcc_accounts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取MCC账号列表"""
    query = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.user_id == current_user.id
    )
    
    # 权限检查：员工只能查看自己的MCC
    if current_user.role == "employee":
        query = query.filter(GoogleMccAccount.user_id == current_user.id)
    
    mcc_accounts = query.order_by(GoogleMccAccount.created_at.desc()).all()
    
    # 获取每个MCC的数据条数
    result = []
    for mcc in mcc_accounts:
        data_count = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.mcc_id == mcc.id
        ).count()
        
        result.append({
            "id": mcc.id,
            "mcc_id": mcc.mcc_id,
            "mcc_name": mcc.mcc_name,
            "email": mcc.email,
            "is_active": mcc.is_active,
            "created_at": mcc.created_at.isoformat(),
            "updated_at": mcc.updated_at.isoformat() if mcc.updated_at else None,
            "data_count": data_count
        })
    
    return result


@router.get("/accounts/{mcc_id}", response_model=MccAccountResponse)
async def get_mcc_account(
    mcc_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取单个MCC账号详情"""
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    data_count = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.mcc_id == mcc_account.id
    ).count()
    
    return {
        "id": mcc_account.id,
        "mcc_id": mcc_account.mcc_id,
        "mcc_name": mcc_account.mcc_name,
        "email": mcc_account.email,
        "is_active": mcc_account.is_active,
        "created_at": mcc_account.created_at.isoformat(),
        "updated_at": mcc_account.updated_at.isoformat() if mcc_account.updated_at else None,
        "data_count": data_count
    }


@router.put("/accounts/{mcc_id}", response_model=MccAccountResponse)
async def update_mcc_account(
    mcc_id: int,
    mcc_data: MccAccountUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """更新MCC账号"""
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    # 更新字段
    if mcc_data.mcc_name is not None:
        mcc_account.mcc_name = mcc_data.mcc_name
    if mcc_data.email is not None:
        mcc_account.email = mcc_data.email
    if mcc_data.client_id is not None:
        mcc_account.client_id = mcc_data.client_id
    if mcc_data.client_secret is not None:
        mcc_account.client_secret = mcc_data.client_secret
    if mcc_data.refresh_token is not None:
        mcc_account.refresh_token = mcc_data.refresh_token
    if mcc_data.is_active is not None:
        mcc_account.is_active = mcc_data.is_active
    
    db.commit()
    db.refresh(mcc_account)
    
    data_count = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.mcc_id == mcc_account.id
    ).count()
    
    return {
        "id": mcc_account.id,
        "mcc_id": mcc_account.mcc_id,
        "mcc_name": mcc_account.mcc_name,
        "email": mcc_account.email,
        "is_active": mcc_account.is_active,
        "created_at": mcc_account.created_at.isoformat(),
        "updated_at": mcc_account.updated_at.isoformat() if mcc_account.updated_at else None,
        "data_count": data_count
    }


@router.delete("/accounts/{mcc_id}")
async def delete_mcc_account(
    mcc_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除MCC账号"""
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    db.delete(mcc_account)
    db.commit()
    
    return {"message": "MCC账号已删除"}


@router.post("/accounts/{mcc_id}/sync")
async def sync_mcc_data(
    mcc_id: int,
    target_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """手动同步MCC数据"""
    from app.services.google_ads_api_sync import GoogleAdsApiSyncService
    
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    sync_date = None
    if target_date:
        try:
            sync_date = datetime.strptime(target_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    sync_service = GoogleAdsApiSyncService(db)
    result = sync_service.sync_mcc_data(mcc_id, sync_date)
    
    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("message", "同步失败"))
    
    return result


@router.get("/aggregate")
async def aggregate_mcc_data(
    platform_code: Optional[str] = None,
    account_id: Optional[int] = None,
    begin_date: Optional[str] = None,
    end_date: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    聚合MCC数据并按平台/账号分配
    
    将多个MCC的数据汇总，然后根据广告系列名匹配的平台信息分配到对应的平台账号
    """
    # 1. 获取Google Ads数据
    query = db.query(GoogleAdsApiData).join(
        GoogleMccAccount
    ).filter(
        GoogleAdsApiData.user_id == current_user.id
    )
    
    if platform_code:
        query = query.filter(GoogleAdsApiData.extracted_platform_code == platform_code)
    
    if begin_date:
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
            query = query.filter(GoogleAdsApiData.date >= begin)
        except ValueError:
            raise HTTPException(status_code=400, detail="开始日期格式错误")
    
    if end_date:
        try:
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
            query = query.filter(GoogleAdsApiData.date <= end)
        except ValueError:
            raise HTTPException(status_code=400, detail="结束日期格式错误")
    
    google_ads_data = query.all()
    
    # 2. 按平台和账号分组聚合
    aggregated = {}
    
    for data in google_ads_data:
        platform_code = data.extracted_platform_code
        account_code = data.extracted_account_code
        
        if not platform_code:
            continue
        
        # 查找对应的联盟账号
        affiliate_account = None
        if account_code:
            affiliate_account = db.query(AffiliateAccount).join(
                AffiliateAccount.platform
            ).filter(
                AffiliateAccount.user_id == current_user.id,
                AffiliateAccount.platform.has(platform_code=platform_code),
                AffiliateAccount.account_code == account_code,
                AffiliateAccount.is_active == True
            ).first()
        
        if not affiliate_account:
            # 如果没有找到匹配的账号代码，使用该平台的第一个账号
            affiliate_account = db.query(AffiliateAccount).join(
                AffiliateAccount.platform
            ).filter(
                AffiliateAccount.user_id == current_user.id,
                AffiliateAccount.platform.has(platform_code=platform_code),
                AffiliateAccount.is_active == True
            ).first()
        
        if not affiliate_account:
            continue
        
        key = f"{platform_code}_{affiliate_account.id}_{data.date.isoformat()}"
        
        if key not in aggregated:
            aggregated[key] = {
                "platform_code": platform_code,
                "platform_name": affiliate_account.platform.platform_name,
                "account_id": affiliate_account.id,
                "account_name": affiliate_account.account_name,
                "date": data.date.isoformat(),
                "budget": 0,
                "cost": 0,
                "impressions": 0,
                "clicks": 0,
                "campaigns": []
            }
        
        aggregated[key]["budget"] += data.budget
        aggregated[key]["cost"] += data.cost
        aggregated[key]["impressions"] += data.impressions
        aggregated[key]["clicks"] += data.clicks
        aggregated[key]["campaigns"].append({
            "campaign_id": data.campaign_id,
            "campaign_name": data.campaign_name,
            "cost": data.cost,
            "impressions": data.impressions,
            "clicks": data.clicks
        })
    
    # 3. 计算CPC
    for key in aggregated:
        if aggregated[key]["clicks"] > 0:
            aggregated[key]["cpc"] = aggregated[key]["cost"] / aggregated[key]["clicks"]
        else:
            aggregated[key]["cpc"] = 0
    
    return {
        "success": True,
        "total_records": len(google_ads_data),
        "aggregated_records": len(aggregated),
        "data": list(aggregated.values())
    }


