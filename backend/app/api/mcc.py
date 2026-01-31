"""
MCC管理API
用于管理Google MCC账号和数据聚合
"""
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel
from datetime import date, datetime, timedelta

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData
from app.models.platform_data import PlatformData
from app.models.affiliate_account import AffiliateAccount

logger = logging.getLogger(__name__)
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
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    refresh_token: Optional[str] = None
    
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
        "data_count": data_count,
        "client_id": mcc_account.client_id,
        "client_secret": mcc_account.client_secret,
        "refresh_token": mcc_account.refresh_token
    }


@router.get("/accounts", response_model=List[MccAccountResponse])
@router.get("/accounts/", response_model=List[MccAccountResponse])  # 兼容带斜杠的URL
async def get_mcc_accounts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取MCC账号列表"""
    try:
        logger.info(f"用户 {current_user.username} (ID: {current_user.id}) 请求MCC账号列表")
        
        query = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.user_id == current_user.id
        )
        
        # 权限检查：员工只能查看自己的MCC
        if current_user.role == "employee":
            query = query.filter(GoogleMccAccount.user_id == current_user.id)
        
        mcc_accounts = query.order_by(GoogleMccAccount.created_at.desc()).all()
        logger.info(f"查询到 {len(mcc_accounts)} 个MCC账号")
        
        # 获取每个MCC的数据条数
        result = []
        for mcc in mcc_accounts:
            try:
                data_count = db.query(GoogleAdsApiData).filter(
                    GoogleAdsApiData.mcc_id == mcc.id
                ).count()
                
                result.append({
                    "id": mcc.id,
                    "mcc_id": mcc.mcc_id,
                    "mcc_name": mcc.mcc_name,
                    "email": mcc.email,
                    "is_active": mcc.is_active,
                    "created_at": mcc.created_at.isoformat() if mcc.created_at else datetime.now().isoformat(),
                    "updated_at": mcc.updated_at.isoformat() if mcc.updated_at else None,
                    "data_count": data_count,
                    "client_id": mcc.client_id,  # 返回实际值，前端会用占位符显示
                    "client_secret": mcc.client_secret,
                    "refresh_token": mcc.refresh_token
                })
            except Exception as e:
                # 如果单个MCC处理失败，记录错误但继续处理其他MCC
                logger.error(f"处理MCC账号 {mcc.id} 时出错: {str(e)}", exc_info=True)
                continue
        
        logger.info(f"成功返回 {len(result)} 个MCC账号")
        return result
    except HTTPException:
        # 重新抛出HTTP异常
        raise
    except Exception as e:
        # 记录完整的错误信息
        import traceback
        error_trace = traceback.format_exc()
        logger.error(f"获取MCC账号列表失败: {str(e)}\n{error_trace}")
        raise HTTPException(
            status_code=500, 
            detail=f"获取MCC账号列表失败: {str(e)}"
        )


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
        "data_count": data_count,
        "client_id": mcc_account.client_id,
        "client_secret": mcc_account.client_secret,
        "refresh_token": mcc_account.refresh_token
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
    # 对于敏感字段，只有明确提供且非空字符串才更新（None或空字符串表示不修改）
    import logging
    logger = logging.getLogger(__name__)
    
    if mcc_data.client_id is not None:
        client_id_value = mcc_data.client_id.strip() if isinstance(mcc_data.client_id, str) else mcc_data.client_id
        if client_id_value:
            logger.info(f"更新MCC {mcc_account.mcc_id} 的 client_id")
            mcc_account.client_id = client_id_value
        else:
            logger.debug(f"MCC {mcc_account.mcc_id} 的 client_id 为空，不更新")
    else:
        logger.debug(f"MCC {mcc_account.mcc_id} 的 client_id 为 None，不更新")
    
    if mcc_data.client_secret is not None:
        client_secret_value = mcc_data.client_secret.strip() if isinstance(mcc_data.client_secret, str) else mcc_data.client_secret
        if client_secret_value:
            logger.info(f"更新MCC {mcc_account.mcc_id} 的 client_secret")
            mcc_account.client_secret = client_secret_value
        else:
            logger.debug(f"MCC {mcc_account.mcc_id} 的 client_secret 为空，不更新")
    else:
        logger.debug(f"MCC {mcc_account.mcc_id} 的 client_secret 为 None，不更新")
    
    if mcc_data.refresh_token is not None:
        refresh_token_value = mcc_data.refresh_token.strip() if isinstance(mcc_data.refresh_token, str) else mcc_data.refresh_token
        if refresh_token_value:
            logger.info(f"更新MCC {mcc_account.mcc_id} 的 refresh_token")
            mcc_account.refresh_token = refresh_token_value
        else:
            logger.debug(f"MCC {mcc_account.mcc_id} 的 refresh_token 为空，不更新")
    else:
        logger.debug(f"MCC {mcc_account.mcc_id} 的 refresh_token 为 None，不更新")
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
        "data_count": data_count,
        "client_id": mcc_account.client_id,
        "client_secret": mcc_account.client_secret,
        "refresh_token": mcc_account.refresh_token
    }


@router.delete("/accounts/{mcc_id}")
async def delete_mcc_account(
    mcc_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    删除MCC账号
    
    注意：删除MCC账号会同时删除所有关联的Google Ads数据（由于外键CASCADE约束）
    """
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        from app.models.google_ads_api_data import GoogleAdsApiData
        
        mcc_account = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.id == mcc_id,
            GoogleMccAccount.user_id == current_user.id
        ).first()
        
        if not mcc_account:
            raise HTTPException(status_code=404, detail="MCC账号不存在")
        
        # 在删除前保存需要的信息
        mcc_name = mcc_account.mcc_name
        mcc_id_str = mcc_account.mcc_id
        
        # 统计关联的Google Ads数据条数
        data_count = db.query(GoogleAdsApiData).filter(
            GoogleAdsApiData.mcc_id == mcc_id
        ).count()
        
        logger.info(f"准备删除MCC账号 {mcc_id} ({mcc_name})，关联数据条数: {data_count}")
        
        # 先手动删除所有关联的Google Ads数据（避免SQLite CASCADE问题）
        if data_count > 0:
            deleted_rows = db.query(GoogleAdsApiData).filter(
                GoogleAdsApiData.mcc_id == mcc_id
            ).delete(synchronize_session=False)
            logger.info(f"已删除 {deleted_rows} 条关联的Google Ads数据")
        
        # 删除MCC账号
        db.delete(mcc_account)
        db.commit()
        
        logger.info(f"成功删除MCC账号 {mcc_id} ({mcc_name})")
        
        return {
            "message": f"MCC账号已删除",
            "deleted_data_count": data_count,
            "mcc_name": mcc_name,
            "mcc_id": mcc_id_str
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除MCC账号失败: {e}", exc_info=True)
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=f"删除MCC账号失败: {str(e)}"
        )


