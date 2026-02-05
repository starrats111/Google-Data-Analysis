"""
MCC管理API
用于管理Google MCC账号和数据聚合
"""
import logging
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from starlette.requests import Request
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


def _sync_mcc_range_in_background(mcc_id: int, begin: date, end: date, user_id: int):
    """后台任务：同步MCC日期范围数据"""
    import logging
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
        
        while current_date <= end:
            try:
                result = sync_service.sync_mcc_data(mcc_id, current_date)
                if result.get("success"):
                    saved_count = result.get("saved_count", 0)
                    total_saved += saved_count
                    if saved_count == 0:
                        logger.warning(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步成功但未保存数据: {result.get('message', '')}")
                    else:
                        logger.info(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步成功: 保存 {saved_count} 条")
                else:
                    error_msg = result.get('message', '同步失败')
                    errors.append(f"{current_date.isoformat()}: {error_msg}")
                    logger.warning(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步失败: {error_msg}")
            except Exception as e:
                error_msg = str(e)
                errors.append(f"{current_date.isoformat()}: {error_msg}")
                logger.error(f"MCC {mcc_id} 日期 {current_date.isoformat()} 同步异常: {error_msg}", exc_info=True)
            current_date += timedelta(days=1)
        
        logger.info(f"MCC {mcc_id} 后台同步完成: 日期范围 {begin.isoformat()} ~ {end.isoformat()}, 保存 {total_saved} 条，错误 {len(errors)} 个")
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
        result = sync_service.sync_mcc_data(mcc_id, sync_date)
        
        if result.get("success"):
            saved_count = result.get("saved_count", 0)
            message = result.get("message", "")
            if saved_count == 0:
                logger.warning(f"MCC {mcc_id} 后台同步完成 ({sync_date.isoformat()}): 保存 0 条，原因: {message}")
            else:
                logger.info(f"MCC {mcc_id} 后台同步完成 ({sync_date.isoformat()}): 保存 {saved_count} 条")
        else:
            error_msg = result.get('message', '未知错误')
            logger.error(f"MCC {mcc_id} 后台同步失败 ({sync_date.isoformat()}): {error_msg}")
    except Exception as e:
        logger.error(f"MCC {mcc_id} 后台同步异常 ({sync_date.isoformat()}): {e}", exc_info=True)
    finally:
        db.close()


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
                
                return JSONResponse(
                    status_code=202,
                    content={
                        "success": True,
                        "async": True,
                        "message": f"已开始后台同步：{begin.isoformat()} ~ {end.isoformat()}（请稍后刷新查看结果）",
                        "begin_date": begin.isoformat(),
                        "end_date": end.isoformat()
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
                    "message": f"已开始后台同步：{sync_date.isoformat()}（请稍后刷新查看结果）",
                    "target_date": sync_date.isoformat()
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
                    "message": f"已开始后台同步：{yesterday.isoformat()}（请稍后刷新查看结果）",
                    "target_date": yesterday.isoformat()
                },
                headers=cors_headers
            )
    except HTTPException as e:
        # HTTP异常需要手动添加CORS头
        logger.error(f"[MCC同步] HTTP异常: {e.detail}, 耗时: {time.time() - start_time:.2f}s")
        return JSONResponse(
            status_code=e.status_code,
            content={"detail": e.detail},
            headers=cors_headers
        )
    except Exception as e:
        # 捕获所有其他异常，记录日志并返回友好的错误信息
        import traceback
        error_detail = f"同步失败: {str(e)}"
        logger.error(f"[MCC同步] 异常: {error_detail}, 耗时: {time.time() - start_time:.2f}s\n{traceback.format_exc()}")
        return JSONResponse(
            status_code=500,
            content={"detail": error_detail},
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


