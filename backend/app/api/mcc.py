"""
MCC账号管理API
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.mcc_account import MccAccount
from app.schemas.mcc import (
    MccAccountCreate,
    MccAccountUpdate,
    MccAccountResponse,
    TestConnectionResponse
)
from app.services.google_ads_service import GoogleAdsService
from app.config import settings

router = APIRouter(prefix="/api/mcc", tags=["mcc"])


@router.get("/shared-config")
async def get_shared_config(
    current_user: User = Depends(get_current_user)
):
    """获取共享配置信息（用于简化员工配置）"""
    return {
        "has_shared_client_id": bool(settings.GOOGLE_ADS_SHARED_CLIENT_ID),
        "has_shared_client_secret": bool(settings.GOOGLE_ADS_SHARED_CLIENT_SECRET),
        "has_shared_developer_token": bool(settings.GOOGLE_ADS_SHARED_DEVELOPER_TOKEN),
        "need_refresh_token_only": bool(
            settings.GOOGLE_ADS_SHARED_CLIENT_ID and 
            settings.GOOGLE_ADS_SHARED_CLIENT_SECRET and 
            settings.GOOGLE_ADS_SHARED_DEVELOPER_TOKEN
        )
    }


@router.get("/accounts", response_model=List[MccAccountResponse])
async def get_mcc_accounts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取当前用户的MCC账号列表"""
    accounts = db.query(MccAccount).filter(
        MccAccount.user_id == current_user.id
    ).all()
    return accounts


@router.post("/accounts", response_model=MccAccountResponse)
async def create_mcc_account(
    account: MccAccountCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """创建MCC账号"""
    try:
        # 检查MCC账号ID是否已存在
        existing = db.query(MccAccount).filter(
            MccAccount.mcc_account_id == account.mcc_account_id
        ).first()
        
        if existing:
            raise HTTPException(status_code=400, detail="该MCC账号已存在")
        
        # 如果配置了共享的客户端ID和密钥，且用户没有提供，则使用共享配置
        try:
            # 兼容pydantic v1和v2
            if hasattr(account, 'model_dump'):
                account_data = account.model_dump()
            else:
                account_data = account.dict()
        except:
            account_data = account.dict() if hasattr(account, 'dict') else account.__dict__
        
        # 使用共享配置填充缺失字段
        if settings.GOOGLE_ADS_SHARED_CLIENT_ID and not account_data.get('client_id'):
            account_data['client_id'] = settings.GOOGLE_ADS_SHARED_CLIENT_ID
        if settings.GOOGLE_ADS_SHARED_CLIENT_SECRET and not account_data.get('client_secret'):
            account_data['client_secret'] = settings.GOOGLE_ADS_SHARED_CLIENT_SECRET
        if settings.GOOGLE_ADS_SHARED_DEVELOPER_TOKEN and not account_data.get('developer_token'):
            account_data['developer_token'] = settings.GOOGLE_ADS_SHARED_DEVELOPER_TOKEN
        
        # 验证必填字段
        if not account_data.get('client_id'):
            raise HTTPException(status_code=400, detail="客户端ID不能为空，请填写或配置共享配置")
        if not account_data.get('client_secret'):
            raise HTTPException(status_code=400, detail="客户端密钥不能为空，请填写或配置共享配置")
        if not account_data.get('developer_token'):
            raise HTTPException(status_code=400, detail="开发者令牌不能为空，请填写或配置共享配置")
        if not account_data.get('refresh_token'):
            raise HTTPException(status_code=400, detail="刷新令牌不能为空")
        
        # 创建新账号
        new_account = MccAccount(
            user_id=current_user.id,
            mcc_account_id=account_data['mcc_account_id'],
            mcc_account_name=account_data.get('mcc_account_name'),
            email=account_data.get('email'),
            refresh_token=account_data['refresh_token'],
            client_id=account_data['client_id'],
            client_secret=account_data['client_secret'],
            developer_token=account_data['developer_token'],
            is_active=account_data.get('is_active', True)
        )
        db.add(new_account)
        db.commit()
        db.refresh(new_account)
        return new_account
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"创建MCC账号失败: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(status_code=500, detail=f"创建失败: {str(e)}")


@router.put("/accounts/{account_id}", response_model=MccAccountResponse)
async def update_mcc_account(
    account_id: int,
    account: MccAccountUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """更新MCC账号"""
    mcc_account = db.query(MccAccount).filter(
        MccAccount.id == account_id,
        MccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    # 更新字段
    try:
        # 兼容pydantic v1和v2
        if hasattr(account, 'model_dump'):
            update_data = account.model_dump(exclude_unset=True)
        else:
            update_data = account.dict(exclude_unset=True)
    except:
        update_data = account.dict(exclude_unset=True) if hasattr(account, 'dict') else {}
    
    for key, value in update_data.items():
        setattr(mcc_account, key, value)
    
    db.commit()
    db.refresh(mcc_account)
    return mcc_account


@router.delete("/accounts/{account_id}")
async def delete_mcc_account(
    account_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """删除MCC账号"""
    mcc_account = db.query(MccAccount).filter(
        MccAccount.id == account_id,
        MccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    db.delete(mcc_account)
    db.commit()
    return {"message": "删除成功"}


@router.post("/accounts/{account_id}/test-connection", response_model=TestConnectionResponse)
async def test_mcc_connection(
    account_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """测试MCC账号连接"""
    mcc_account = db.query(MccAccount).filter(
        MccAccount.id == account_id,
        MccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        # 创建Google Ads服务
        service = GoogleAdsService(
            mcc_account_id=mcc_account.mcc_account_id,
            refresh_token=mcc_account.refresh_token,
            client_id=mcc_account.client_id,
            client_secret=mcc_account.client_secret,
            developer_token=mcc_account.developer_token
        )
        
        # 测试连接（获取最近1天的数据）
        from datetime import date, timedelta
        today = date.today()
        yesterday = today - timedelta(days=1)
        
        data = service.get_campaigns_data(yesterday, today)
        
        return TestConnectionResponse(
            success=True,
            message="连接成功",
            data={
                "campaigns_count": len(data),
                "sample_data": data[:3] if data else []
            }
        )
    except Exception as e:
        return TestConnectionResponse(
            success=False,
            message=f"连接失败: {str(e)}"
        )