@router.post("/accounts/{mcc_id}/sync")
async def sync_mcc_data(
    mcc_id: int,
    request_data: Optional[dict] = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """手动同步MCC数据
    
    支持两种方式：
    1. 单个日期：target_date (YYYY-MM-DD)
    2. 日期范围：begin_date 和 end_date (YYYY-MM-DD)
    """
    from app.services.google_ads_api_sync import GoogleAdsApiSyncService
    
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    # 解析请求数据
    if request_data is None:
        request_data = {}
    
    target_date = request_data.get("target_date")
    begin_date = request_data.get("begin_date")
    end_date = request_data.get("end_date")
    
    sync_service = GoogleAdsApiSyncService(db)
    
    # 如果提供了日期范围，同步范围内的所有日期
    if begin_date and end_date:
        try:
            begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
            end = datetime.strptime(end_date, "%Y-%m-%d").date()
            
            if begin > end:
                raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
            
            # 同步日期范围内的每一天
            total_saved = 0
            current_date = begin
            errors = []
            warnings = []  # 记录警告信息（如没有数据但同步成功）
            
            while current_date <= end:
                result = sync_service.sync_mcc_data(mcc_id, current_date)
                if result.get("success"):
                    saved_count = result.get("saved_count", 0)
                    total_saved += saved_count
                    # 如果同步成功但没有保存数据，记录警告
                    if saved_count == 0:
                        warnings.append(f"{current_date.isoformat()}: 同步成功但该日期没有广告系列数据")
                else:
                    errors.append(f"{current_date.isoformat()}: {result.get('message', '同步失败')}")
                current_date += timedelta(days=1)
            
            # 构建返回消息
            if errors and total_saved > 0:
                # 有错误但保存了部分数据
                return {
                    "success": True,
                    "message": f"同步完成，成功保存 {total_saved} 条记录，部分日期同步失败",
                    "saved_count": total_saved,
                    "errors": errors,
                    "warnings": warnings if warnings else None
                }
            elif errors and total_saved == 0:
                # 全部失败
                error_summary = errors[0] if len(errors) == 1 else f"{len(errors)} 个日期同步失败"
                return {
                    "success": False,
                    "message": f"同步失败：{error_summary}",
                    "saved_count": 0,
                    "errors": errors,
                    "warnings": warnings if warnings else None
                }
            elif total_saved == 0 and warnings:
                # 同步成功但没有数据
                warning_summary = warnings[0] if len(warnings) == 1 else f"所有日期都没有广告系列数据"
                return {
                    "success": True,
                    "message": f"同步完成，但没有保存任何数据。{warning_summary}",
                    "saved_count": 0,
                    "warnings": warnings
                }
            else:
                # 完全成功
                return {
                    "success": True,
                    "message": f"成功同步 {total_saved} 条广告系列数据",
                    "saved_count": total_saved
                }
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    # 如果提供了单个日期，同步该日期
    elif target_date:
        try:
            sync_date = datetime.strptime(target_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
        
        result = sync_service.sync_mcc_data(mcc_id, sync_date)
        
        if not result.get("success"):
            raise HTTPException(status_code=500, detail=result.get("message", "同步失败"))
        
        return result
    
    # 如果没有提供日期，默认同步昨天
    else:
        result = sync_service.sync_mcc_data(mcc_id, None)
        
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


