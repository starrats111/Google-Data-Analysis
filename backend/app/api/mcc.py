"""
MCC管理API
用于管理Google MCC账号和数据聚合
"""
import json
import logging
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from starlette.requests import Request
from sqlalchemy.orm import Session
from typing import Optional, List, Dict, Any
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


def _sync_mcc_range_in_background(mcc_id: int, begin: date, end: date, user_id: int):
    """后台任务：同步MCC日期范围数据"""
    import logging
    import time
    from app.database import SessionLocal
    from app.services.google_ads_api_sync import GoogleAdsApiSyncService
    from datetime import timedelta
    
    logger = logging.getLogger(__name__)
    db = SessionLocal()
    
    try:
        sync_service = GoogleAdsApiSyncService(db)
        current_date = begin
        total_saved = 0
        errors = []
        
        quota_exhausted = False
        while current_date <= end:
            try:
                # 检查配额限制，如果已用完则立即停止
                if quota_exhausted:
                    logger.warning(f"MCC {mcc_id} 检测到配额限制，停止后续日期同步")
                    break
                
                result = sync_service.sync_mcc_data(mcc_id, current_date, force_refresh=False)
                
                # 检查是否是配额限制
                if result.get("quota_exhausted"):
                    quota_exhausted = True
                    error_msg = result.get('message', 'Google Ads API配额已用完')
                    logger.error(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步失败: {error_msg}")
                    errors.append(f"{current_date.isoformat()}: {error_msg}")
                    # 遇到配额限制，立即停止后续日期同步
                    break
                
                if result.get("success"):
                    # 检查是否跳过了同步（数据已存在）
                    if result.get("skipped"):
                        logger.info(f"MCC {mcc_id} 日期 {current_date.isoformat()} 跳过同步: {result.get('message', '')}")
                        # 跳过的也算成功，但不计入保存数量
                    else:
                        saved_count = result.get("saved_count", 0)
                        total_saved += saved_count
                        message = result.get('message', '')
                        if saved_count == 0:
                            logger.warning(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步成功但未保存数据: {message}")
                        else:
                            logger.info(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步成功: 保存 {saved_count} 条")
                    
                    # 添加请求延迟，避免过快请求导致配额限制
                    time.sleep(0.5)  # 每个日期之间延迟0.5秒
                else:
                    error_msg = result.get('message', '同步失败')
                    # 检查是否是配额限制
                    if "配额" in error_msg or "quota" in error_msg.lower() or "429" in error_msg or "Resource has been exhausted" in error_msg:
                        quota_exhausted = True
                        logger.error(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步失败: Google Ads API配额已用完")
                        # 遇到配额限制，立即停止后续日期同步
                        break
                    errors.append(f"{current_date.isoformat()}: {error_msg}")
                    logger.warning(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步失败: {error_msg}")
            except Exception as e:
                error_msg = str(e)
                if "配额" in error_msg or "quota" in error_msg.lower() or "429" in error_msg or "Resource has been exhausted" in error_msg:
                    quota_exhausted = True
                    logger.error(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步异常: Google Ads API配额已用完")
                    # 遇到配额限制，立即停止后续日期同步
                    break
                errors.append(f"{current_date.isoformat()}: {error_msg}")
                logger.error(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步异常: {error_msg}", exc_info=True)
            current_date += timedelta(days=1)
        
        # 生成详细的同步结果消息
        if quota_exhausted:
            error_msg = f"⚠️ Google Ads API配额已用完，同步已停止。请等待配额恢复（通常需要等待几小时到24小时）"
            if total_saved > 0:
                error_msg += f"\n已成功同步 {total_saved} 条数据，剩余日期因配额限制未同步。"
            logger.error(f"MCC {mcc_id} 后台同步失败: {error_msg}")
        else:
            total_days = (end - begin).days + 1
            success_days = total_days - len(errors)
            if total_saved > 0:
                result_msg = f"✅ 同步完成！共 {total_days} 天，成功 {success_days} 天，保存 {total_saved} 条数据"
            elif len(errors) == 0:
                result_msg = f"ℹ️ 同步完成，但未保存新数据（可能数据已存在或该日期无数据）"
            else:
                result_msg = f"⚠️ 同步完成，但遇到 {len(errors)} 个错误"
            
            logger.info(f"MCC {mcc_id} 后台同步完成: 日期范围 {begin.isoformat()} ~ {end.isoformat()}, {result_msg}")
        
        if errors:
            logger.warning(f"MCC {mcc_id} 同步错误详情: {errors[:5]}")  # 只显示前5个错误
    except Exception as e:
        logger.error(f"MCC {mcc_id} 后台同步异常: {e}", exc_info=True)
    finally:
        db.close()


def _sync_mcc_single_date_in_background(mcc_id: int, sync_date: date, user_id: int):
    """后台任务：同步MCC单个日期数据"""
    import logging
    from app.database import SessionLocal
    from app.services.google_ads_api_sync import GoogleAdsApiSyncService
    
    logger = logging.getLogger(__name__)
    db = SessionLocal()
    
    try:
        sync_service = GoogleAdsApiSyncService(db)
        result = sync_service.sync_mcc_data(mcc_id, sync_date, force_refresh=False)
        
        # 检查是否是配额限制
        if result.get("quota_exhausted"):
            retry_after = result.get("retry_after_seconds")
            if retry_after:
                hours = retry_after / 3600
                error_msg = f"⚠️ Google Ads API配额已用完，需要等待约 {hours:.1f} 小时后重试"
            else:
                error_msg = "⚠️ Google Ads API配额已用完，请等待配额恢复（通常需要等待几小时到24小时）"
            logger.error(f"MCC {mcc_id} 后台同步失败 ({sync_date.isoformat()}): {error_msg}")
            return
        
        if result.get("success"):
            # 检查是否跳过了同步
            if result.get("skipped"):
                saved_count = result.get("saved_count", 0)
                logger.info(f"MCC {mcc_id} 后台同步跳过 ({sync_date.isoformat()}): ✅ 数据已存在且是最新的（已有 {saved_count} 条记录）")
            else:
                saved_count = result.get("saved_count", 0)
                message = result.get("message", "")
                if saved_count == 0:
                    logger.warning(f"MCC {mcc_id} 后台同步完成 ({sync_date.isoformat()}): ⚠️ 保存 0 条，原因: {message}")
                else:
                    logger.info(f"MCC {mcc_id} 后台同步完成 ({sync_date.isoformat()}): ✅ 保存 {saved_count} 条数据")
        else:
            error_msg = result.get('message', '未知错误')
            logger.error(f"MCC {mcc_id} 后台同步失败 ({sync_date.isoformat()}): ❌ {error_msg}")
    except Exception as e:
        error_str = str(e)
        if "配额" in error_str or "quota" in error_str.lower() or "429" in error_str or "Resource has been exhausted" in error_str:
            logger.error(f"MCC {mcc_id} 后台同步失败 ({sync_date.isoformat()}): Google Ads API配额已用完")
        else:
            logger.error(f"MCC {mcc_id} 后台同步异常 ({sync_date.isoformat()}): {e}", exc_info=True)
    finally:
        db.close()


class MccAccountCreate(BaseModel):
    """创建MCC账号请求"""
    mcc_id: str
    mcc_name: str
    email: Optional[str] = None  # 可选，用于记录
    use_service_account: bool = True  # 默认使用服务账号模式
    # OAuth配置（旧版兼容）
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    refresh_token: Optional[str] = None
    # 服务账号配置（可选，优先使用全局配置）
    service_account_json: Optional[str] = None


class MccAccountBatchCreate(BaseModel):
    """批量创建MCC账号请求"""
    mccs: List[MccAccountCreate]


class MccAccountUpdate(BaseModel):
    """更新MCC账号请求"""
    mcc_name: Optional[str] = None
    email: Optional[str] = None
    use_service_account: Optional[bool] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    refresh_token: Optional[str] = None
    service_account_json: Optional[str] = None
    is_active: Optional[bool] = None


class MccAccountResponse(BaseModel):
    """MCC账号响应"""
    id: int
    mcc_id: str
    mcc_name: str
    email: Optional[str] = None
    is_active: bool
    use_service_account: bool = True
    created_at: str
    updated_at: Optional[str] = None
    data_count: int = 0  # 该MCC的数据条数
    # 同步状态
    last_sync_status: Optional[str] = None
    last_sync_message: Optional[str] = None
    last_sync_at: Optional[str] = None
    last_sync_date: Optional[str] = None
    total_campaigns: int = 0
    total_customers: int = 0
    # OAuth配置（保留兼容）
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    refresh_token: Optional[str] = None
    has_service_account: bool = False  # 是否配置了单独的服务账号
    
    class Config:
        from_attributes = True


def _build_mcc_response(mcc_account: GoogleMccAccount, data_count: int = 0) -> Dict[str, Any]:
    """构建MCC账号响应数据"""
    return {
        "id": mcc_account.id,
        "mcc_id": mcc_account.mcc_id,
        "mcc_name": mcc_account.mcc_name,
        "email": mcc_account.email,
        "is_active": mcc_account.is_active,
        "use_service_account": mcc_account.use_service_account if hasattr(mcc_account, 'use_service_account') else True,
        "created_at": mcc_account.created_at.isoformat() if mcc_account.created_at else datetime.now().isoformat(),
        "updated_at": mcc_account.updated_at.isoformat() if mcc_account.updated_at else None,
        "data_count": data_count,
        # 同步状态
        "last_sync_status": mcc_account.last_sync_status if hasattr(mcc_account, 'last_sync_status') else None,
        "last_sync_message": mcc_account.last_sync_message if hasattr(mcc_account, 'last_sync_message') else None,
        "last_sync_at": mcc_account.last_sync_at.isoformat() if hasattr(mcc_account, 'last_sync_at') and mcc_account.last_sync_at else None,
        "last_sync_date": mcc_account.last_sync_date.isoformat() if hasattr(mcc_account, 'last_sync_date') and mcc_account.last_sync_date else None,
        "total_campaigns": mcc_account.total_campaigns if hasattr(mcc_account, 'total_campaigns') else 0,
        "total_customers": mcc_account.total_customers if hasattr(mcc_account, 'total_customers') else 0,
        # OAuth配置
        "client_id": mcc_account.client_id,
        "client_secret": mcc_account.client_secret,
        "refresh_token": mcc_account.refresh_token,
        # 服务账号
        "has_service_account": bool(mcc_account.service_account_json) if hasattr(mcc_account, 'service_account_json') else False,
    }


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
        email=mcc_data.email or "",
        use_service_account=mcc_data.use_service_account,
        client_id=mcc_data.client_id,
        client_secret=mcc_data.client_secret,
        refresh_token=mcc_data.refresh_token,
        service_account_json=mcc_data.service_account_json,
        is_active=True
    )
    
    db.add(mcc_account)
    db.commit()
    db.refresh(mcc_account)
    
    # 获取数据条数
    data_count = db.query(GoogleAdsApiData).filter(
        GoogleAdsApiData.mcc_id == mcc_account.id
    ).count()
    
    return _build_mcc_response(mcc_account, data_count)


@router.post("/accounts/batch", response_model=List[MccAccountResponse])
async def batch_create_mcc_accounts(
    batch_data: MccAccountBatchCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """批量创建MCC账号"""
    created_accounts = []
    errors = []
    
    for mcc_data in batch_data.mccs:
        try:
            # 检查MCC ID是否已存在
            existing = db.query(GoogleMccAccount).filter(
                GoogleMccAccount.mcc_id == mcc_data.mcc_id
            ).first()
            
            if existing:
                errors.append(f"MCC {mcc_data.mcc_id} 已存在，跳过")
                continue
            
            # 创建MCC账号
            mcc_account = GoogleMccAccount(
                user_id=current_user.id,
                mcc_id=mcc_data.mcc_id,
                mcc_name=mcc_data.mcc_name,
                email=mcc_data.email or "",
                use_service_account=mcc_data.use_service_account,
                client_id=mcc_data.client_id,
                client_secret=mcc_data.client_secret,
                refresh_token=mcc_data.refresh_token,
                service_account_json=mcc_data.service_account_json,
                is_active=True
            )
            
            db.add(mcc_account)
            created_accounts.append(mcc_account)
            
        except Exception as e:
            errors.append(f"MCC {mcc_data.mcc_id} 创建失败: {str(e)}")
    
    if created_accounts:
        db.commit()
        for acc in created_accounts:
            db.refresh(acc)
    
    logger.info(f"批量创建MCC账号: 成功 {len(created_accounts)} 个, 失败/跳过 {len(errors)} 个")
    
    return [_build_mcc_response(acc, 0) for acc in created_accounts]


@router.get("/accounts", response_model=List[MccAccountResponse])
@router.get("/accounts/", response_model=List[MccAccountResponse])  # 兼容带斜杠的URL
async def get_mcc_accounts(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取MCC账号列表（优化版本：使用聚合查询避免N+1问题）"""
    import time
    start_time = time.time()
    
    # 提前准备CORS头，确保所有响应都包含
    origin = request.headers.get("origin")
    from app.main import get_cors_headers
    cors_headers = get_cors_headers(origin)
    from fastapi.responses import JSONResponse
    
    try:
        logger.info(f"用户 {current_user.username} (ID: {current_user.id}) 请求MCC账号列表")
        
        # 查询MCC账号（简化查询，移除重复的权限检查）
        mcc_accounts = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.user_id == current_user.id
        ).order_by(GoogleMccAccount.created_at.desc()).all()
        
        logger.info(f"查询到 {len(mcc_accounts)} 个MCC账号")
        
        if not mcc_accounts:
            # 如果没有MCC账号，直接返回空列表（包含CORS头）
            logger.info("用户没有MCC账号，返回空列表")
            return JSONResponse(content=[], headers=cors_headers)
        
        # 优化：使用一次聚合查询获取所有MCC的数据条数，避免N+1查询
        from sqlalchemy import func
        mcc_ids = [mcc.id for mcc in mcc_accounts]
        
        # 如果MCC账号列表为空，直接返回
        if not mcc_ids:
            return JSONResponse(content=[], headers=cors_headers)
        
        # 使用 GROUP BY 一次性获取所有MCC的数据条数（添加异常处理）
        try:
            data_counts = db.query(
                GoogleAdsApiData.mcc_id,
                func.count(GoogleAdsApiData.id).label('count')
            ).filter(
                GoogleAdsApiData.mcc_id.in_(mcc_ids)
            ).group_by(GoogleAdsApiData.mcc_id).all()
            
            # 转换为字典，方便快速查找
            data_count_map = {mcc_id: count for mcc_id, count in data_counts}
        except Exception as e:
            # 如果查询失败，使用空字典，避免整个接口失败
            logger.warning(f"获取MCC数据条数失败: {e}，使用默认值0")
            data_count_map = {}
        
        # 构建结果列表
        result = []
        for mcc in mcc_accounts:
            try:
                # 从字典中获取数据条数，如果没有则默认为0
                data_count = data_count_map.get(mcc.id, 0)
                result.append(_build_mcc_response(mcc, data_count))
            except Exception as e:
                # 如果单个MCC处理失败，记录错误但继续处理其他MCC
                logger.error(f"处理MCC账号 {mcc.id} 时出错: {str(e)}", exc_info=True)
                continue
        
        elapsed_time = time.time() - start_time
        logger.info(f"成功返回 {len(result)} 个MCC账号，耗时 {elapsed_time:.2f} 秒")
        
        # 返回结果，确保包含CORS头
        return JSONResponse(content=result, headers=cors_headers)
        
    except HTTPException as e:
        # HTTP异常需要手动添加CORS头
        logger.error(f"获取MCC账号列表HTTP异常: {e.detail}")
        return JSONResponse(
            status_code=e.status_code,
            content={"detail": e.detail},
            headers=cors_headers
        )
    except Exception as e:
        # 记录完整的错误信息
        import traceback
        error_trace = traceback.format_exc()
        logger.error(f"获取MCC账号列表失败: {str(e)}\n{error_trace}")
        
        # 确保错误响应也包含CORS头
        return JSONResponse(
            status_code=500,
            content={"detail": f"获取MCC账号列表失败: {str(e)}"},
            headers=cors_headers
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
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """手动同步MCC数据
    
    支持两种方式：
    1. 单个日期：target_date (YYYY-MM-DD)
    2. 日期范围：begin_date 和 end_date (YYYY-MM-DD)
    """
    import logging
    import time
    import json
    logger = logging.getLogger(__name__)
    start_time = time.time()
    
    # 提前准备CORS头，确保所有响应都包含
    origin = request.headers.get("origin")
    from app.main import get_cors_headers
    cors_headers = get_cors_headers(origin)
    from fastapi.responses import JSONResponse
    
    try:
        logger.info(f"[MCC同步] 开始处理请求: mcc_id={mcc_id}, user={current_user.username}")
        
        # 快速验证MCC账号是否存在
        mcc_account = db.query(GoogleMccAccount).filter(
            GoogleMccAccount.id == mcc_id,
            GoogleMccAccount.user_id == current_user.id
        ).first()
        
        if not mcc_account:
            logger.error(f"[MCC同步] 账号不存在: mcc_id={mcc_id}, user_id={current_user.id}")
            raise HTTPException(status_code=404, detail="MCC账号不存在")
        
        # 解析请求数据（从请求体中获取JSON）
        try:
            body = await request.body()
            if body:
                request_data = json.loads(body)
            else:
                request_data = {}
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"[MCC同步] 解析请求体失败: {e}，使用空字典")
            request_data = {}
        
        target_date = request_data.get("target_date")
        begin_date = request_data.get("begin_date")
        end_date = request_data.get("end_date")
        
        logger.info(f"[MCC同步] 账号验证完成: {mcc_account.mcc_name}, 耗时: {time.time() - start_time:.2f}s")
        
        # 如果提供了日期范围，同步范围内的所有日期
        if begin_date and end_date:
            try:
                begin = datetime.strptime(begin_date, "%Y-%m-%d").date()
                end = datetime.strptime(end_date, "%Y-%m-%d").date()
            
                if begin > end:
                    raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
            
                # 使用后台任务处理日期范围同步，避免超时
                background_tasks.add_task(
                    _sync_mcc_range_in_background,
                    mcc_id=mcc_id,
                    begin=begin,
                    end=end,
                    user_id=current_user.id
                )
                
                logger.info(f"[MCC同步] 后台任务已添加，总耗时: {time.time() - start_time:.2f}s")
                
                total_days = (end - begin).days + 1
                return JSONResponse(
                    status_code=202,
                    content={
                        "success": True,
                        "async": True,
                        "message": f"🔄 已开始后台同步：{begin.isoformat()} ~ {end.isoformat()}（共 {total_days} 天）\n请稍后刷新页面查看结果",
                        "begin_date": begin.isoformat(),
                        "end_date": end.isoformat(),
                        "total_days": total_days,
                        "status": "syncing"
                    },
                    headers=cors_headers
                )
            except ValueError:
                raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
        
        # 如果提供了单个日期，使用后台任务同步该日期
        elif target_date:
            try:
                sync_date = datetime.strptime(target_date, "%Y-%m-%d").date()
            except ValueError:
                raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
            
            # 使用后台任务处理，避免超时
            background_tasks.add_task(
                _sync_mcc_single_date_in_background,
                mcc_id=mcc_id,
                sync_date=sync_date,
                user_id=current_user.id
            )
            
            logger.info(f"[MCC同步] 后台任务已添加（单个日期），总耗时: {time.time() - start_time:.2f}s")
            
            return JSONResponse(
                status_code=202,
                content={
                    "success": True,
                    "async": True,
                    "message": f"🔄 已开始后台同步：{sync_date.isoformat()}\n请稍后刷新页面查看结果",
                    "target_date": sync_date.isoformat(),
                    "status": "syncing"
                },
                headers=cors_headers
            )
        
        # 如果没有提供日期，默认同步昨天，也使用后台任务
        else:
            from datetime import timedelta
            yesterday = (datetime.now() - timedelta(days=1)).date()
            
            # 使用后台任务处理，避免超时
            background_tasks.add_task(
                _sync_mcc_single_date_in_background,
                mcc_id=mcc_id,
                sync_date=yesterday,
                user_id=current_user.id
            )
            
            logger.info(f"[MCC同步] 后台任务已添加（默认昨天），总耗时: {time.time() - start_time:.2f}s")
            
            return JSONResponse(
                status_code=202,
                content={
                    "success": True,
                    "async": True,
                    "message": f"🔄 已开始后台同步：{yesterday.isoformat()}（昨天）\n请稍后刷新页面查看结果",
                    "target_date": yesterday.isoformat(),
                    "status": "syncing"
                },
                headers=cors_headers
            )
    except HTTPException as e:
        # HTTP异常需要手动添加CORS头
        logger.error(f"[MCC同步] HTTP异常: {e.detail}, 耗时: {time.time() - start_time:.2f}s")
        return JSONResponse(
            status_code=e.status_code,
            content={
                "success": False,
                "message": f"❌ {e.detail}",
                "status": "error"
            },
            headers=cors_headers
        )
    except Exception as e:
        # 捕获所有其他异常，记录日志并返回友好的错误信息
        import traceback
        error_detail = str(e)
        # 检查是否是配额限制
        is_quota_error = "配额" in error_detail or "quota" in error_detail.lower() or "429" in error_detail or "Resource has been exhausted" in error_detail
        
        if is_quota_error:
            error_msg = "⚠️ Google Ads API配额已用完，请等待配额恢复（通常需要等待几小时到24小时）"
        else:
            error_msg = f"❌ 同步失败: {error_detail}"
        
        logger.error(f"[MCC同步] 异常: {error_detail}, 耗时: {time.time() - start_time:.2f}s\n{traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "message": error_msg,
                "status": "error",
                "quota_exhausted": is_quota_error
            },
            headers=cors_headers
        )


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


# ============== 服务账号相关API ==============

@router.post("/accounts/{mcc_id}/test-connection")
async def test_mcc_connection(
    mcc_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    测试MCC连接
    
    验证服务账号配置是否正确，能否访问MCC下的客户账号
    """
    from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
    
    # 验证MCC账号存在且属于当前用户
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    try:
        sync_service = GoogleAdsServiceAccountSync(db)
        result = sync_service.test_connection(mcc_id)
        return result
    except Exception as e:
        return {
            "success": False,
            "message": f"测试连接失败: {str(e)}"
        }


@router.post("/accounts/{mcc_id}/sync-history")
async def sync_mcc_historical_data(
    mcc_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    同步MCC历史数据
    
    请求体参数：
    - begin_date: 开始日期 (YYYY-MM-DD)
    - end_date: 结束日期 (YYYY-MM-DD)
    - force_refresh: 是否强制刷新 (可选，默认false)
    """
    import json
    
    # 验证MCC账号
    mcc_account = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.id == mcc_id,
        GoogleMccAccount.user_id == current_user.id
    ).first()
    
    if not mcc_account:
        raise HTTPException(status_code=404, detail="MCC账号不存在")
    
    # 解析请求参数
    try:
        body = await request.body()
        request_data = json.loads(body) if body else {}
    except Exception:
        request_data = {}
    
    begin_date_str = request_data.get("begin_date", "2026-01-01")
    end_date_str = request_data.get("end_date")
    force_refresh = request_data.get("force_refresh", False)
    
    if not end_date_str:
        end_date_str = (date.today() - timedelta(days=1)).isoformat()
    
    try:
        begin_date = datetime.strptime(begin_date_str, "%Y-%m-%d").date()
        end_date = datetime.strptime(end_date_str, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式错误，应为 YYYY-MM-DD")
    
    if begin_date > end_date:
        raise HTTPException(status_code=400, detail="开始日期不能晚于结束日期")
    
    # 在后台执行历史数据同步
    def sync_historical_task():
        from app.database import SessionLocal
        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        
        task_db = SessionLocal()
        try:
            sync_service = GoogleAdsServiceAccountSync(task_db)
            result = sync_service.sync_historical_data(
                mcc_id,
                begin_date,
                end_date,
                force_refresh=force_refresh
            )
            logger.info(f"MCC {mcc_account.mcc_id} 历史数据同步完成: {result}")
        except Exception as e:
            logger.error(f"MCC {mcc_account.mcc_id} 历史数据同步失败: {e}", exc_info=True)
        finally:
            task_db.close()
    
    background_tasks.add_task(sync_historical_task)
    
    total_days = (end_date - begin_date).days + 1
    
    return {
        "success": True,
        "async": True,
        "message": f"🔄 已开始后台同步历史数据: {begin_date_str} ~ {end_date_str}（共 {total_days} 天）",
        "begin_date": begin_date_str,
        "end_date": end_date_str,
        "total_days": total_days
    }


@router.post("/sync-all")
async def sync_all_mccs(
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    手动触发同步所有活跃MCC的数据
    
    请求体参数：
    - target_date: 目标日期 (YYYY-MM-DD，可选，默认昨天)
    """
    import json
    
    # 解析请求参数
    try:
        body = await request.body()
        request_data = json.loads(body) if body else {}
    except Exception:
        request_data = {}
    
    target_date_str = request_data.get("target_date")
    
    if target_date_str:
        try:
            target_date = datetime.strptime(target_date_str, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式错误")
    else:
        target_date = date.today() - timedelta(days=1)
    
    # 获取活跃MCC数量
    active_count = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.is_active == True,
        GoogleMccAccount.user_id == current_user.id
    ).count()
    
    if active_count == 0:
        return {
            "success": False,
            "message": "没有活跃的MCC账号"
        }
    
    # 在后台执行同步
    def sync_all_task():
        from app.database import SessionLocal
        from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
        
        task_db = SessionLocal()
        try:
            sync_service = GoogleAdsServiceAccountSync(task_db)
            result = sync_service.sync_all_mccs(target_date=target_date)
            logger.info(f"批量同步完成: {result}")
        except Exception as e:
            logger.error(f"批量同步失败: {e}", exc_info=True)
        finally:
            task_db.close()
    
    background_tasks.add_task(sync_all_task)
    
    return {
        "success": True,
        "async": True,
        "message": f"🔄 已开始后台同步 {active_count} 个MCC账号（{target_date.isoformat()}）",
        "target_date": target_date.isoformat(),
        "mcc_count": active_count
    }


@router.get("/sync-status")
async def get_sync_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取所有MCC的同步状态"""
    mcc_accounts = db.query(GoogleMccAccount).filter(
        GoogleMccAccount.user_id == current_user.id
    ).all()
    
    status_list = []
    for mcc in mcc_accounts:
        status_list.append({
            "id": mcc.id,
            "mcc_id": mcc.mcc_id,
            "mcc_name": mcc.mcc_name,
            "is_active": mcc.is_active,
            "last_sync_status": getattr(mcc, 'last_sync_status', None),
            "last_sync_message": getattr(mcc, 'last_sync_message', None),
            "last_sync_at": mcc.last_sync_at.isoformat() if getattr(mcc, 'last_sync_at', None) else None,
            "last_sync_date": mcc.last_sync_date.isoformat() if getattr(mcc, 'last_sync_date', None) else None,
            "total_campaigns": getattr(mcc, 'total_campaigns', 0),
            "total_customers": getattr(mcc, 'total_customers', 0)
        })
    
    return {
        "success": True,
        "total": len(status_list),
        "data": status_list
    }


class ServiceAccountUpload(BaseModel):
    """服务账号上传请求"""
    json_content: str  # JSON内容（字符串或Base64编码）
    is_base64: bool = False


@router.post("/service-account")
async def upload_global_service_account(
    upload_data: ServiceAccountUpload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    上传全局服务账号配置
    
    将服务账号JSON保存到配置文件中
    """
    import base64
    
    # 只有管理员可以上传全局服务账号
    if current_user.role != "admin" and current_user.username != "wenjun123":
        raise HTTPException(status_code=403, detail="只有管理员可以上传全局服务账号")
    
    try:
        # 解析JSON内容
        if upload_data.is_base64:
            json_str = base64.b64decode(upload_data.json_content).decode('utf-8')
        else:
            json_str = upload_data.json_content
        
        # 验证JSON格式
        sa_data = json.loads(json_str)
        
        # 检查必要字段
        required_fields = ['type', 'project_id', 'private_key', 'client_email']
        for field in required_fields:
            if field not in sa_data:
                raise HTTPException(status_code=400, detail=f"服务账号JSON缺少必要字段: {field}")
        
        if sa_data.get('type') != 'service_account':
            raise HTTPException(status_code=400, detail="JSON文件不是有效的服务账号密钥")
        
        # 保存到文件
        import os
        config_dir = Path(__file__).parent.parent.parent / "config"
        config_dir.mkdir(exist_ok=True)
        
        sa_file = config_dir / "service_account.json"
        with open(sa_file, 'w', encoding='utf-8') as f:
            json.dump(sa_data, f, indent=2)
        
        logger.info(f"全局服务账号已保存: {sa_file}")
        
        return {
            "success": True,
            "message": "服务账号配置已保存",
            "service_account_email": sa_data.get('client_email'),
            "project_id": sa_data.get('project_id')
        }
        
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="无效的JSON格式")
    except Exception as e:
        logger.error(f"保存服务账号失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"保存失败: {str(e)}")


@router.get("/service-account/status")
async def get_service_account_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """获取全局服务账号配置状态"""
    from app.config import settings
    
    status = {
        "configured": False,
        "source": None,
        "service_account_email": None,
        "project_id": None,
        "developer_token_configured": bool(settings.google_ads_shared_developer_token)
    }
    
    # 检查Base64配置
    if settings.google_ads_service_account_json_base64:
        try:
            import base64
            json_str = base64.b64decode(settings.google_ads_service_account_json_base64).decode('utf-8')
            sa_data = json.loads(json_str)
            status["configured"] = True
            status["source"] = "environment_base64"
            status["service_account_email"] = sa_data.get('client_email')
            status["project_id"] = sa_data.get('project_id')
            return status
        except Exception:
            pass
    
    # 检查文件配置
    if settings.google_ads_service_account_file:
        file_path = Path(settings.google_ads_service_account_file)
        if not file_path.is_absolute():
            file_path = Path(__file__).parent.parent.parent / file_path
        
        if file_path.exists():
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    sa_data = json.load(f)
                status["configured"] = True
                status["source"] = "file"
                status["service_account_email"] = sa_data.get('client_email')
                status["project_id"] = sa_data.get('project_id')
                return status
            except Exception:
                pass
    
    # 检查默认配置文件
    default_path = Path(__file__).parent.parent.parent / "config" / "service_account.json"
    if default_path.exists():
        try:
            with open(default_path, 'r', encoding='utf-8') as f:
                sa_data = json.load(f)
            status["configured"] = True
            status["source"] = "default_file"
            status["service_account_email"] = sa_data.get('client_email')
            status["project_id"] = sa_data.get('project_id')
        except Exception:
            pass
    
    return status


