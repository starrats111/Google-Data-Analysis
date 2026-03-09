"""
系统管理API - 日志查看等
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
from typing import Optional
import os
import logging

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User

router = APIRouter(prefix="/api/system", tags=["system"])
logger = logging.getLogger(__name__)

# 日志文件路径
LOG_FILE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uvicorn.log")


@router.get("/logs")
async def get_system_logs(
    start_time: Optional[str] = Query(None, description="开始时间 YYYY-MM-DD HH:mm:ss"),
    end_time: Optional[str] = Query(None, description="结束时间 YYYY-MM-DD HH:mm:ss"),
    level: Optional[str] = Query(None, description="日志级别: info, warning, error"),
    keyword: Optional[str] = Query(None, description="搜索关键词"),
    lines: int = Query(1000, description="最大返回行数"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取系统日志
    经理和组长可访问
    """
    # 权限检查
    if current_user.role not in ('manager', 'leader'):
        raise HTTPException(status_code=403, detail="仅经理和组长可查看系统日志")
    
    try:
        # 解析时间范围
        start_dt = None
        end_dt = None
        if start_time:
            try:
                start_dt = datetime.strptime(start_time, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                try:
                    start_dt = datetime.strptime(start_time, "%Y-%m-%d %H:%M")
                except ValueError:
                    pass
        
        if end_time:
            try:
                end_dt = datetime.strptime(end_time, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                try:
                    end_dt = datetime.strptime(end_time, "%Y-%m-%d %H:%M")
                except ValueError:
                    pass
        
        # 读取日志文件
        log_lines = []
        
        if os.path.exists(LOG_FILE_PATH):
            with open(LOG_FILE_PATH, 'r', encoding='utf-8', errors='ignore') as f:
                # 读取最后N行
                all_lines = f.readlines()
                # 取最后lines行
                recent_lines = all_lines[-lines*2:] if len(all_lines) > lines*2 else all_lines
                
                for line in recent_lines:
                    line = line.strip()
                    if not line:
                        continue
                    
                    # 时间筛选 - 尝试解析日志行中的时间
                    if start_dt or end_dt:
                        # 尝试匹配日志时间格式: 2026-02-11 16:10:33
                        try:
                            parts = line.split(' - ', 1)
                            if len(parts) >= 1:
                                time_part = parts[0].strip()
                                # 尝试多种格式
                                log_time = None
                                for fmt in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S,%f"]:
                                    try:
                                        # 提取前19个字符作为时间
                                        log_time = datetime.strptime(time_part[:19], "%Y-%m-%d %H:%M:%S")
                                        break
                                    except (ValueError, IndexError):
                                        continue
                                
                                if log_time:
                                    if start_dt and log_time < start_dt:
                                        continue
                                    if end_dt and log_time > end_dt:
                                        continue
                        except Exception:
                            # 无法解析时间，保留该行
                            pass
                    
                    # 级别筛选
                    if level:
                        line_upper = line.upper()
                        if level.lower() == 'error':
                            if 'ERROR' not in line_upper and 'CRITICAL' not in line_upper:
                                continue
                        elif level.lower() == 'warning':
                            if 'WARNING' not in line_upper and 'WARN' not in line_upper:
                                continue
                        elif level.lower() == 'info':
                            if 'INFO' not in line_upper:
                                continue
                    
                    # 关键词筛选
                    if keyword:
                        if keyword.lower() not in line.lower():
                            continue
                    
                    log_lines.append(line)
                    
                    # 限制返回行数
                    if len(log_lines) >= lines:
                        break
        else:
            log_lines.append(f"日志文件不存在: {LOG_FILE_PATH}")
            log_lines.append("请确保uvicorn日志输出到 uvicorn.log 文件")
        
        return {
            "success": True,
            "logs": "\n".join(log_lines),
            "total_lines": len(log_lines),
            "log_file": LOG_FILE_PATH,
            "time_range": {
                "start": start_time,
                "end": end_time
            }
        }
        
    except Exception as e:
        logger.error(f"获取系统日志失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/health")
async def health_check():
    """
    系统健康检查
    """
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "1.0.0"
    }


@router.get("/stats")
async def get_system_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    获取系统统计信息
    经理和组长可访问
    """
    if current_user.role not in ('manager', 'leader'):
        raise HTTPException(status_code=403, detail="仅经理和组长可查看系统统计")
    
    from app.models.user import User
    from app.models.google_ads_api_data import GoogleMccAccount, GoogleAdsApiData
    from app.models.affiliate_account import AffiliateAccount
    from app.models.affiliate_transaction import AffiliateTransaction
    from sqlalchemy import func
    
    try:
        # 统计信息
        total_users = db.query(func.count(User.id)).scalar() or 0
        total_employees = db.query(func.count(User.id)).filter(User.role == 'employee').scalar() or 0
        total_mccs = db.query(func.count(GoogleMccAccount.id)).scalar() or 0
        total_accounts = db.query(func.count(AffiliateAccount.id)).scalar() or 0
        
        # 今日数据
        today = datetime.now().date()
        today_campaigns = db.query(func.count(GoogleAdsApiData.id)).filter(
            GoogleAdsApiData.date == today
        ).scalar() or 0
        today_transactions = db.query(func.count(AffiliateTransaction.id)).filter(
            func.date(AffiliateTransaction.transaction_time) == today
        ).scalar() or 0
        
        return {
            "total_users": total_users,
            "total_employees": total_employees,
            "total_mccs": total_mccs,
            "total_platform_accounts": total_accounts,
            "today_campaign_records": today_campaigns,
            "today_transactions": today_transactions,
            "timestamp": datetime.utcnow().isoformat()
        }
        
    except Exception as e:
        logger.error(f"获取系统统计失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reencrypt-tokens")
async def reencrypt_tokens(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修复加密 bug 后，重新加密所有平台账号的 API token。
    从 notes JSON 中读取明文 token，用修复后的 encrypt_token 重新加密。
    """
    if current_user.role not in ("admin", "manager"):
        raise HTTPException(status_code=403, detail="仅管理员可执行")

    from app.models.affiliate_account import AffiliateAccount
    from app.utils.crypto import encrypt_token, decrypt_token
    import json as _json

    accounts = db.query(AffiliateAccount).filter(AffiliateAccount.is_active.is_(True)).all()
    fixed = 0
    skipped = 0
    errors_list = []

    for acct in accounts:
        # 尝试从 notes 中获取明文 token
        plaintext_token = None
        if acct.notes:
            try:
                notes = _json.loads(acct.notes)
                for k in ("api_token", "token", "collabglow_token", "rewardoo_token",
                           "linkhaitao_token", "creatorflare_token", "linkbux_token",
                           "rw_token", "cf_token", "lb_token", "bsh_token", "pm_token"):
                    if notes.get(k):
                        plaintext_token = notes[k]
                        break
            except Exception:
                pass

        if not plaintext_token:
            # 尝试解密现有的（可能已损坏）
            if acct.api_token_encrypted:
                try:
                    plaintext_token = decrypt_token(acct.api_token_encrypted)
                except Exception:
                    pass

        if plaintext_token:
            try:
                acct.api_token_encrypted = encrypt_token(plaintext_token)
                # 验证加密结果
                verify = decrypt_token(acct.api_token_encrypted)
                if verify == plaintext_token:
                    fixed += 1
                else:
                    errors_list.append(f"{acct.account_name}: 验证失败")
            except Exception as e:
                errors_list.append(f"{acct.account_name}: {e}")
        else:
            skipped += 1

    db.commit()
    return {
        "fixed": fixed,
        "skipped": skipped,
        "errors": errors_list,
    }

