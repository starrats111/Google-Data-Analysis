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


# 显式处理OPTIONS请求，确保CORS预检请求通过
@router.options("/platforms")
@router.options("/accounts")
@router.options("/accounts/by-employees")
async def options_handler(request: Request):
    """处理OPTIONS预检请求"""
    from fastapi import Request
    from fastapi.responses import JSONResponse
    
    origin = request.headers.get("origin")
    headers = {
        "Access-Control-Allow-Origin": origin if origin else "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "3600",
    }
    return JSONResponse(content={}, headers=headers, status_code=200)


@router.post("/accounts/{account_id}/test-api")
async def test_api_connection(
    account_id: int,
    token: Optional[str] = None,
    api_url: Optional[str] = None,
    auto_detect: bool = False,  # 是否自动检测端点
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    测试API连接
    
    用于验证API Token和API URL是否正确配置
    """
    account = db.query(AffiliateAccount).filter(
        AffiliateAccount.id == account_id,
        AffiliateAccount.user_id == current_user.id
    ).first()
    
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    
    if not account.platform:
        raise HTTPException(status_code=400, detail="账号未关联平台")
    
    try:
        from app.services.api_config_service import ApiConfigService
        from app.services.rewardoo_service import RewardooService
        from app.services.collabglow_service import CollabGlowService
        from datetime import datetime, timedelta
        
        platform_code = (account.platform.platform_code or "").lower()
        
        # 获取或使用传入的token
        if not token:
            import json
            if account.notes:
                try:
                    notes_data = json.loads(account.notes)
                    if platform_code in ["rewardoo", "rw"]:
                        token = notes_data.get("rewardoo_token") or notes_data.get("rw_token") or notes_data.get("api_token")
                    elif platform_code in ["collabglow", "cg"]:
                        token = notes_data.get("collabglow_token") or notes_data.get("cg_token") or notes_data.get("api_token")
                except:
                    pass
        
        if not token:
            return {
                "success": False,
                "message": "未配置API Token。请在输入框中输入Token，或在账号备注中配置。"
            }
        
        # 测试连接（使用最近7天的数据）
        end_date = datetime.now().strftime("%Y-%m-%d")
        begin_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        
        if platform_code in ["rewardoo", "rw"]:
            # 如果启用自动检测，先尝试自动检测端点
            detected_endpoint = None
            if auto_detect:
                from app.services.api_endpoint_detector import ApiEndpointDetector
                import logging
                logger = logging.getLogger(__name__)
                logger.info("[API测试] 开始自动检测Rewardoo API端点...")
                detected = ApiEndpointDetector.detect_rewardoo_endpoint(token, api_url)
                if detected:
                    detected_base_url, detected_path = detected
                    detected_endpoint = f"{detected_base_url}{detected_path}"
                    logger.info(f"[API测试] 自动检测到端点: {detected_endpoint}")
                    # 更新账号备注，保存检测到的API URL
                    import json
                    notes_data = {}
                    if account.notes:
                        try:
                            notes_data = json.loads(account.notes)
                        except:
                            pass
                    notes_data["rewardoo_api_url"] = detected_base_url
                    account.notes = json.dumps(notes_data)
                    db.commit()
            
            # 获取API配置
            api_config = ApiConfigService.get_account_api_config(account)
            base_url = api_url or (detected_endpoint.split(detected_path)[0] if detected_endpoint and 'detected_path' in locals() else None) or api_config.get("base_url")
            
            try:
                service = RewardooService(token=token, base_url=base_url)
                result = service.get_transaction_details(begin_date, end_date)
                
                if result.get("code") == "0" or result.get("success"):
                    transactions_count = len(result.get('data', {}).get('transactions', []))
                    message = f"连接成功！API URL: {base_url or '默认'}。"
                    if detected_endpoint:
                        message += f" 自动检测到可用端点。"
                    message += f" 获取到 {transactions_count} 条测试数据。"
                    return {
                        "success": True,
                        "message": message,
                        "detected_endpoint": detected_endpoint
                    }
                else:
                    # 如果失败且未启用自动检测，建议启用自动检测
                    if not auto_detect:
                        return {
                            "success": False,
                            "message": f"连接失败: {result.get('message', '未知错误')}\n\n提示：可以尝试启用'自动检测端点'功能，系统会自动尝试多个可能的API端点。",
                            "suggest_auto_detect": True
                        }
                    else:
                        return {
                            "success": False,
                            "message": f"连接失败: {result.get('message', '未知错误')}"
                        }
            except Exception as e:
                # 如果失败且未启用自动检测，建议启用自动检测
                if not auto_detect and "404" in str(e):
                    return {
                        "success": False,
                        "message": f"API端点不存在 (404)。当前URL: {base_url}\n\n提示：可以尝试启用'自动检测端点'功能，系统会自动尝试多个可能的API端点。",
                        "suggest_auto_detect": True
                    }
                else:
                    from app.services.api_config_service import ApiConfigService
                    error_message = ApiConfigService.format_error_message(e, account, "API测试")
                    return {
                        "success": False,
                        "message": f"测试失败: {error_message}"
                    }
        
        elif platform_code in ["collabglow", "cg"]:
            # 如果启用自动检测，先尝试自动检测端点
            detected_endpoint = None
            if auto_detect:
                from app.services.api_endpoint_detector import ApiEndpointDetector
                import logging
                logger = logging.getLogger(__name__)
                logger.info("[API测试] 开始自动检测CollabGlow API端点...")
                detected = ApiEndpointDetector.detect_collabglow_endpoint(token, api_url)
                if detected:
                    detected_base_url, detected_path = detected
                    detected_endpoint = f"{detected_base_url}{detected_path}"
                    logger.info(f"[API测试] 自动检测到CollabGlow端点: {detected_endpoint}")
                    # 更新账号备注，保存检测到的API URL
                    import json
                    notes_data = {}
                    if account.notes:
                        try:
                            notes_data = json.loads(account.notes)
                        except:
                            pass
                    notes_data["collabglow_api_url"] = detected_base_url
                    account.notes = json.dumps(notes_data)
                    db.commit()
            
            # 获取API配置
            api_config = ApiConfigService.get_account_api_config(account)
            base_url = api_url or (detected_endpoint.split(detected_path)[0] if detected_endpoint and 'detected_path' in locals() else None) or api_config.get("base_url")
            
            try:
                service = CollabGlowService(token=token, base_url=base_url)
                result = service.get_transactions(begin_date, end_date)
                
                if result.get("code") == "0":
                    transactions_count = len(result.get('data', {}).get('transactions', []))
                    message = f"连接成功！API URL: {base_url or '默认'}。"
                    if detected_endpoint:
                        message += f" 自动检测到可用端点。"
                    message += f" 获取到 {transactions_count} 条测试数据。"
                    return {
                        "success": True,
                        "message": message,
                        "detected_endpoint": detected_endpoint
                    }
                else:
                    # 如果失败且未启用自动检测，建议启用自动检测
                    if not auto_detect:
                        return {
                            "success": False,
                            "message": f"连接失败: {result.get('message', '未知错误')}\n\n提示：可以尝试启用'自动检测端点'功能，系统会自动尝试多个可能的API端点。",
                            "suggest_auto_detect": True
                        }
                    else:
                        return {
                            "success": False,
                            "message": f"连接失败: {result.get('message', '未知错误')}"
                        }
            except Exception as e:
                # 如果失败且未启用自动检测，建议启用自动检测
                if not auto_detect and ("404" in str(e) or "Not Found" in str(e)):
                    return {
                        "success": False,
                        "message": f"API端点不存在 (404)。当前URL: {base_url}\n\n提示：可以尝试启用'自动检测端点'功能，系统会自动尝试多个可能的API端点。",
                        "suggest_auto_detect": True
                    }
                else:
                    from app.services.api_config_service import ApiConfigService
                    error_message = ApiConfigService.format_error_message(e, account, "API测试")
                    return {
                        "success": False,
                        "message": f"测试失败: {error_message}"
                    }
        
        elif platform_code in ["lb", "pm", "bsh", "cf"]:
            # 通用平台测试
            from app.services.generic_platform_service import GenericPlatformService
            from app.services.api_config_service import ApiConfigService
            
            api_config = ApiConfigService.get_account_api_config(account)
            base_url = api_url or api_config.get("base_url")
            
            if not base_url:
                return {
                    "success": False,
                    "message": f"未配置{platform_code.upper()} API URL。请在账号备注中添加：{{\"{platform_code}_api_url\": \"https://api.example.com/api\"}}"
                }
            
            try:
                service = GenericPlatformService(
                    token=token,
                    platform_code=platform_code,
                    base_url=base_url,
                    api_config=api_config
                )
                result = service.get_transactions(begin_date, end_date)
                
                if result.get("code") == "0":
                    transactions_count = len(result.get('data', {}).get('transactions', []))
                    return {
                        "success": True,
                        "message": f"连接成功！API URL: {base_url}。获取到 {transactions_count} 条测试数据。"
                    }
                else:
                    return {
                        "success": False,
                        "message": f"连接失败: {result.get('message', '未知错误')}"
                    }
            except Exception as e:
                from app.services.api_config_service import ApiConfigService
                error_message = ApiConfigService.format_error_message(e, account, f"{platform_code.upper()} API")
                return {
                    "success": False,
                    "message": f"测试失败: {error_message}"
                }
        else:
            return {
                "success": False,
                "message": f"暂不支持测试 {account.platform.platform_name} 平台的API连接"
            }
    
    except Exception as e:
        from app.services.api_config_service import ApiConfigService
        error_message = ApiConfigService.format_error_message(e, account, "API测试")
        return {
            "success": False,
            "message": f"测试失败: {error_message}"
        }


@router.get("/platforms", response_model=List[AffiliatePlatformResponse])
async def get_platforms(db: Session = Depends(get_db)):
    """获取所有联盟平台列表"""
    import logging
    import time
    logger = logging.getLogger(__name__)
    
    try:
        start_time = time.time()
        logger.info("开始获取联盟平台列表")
        
        # 使用selectinload避免N+1查询问题，但只加载必要的数据
        # 对于简单的平台列表，不需要加载accounts关系
        platforms = db.query(AffiliatePlatform).order_by(AffiliatePlatform.platform_name).all()
        
        elapsed_time = time.time() - start_time
        logger.info(f"成功获取 {len(platforms)} 个平台，耗时 {elapsed_time:.2f} 秒")
        
        return platforms
    except Exception as e:
        logger.error(f"获取平台列表失败: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"获取平台列表失败: {str(e)}"
        )


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
    from sqlalchemy.orm import joinedload
    
    # 获取所有员工，并预加载账号和平台信息（避免N+1查询）
    employees = db.query(User).filter(User.role == UserRole.EMPLOYEE).all()
    
    # 一次性获取所有账号和平台信息
    all_accounts = db.query(AffiliateAccount).options(
        joinedload(AffiliateAccount.platform)
    ).all()
    
    # 按员工ID分组账号
    accounts_by_user = {}
    for account in all_accounts:
        user_id = account.user_id
        if user_id not in accounts_by_user:
            accounts_by_user[user_id] = []
        accounts_by_user[user_id].append(account)
    
    result = []
    for employee in employees:
        accounts = accounts_by_user.get(employee.id, [])
        
        # 统计信息
        total_accounts = len(accounts)
        active_accounts = sum(1 for acc in accounts if acc.is_active)
        
        # 按平台分组
        platforms_info = {}
        for account in accounts:
            platform = account.platform
            if not platform:
                continue
            platform_name = platform.platform_name
            if platform_name not in platforms_info:
                platforms_info[platform_name] = {
                    "platform_id": platform.id,
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
    
    # 检查账号是否存在，并预加载平台信息
    from sqlalchemy.orm import joinedload
    account = db.query(AffiliateAccount).options(
        joinedload(AffiliateAccount.platform)
    ).filter(AffiliateAccount.id == account_id).first()
    if not account:
        raise HTTPException(status_code=404, detail="账号不存在")
    
    if not account.platform:
        raise HTTPException(status_code=400, detail="账号关联的平台不存在")
    
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
        platform_code = account.platform.platform_code.lower() if account.platform.platform_code else ""
        platform_name = account.platform.platform_name.lower() if account.platform.platform_name else ""
        
        # 识别平台（同时检查代码和名称）
        is_rewardoo = (
            platform_code in ["rewardoo", "rw"] or
            platform_name in ["rw", "rewardoo"] or
            "rewardoo" in platform_code or
            "rewardoo" in platform_name
        )
        
        is_collabglow = (
            platform_code in ["collabglow", "cg", "collab-glow"] or
            platform_name in ["cg", "collabglow"] or
            "collabglow" in platform_code or
            "collabglow" in platform_name
        )
        
        is_linkhaitao = (
            platform_code in ["linkhaitao", "link-haitao", "lh", "link_haitao"] or
            platform_name in ["lh", "linkhaitao"] or
            "linkhaitao" in platform_code or
            "linkhaitao" in platform_name
        )
        
        if is_rewardoo:
            notes_data["rewardoo_token"] = token
            notes_data["rw_token"] = token
            notes_data["api_token"] = token  # 同时保存为通用字段，方便读取
        elif is_collabglow:
            notes_data["collabglow_token"] = token
            notes_data["api_token"] = token  # 同时保存为通用字段，方便读取
        elif is_linkhaitao:
            notes_data["linkhaitao_token"] = token
            notes_data["api_token"] = token  # 同时保存为通用字段，方便读取
        else:
            # 通用token字段
            notes_data["api_token"] = token
        
        account.notes = json.dumps(notes_data)
        db.commit()
    
    # 调用同步服务（传递token参数，即使已经保存到备注中，也优先使用传入的token）
    import logging
    logger = logging.getLogger(__name__)
    
    logger.info(f"开始同步账号 {account_id} 的数据，日期范围: {begin_date} ~ {end_date}")
    print(f"[同步API] 开始同步账号 {account_id}，日期范围: {begin_date} ~ {end_date}")  # 确保输出到控制台
    
    try:
        sync_service = PlatformDataSyncService(db)
        result = sync_service.sync_account_data(account_id, begin_date, end_date, token=token)
        
        logger.info(f"同步结果: success={result.get('success')}, message={result.get('message')}, saved_count={result.get('saved_count', 0)}")
        print(f"[同步API] 同步结果: success={result.get('success')}, message={result.get('message')}, saved_count={result.get('saved_count', 0)}")  # 确保输出到控制台
        
        if not result.get("success"):
            # 返回详细的错误信息，但不抛出500错误，让前端显示友好的错误提示
            error_message = result.get("message", "同步失败")
            logger.error(f"同步失败: {error_message}")
            raise HTTPException(
                status_code=400,  # 使用400而不是500，因为这是业务逻辑错误，不是服务器错误
                detail=error_message
            )
        
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"同步过程中发生异常: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"同步失败: {str(e)}"
        )




