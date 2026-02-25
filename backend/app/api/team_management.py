"""
团队管理 API
仅经理可访问
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List, Optional
from pydantic import BaseModel
from datetime import datetime
from passlib.context import CryptContext

from app.database import get_db
from app.models.user import User, UserRole
from app.models.team import Team
from app.models.google_ads_api_data import GoogleAdsApiData
from app.models.affiliate_transaction import AffiliateTransaction
from app.middleware.auth import get_current_user
from app.services.permission_service import PermissionService

router = APIRouter(prefix="/api/team", tags=["团队管理"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


# ========== Pydantic Models ==========

class TeamBase(BaseModel):
    team_code: str
    team_name: str

class TeamCreate(TeamBase):
    pass

class TeamUpdate(BaseModel):
    team_name: Optional[str] = None
    leader_id: Optional[int] = None

class TeamResponse(TeamBase):
    id: int
    leader_id: Optional[int]
    leader_name: Optional[str] = None
    member_count: int = 0
    created_at: Optional[datetime]
    
    class Config:
        from_attributes = True

class UserBase(BaseModel):
    username: str
    display_name: Optional[str] = None
    role: str
    team_id: Optional[int] = None

class UserCreate(UserBase):
    password: str

class UserUpdate(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    team_id: Optional[int] = None
    password: Optional[str] = None

class UserResponse(BaseModel):
    id: int
    username: str
    display_name: Optional[str]
    role: str
    team_id: Optional[int]
    team_code: Optional[str] = None
    team_name: Optional[str] = None
    created_at: Optional[datetime]
    
    class Config:
        from_attributes = True

class TeamStatsResponse(BaseModel):
    team_code: str
    team_name: str
    member_count: int
    total_cost: float
    total_commission: float  # 总佣金（所有状态）
    rejected_commission: float  # 拒付佣金
    net_commission: float  # 净佣金（总佣金 - 拒付佣金）
    total_profit: float  # 利润（净佣金 - 费用）
    avg_roi: float

class MemberRankingResponse(BaseModel):
    user_id: int
    username: str
    display_name: Optional[str]
    team_code: Optional[str]
    team_name: Optional[str]
    cost: float
    commission: float  # 总佣金
    rejected_commission: float  # 拒付佣金
    net_commission: float  # 净佣金
    profit: float  # 利润（基于净佣金）
    roi: float


# ========== Helper Functions ==========

def require_manager(current_user: User = Depends(get_current_user)):
    """要求经理权限"""
    if current_user.role != UserRole.MANAGER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅经理可访问此功能"
        )
    return current_user

def require_leader_or_manager(current_user: User = Depends(get_current_user)):
    """要求组长或经理权限"""
    if current_user.role not in (UserRole.MANAGER, UserRole.LEADER):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅组长或经理可访问此功能"
        )
    return current_user


# ========== Team APIs ==========

@router.get("/teams", response_model=List[TeamResponse])
async def get_teams(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """获取所有小组列表"""
    teams = db.query(Team).all()
    
    result = []
    for team in teams:
        # 获取组长信息
        leader_name = None
        if team.leader_id:
            leader = db.query(User).filter(User.id == team.leader_id).first()
            if leader:
                leader_name = leader.display_name or leader.username
        
        # 获取成员数量
        member_count = db.query(User).filter(User.team_id == team.id).count()
        
        result.append(TeamResponse(
            id=team.id,
            team_code=team.team_code,
            team_name=team.team_name,
            leader_id=team.leader_id,
            leader_name=leader_name,
            member_count=member_count,
            created_at=team.created_at
        ))
    
    return result


@router.post("/teams", response_model=TeamResponse)
async def create_team(
    team_data: TeamCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """创建小组"""
    # 检查 team_code 是否已存在
    existing = db.query(Team).filter(Team.team_code == team_data.team_code).first()
    if existing:
        raise HTTPException(status_code=400, detail="小组代码已存在")
    
    team = Team(
        team_code=team_data.team_code,
        team_name=team_data.team_name
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    
    return TeamResponse(
        id=team.id,
        team_code=team.team_code,
        team_name=team.team_name,
        leader_id=None,
        member_count=0,
        created_at=team.created_at
    )


@router.put("/teams/{team_id}", response_model=TeamResponse)
async def update_team(
    team_id: int,
    team_data: TeamUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """更新小组"""
    team = db.query(Team).filter(Team.id == team_id).first()
    if not team:
        raise HTTPException(status_code=404, detail="小组不存在")
    
    if team_data.team_name is not None:
        team.team_name = team_data.team_name
    if team_data.leader_id is not None:
        team.leader_id = team_data.leader_id
    
    db.commit()
    db.refresh(team)
    
    member_count = db.query(User).filter(User.team_id == team.id).count()
    
    return TeamResponse(
        id=team.id,
        team_code=team.team_code,
        team_name=team.team_name,
        leader_id=team.leader_id,
        member_count=member_count,
        created_at=team.created_at
    )


@router.delete("/teams/{team_id}")
async def delete_team(
    team_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """删除小组"""
    team = db.query(Team).filter(Team.id == team_id).first()
    if not team:
        raise HTTPException(status_code=404, detail="小组不存在")
    
    # 检查是否有成员
    member_count = db.query(User).filter(User.team_id == team_id).count()
    if member_count > 0:
        raise HTTPException(status_code=400, detail=f"小组下还有 {member_count} 名成员，无法删除")
    
    db.delete(team)
    db.commit()
    
    return {"success": True, "message": "小组已删除"}


# ========== User APIs ==========

@router.get("/users", response_model=List[UserResponse])
async def get_users(
    team_id: Optional[int] = None,
    role: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_leader_or_manager)
):
    """获取用户列表"""
    perm = PermissionService(db, current_user)
    
    query = db.query(User)
    
    # 权限过滤
    if current_user.role == UserRole.LEADER:
        # 组长只能看本组成员
        query = query.filter(User.team_id == current_user.team_id)
    
    # 筛选条件
    if team_id is not None:
        query = query.filter(User.team_id == team_id)
    if role:
        query = query.filter(User.role == role)
    
    users = query.order_by(User.username).all()
    
    result = []
    for user in users:
        team_code = None
        team_name = None
        if user.team_id:
            team = db.query(Team).filter(Team.id == user.team_id).first()
            if team:
                team_code = team.team_code
                team_name = team.team_name
        
        result.append(UserResponse(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            role=user.role.value if hasattr(user.role, 'value') else str(user.role),
            team_id=user.team_id,
            team_code=team_code,
            team_name=team_name,
            created_at=user.created_at
        ))
    
    return result


@router.post("/users", response_model=UserResponse)
async def create_user(
    user_data: UserCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """创建用户"""
    # 检查用户名是否已存在
    existing = db.query(User).filter(User.username == user_data.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="用户名已存在")
    
    # 验证角色
    try:
        role = UserRole(user_data.role)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"无效的角色: {user_data.role}")
    
    user = User(
        username=user_data.username,
        password_hash=pwd_context.hash(user_data.password),
        display_name=user_data.display_name,
        role=role,
        team_id=user_data.team_id
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    
    return UserResponse(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role.value,
        team_id=user.team_id,
        created_at=user.created_at
    )


@router.put("/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    user_data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_leader_or_manager)
):
    """更新用户"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    
    # 权限检查
    perm = PermissionService(db, current_user)
    if not perm.can_edit_user(user_id):
        raise HTTPException(status_code=403, detail="无权编辑此用户")
    
    # 组长不能修改角色和小组
    if current_user.role == UserRole.LEADER:
        if user_data.role is not None or user_data.team_id is not None:
            raise HTTPException(status_code=403, detail="组长无权修改用户角色或小组")
    
    if user_data.display_name is not None:
        user.display_name = user_data.display_name
    if user_data.role is not None and current_user.role == UserRole.MANAGER:
        try:
            user.role = UserRole(user_data.role)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"无效的角色: {user_data.role}")
    if user_data.team_id is not None and current_user.role == UserRole.MANAGER:
        user.team_id = user_data.team_id
    if user_data.password:
        user.password_hash = pwd_context.hash(user_data.password)
    
    db.commit()
    db.refresh(user)
    
    team_code = None
    team_name = None
    if user.team_id:
        team = db.query(Team).filter(Team.id == user.team_id).first()
        if team:
            team_code = team.team_code
            team_name = team.team_name
    
    return UserResponse(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role.value if hasattr(user.role, 'value') else str(user.role),
        team_id=user.team_id,
        team_code=team_code,
        team_name=team_name,
        created_at=user.created_at
    )


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """删除用户"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    
    # 不能删除自己
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="不能删除自己的账号")
    
    # 不能删除经理
    if user.role == UserRole.MANAGER:
        raise HTTPException(status_code=400, detail="不能删除经理账号")
    
    db.delete(user)
    db.commit()
    
    return {"success": True, "message": "用户已删除"}


class ResetPasswordRequest(BaseModel):
    new_password: str


@router.post("/users/{user_id}/reset-password")
async def reset_password(
    user_id: int,
    body: ResetPasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_manager)
):
    """重置用户密码（经理指定新密码）"""
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="密码长度不能少于6位")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    user.password_hash = pwd_context.hash(body.new_password)
    db.commit()

    return {"success": True, "message": f"用户 {user.username} 的密码已重置"}


# ========== Statistics APIs ==========

@router.get("/stats/teams", response_model=List[TeamStatsResponse])
async def get_team_stats(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_leader_or_manager)
):
    """获取小组统计数据（仅统计普通组员，排除组长和经理）"""
    teams = db.query(Team).all()
    
    perm = PermissionService(db, current_user)
    accessible_team_ids = perm.get_accessible_team_ids()
    
    result = []
    for team in teams:
        # 权限检查
        if accessible_team_ids is not None and team.id not in accessible_team_ids:
            continue
        
        # 获取组内成员 - 排除 manager 和 leader 角色
        member_ids = [u.id for u in db.query(User.id).filter(
            User.team_id == team.id,
            User.role.notin_([UserRole.MANAGER, UserRole.LEADER])
        ).all()]
        member_count = len(member_ids)
        
        if not member_ids:
            result.append(TeamStatsResponse(
                team_code=team.team_code,
                team_name=team.team_name,
                member_count=0,
                total_cost=0,
                total_commission=0,
                rejected_commission=0,
                net_commission=0,
                total_profit=0,
                avg_roi=0
            ))
            continue
        
        # 计算费用（Google Ads）
        cost_query = db.query(func.sum(GoogleAdsApiData.cost)).filter(
            GoogleAdsApiData.user_id.in_(member_ids)
        )
        if start_date:
            cost_query = cost_query.filter(GoogleAdsApiData.date >= start_date)
        if end_date:
            cost_query = cost_query.filter(GoogleAdsApiData.date <= end_date)
        total_cost = float(cost_query.scalar() or 0)
        
        # 计算总佣金（所有状态）
        total_commission_query = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
            AffiliateTransaction.user_id.in_(member_ids)
        )
        if start_date:
            total_commission_query = total_commission_query.filter(AffiliateTransaction.transaction_time >= start_date)
        if end_date:
            total_commission_query = total_commission_query.filter(AffiliateTransaction.transaction_time <= end_date)
        total_commission = float(total_commission_query.scalar() or 0)
        
        # 计算拒付佣金
        rejected_query = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
            AffiliateTransaction.user_id.in_(member_ids),
            AffiliateTransaction.status == 'rejected'
        )
        if start_date:
            rejected_query = rejected_query.filter(AffiliateTransaction.transaction_time >= start_date)
        if end_date:
            rejected_query = rejected_query.filter(AffiliateTransaction.transaction_time <= end_date)
        rejected_commission = float(rejected_query.scalar() or 0)
        
        # 净佣金 = 总佣金 - 拒付佣金
        net_commission = total_commission - rejected_commission
        
        # 利润基于净佣金计算
        total_profit = net_commission - total_cost
        avg_roi = (total_profit / total_cost * 100) if total_cost > 0 else 0
        
        result.append(TeamStatsResponse(
            team_code=team.team_code,
            team_name=team.team_name,
            member_count=member_count,
            total_cost=round(total_cost, 2),
            total_commission=round(total_commission, 2),
            rejected_commission=round(rejected_commission, 2),
            net_commission=round(net_commission, 2),
            total_profit=round(total_profit, 2),
            avg_roi=round(avg_roi, 1)
        ))
    
    return result


@router.get("/stats/ranking", response_model=List[MemberRankingResponse])
async def get_member_ranking(
    team_id: Optional[int] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    sort_by: str = "roi",  # roi, cost, commission
    limit: int = 10,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_leader_or_manager)
):
    """获取成员排行榜（仅包含普通组员，排除组长和经理）"""
    perm = PermissionService(db, current_user)
    accessible_ids = perm.get_accessible_user_ids()
    
    # 筛选用户 - 排除 manager 和 leader 角色
    query = db.query(User).filter(
        User.id.in_(accessible_ids),
        User.role.notin_([UserRole.MANAGER, UserRole.LEADER])
    )
    if team_id:
        query = query.filter(User.team_id == team_id)
    users = query.all()
    
    rankings = []
    for user in users:
        # 计算费用
        cost_query = db.query(func.sum(GoogleAdsApiData.cost)).filter(
            GoogleAdsApiData.user_id == user.id
        )
        if start_date:
            cost_query = cost_query.filter(GoogleAdsApiData.date >= start_date)
        if end_date:
            cost_query = cost_query.filter(GoogleAdsApiData.date <= end_date)
        cost = float(cost_query.scalar() or 0)
        
        # 计算总佣金（所有状态）
        total_commission_query = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
            AffiliateTransaction.user_id == user.id
        )
        if start_date:
            total_commission_query = total_commission_query.filter(AffiliateTransaction.transaction_time >= start_date)
        if end_date:
            total_commission_query = total_commission_query.filter(AffiliateTransaction.transaction_time <= end_date)
        commission = float(total_commission_query.scalar() or 0)
        
        # 计算拒付佣金
        rejected_query = db.query(func.sum(AffiliateTransaction.commission_amount)).filter(
            AffiliateTransaction.user_id == user.id,
            AffiliateTransaction.status == 'rejected'
        )
        if start_date:
            rejected_query = rejected_query.filter(AffiliateTransaction.transaction_time >= start_date)
        if end_date:
            rejected_query = rejected_query.filter(AffiliateTransaction.transaction_time <= end_date)
        rejected_commission = float(rejected_query.scalar() or 0)
        
        # 净佣金 = 总佣金 - 拒付佣金
        net_commission = commission - rejected_commission
        
        # 利润基于净佣金计算
        profit = net_commission - cost
        roi = (profit / cost * 100) if cost > 0 else 0
        
        team_code = None
        team_name = None
        if user.team_id:
            team = db.query(Team).filter(Team.id == user.team_id).first()
            if team:
                team_code = team.team_code
                team_name = team.team_name
        
        rankings.append(MemberRankingResponse(
            user_id=user.id,
            username=user.username,
            display_name=user.display_name,
            team_code=team_code,
            team_name=team_name,
            cost=round(cost, 2),
            commission=round(commission, 2),
            rejected_commission=round(rejected_commission, 2),
            net_commission=round(net_commission, 2),
            profit=round(profit, 2),
            roi=round(roi, 1)
        ))
    
    # 根据 sort_by 参数排序
    if sort_by == "cost":
        rankings.sort(key=lambda x: x.cost, reverse=True)
    elif sort_by == "commission":
        rankings.sort(key=lambda x: x.commission, reverse=True)
    else:  # 默认按 ROI
        rankings.sort(key=lambda x: x.roi, reverse=True)
    
    return rankings[:limit]


@router.get("/me/info")
async def get_my_info(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """获取当前用户信息（含权限）"""
    team_info = None
    if current_user.team_id:
        team = db.query(Team).filter(Team.id == current_user.team_id).first()
        if team:
            team_info = {
                "id": team.id,
                "code": team.team_code,
                "name": team.team_name
            }
    
    return {
        "id": current_user.id,
        "username": current_user.username,
        "display_name": current_user.display_name,
        "role": current_user.role.value if hasattr(current_user.role, 'value') else str(current_user.role),
        "team": team_info,
        "permissions": {
            "is_manager": current_user.role == UserRole.MANAGER,
            "is_leader": current_user.role == UserRole.LEADER,
            "can_view_all_teams": current_user.role == UserRole.MANAGER,
            "can_view_team": current_user.role in (UserRole.MANAGER, UserRole.LEADER),
            "can_manage_users": current_user.role == UserRole.MANAGER,
            "can_edit_team_members": current_user.role in (UserRole.MANAGER, UserRole.LEADER)
        }
    }


# ========== 团队数据同步 ==========

def _do_team_sync_background(user_ids: list, sync_type: str):
    """在后台线程中执行团队数据同步"""
    import logging
    import threading
    from datetime import date, timedelta
    from app.database import SessionLocal
    from app.models.affiliate_account import AffiliateAccount
    from app.models.google_mcc_account import GoogleMccAccount
    
    logger = logging.getLogger(__name__)
    logger.info(f"[后台同步] 开始团队数据同步，用户数量: {len(user_ids)}, 类型: {sync_type}")
    
    db = SessionLocal()
    try:
        end_date = date.today()
        start_date = end_date - timedelta(days=2)  # 最近3天
        
        if sync_type in ('platform', 'all'):
            # 同步平台数据
            from app.services.platform_data_sync import PlatformDataSyncService
            sync_service = PlatformDataSyncService(db)
            
            accounts = db.query(AffiliateAccount).filter(
                AffiliateAccount.user_id.in_(user_ids),
                AffiliateAccount.is_active == True
            ).all()
            
            synced_count = 0
            for account in accounts:
                try:
                    result = sync_service.sync_account_data(
                        account_id=account.id,
                        begin_date=start_date.strftime("%Y-%m-%d"),
                        end_date=end_date.strftime("%Y-%m-%d")
                    )
                    if result.get("success"):
                        synced_count += 1
                except Exception as e:
                    logger.error(f"[后台同步] 同步账号 {account.id} 失败: {e}")
            
            logger.info(f"[后台同步] 平台数据同步完成: {synced_count}/{len(accounts)} 个账号")
        
        if sync_type in ('google', 'all'):
            # 同步Google Ads数据
            from app.services.google_ads_service_account_sync import GoogleAdsServiceAccountSync
            sync_service = GoogleAdsServiceAccountSync(db)
            
            mccs = db.query(GoogleMccAccount).filter(
                GoogleMccAccount.user_id.in_(user_ids),
                GoogleMccAccount.is_active == True
            ).all()
            
            synced_count = 0
            for mcc in mccs:
                try:
                    current_date = start_date
                    while current_date <= end_date:
                        sync_service.sync_mcc_data(
                            mcc_id=mcc.id,
                            target_date=current_date,
                            force_refresh=True
                        )
                        current_date += timedelta(days=1)
                    synced_count += 1
                except Exception as e:
                    logger.error(f"[后台同步] 同步MCC {mcc.id} 失败: {e}")
            
            logger.info(f"[后台同步] Google Ads同步完成: {synced_count}/{len(mccs)} 个MCC")
        
        logger.info(f"[后台同步] 团队数据同步全部完成")
        
    except Exception as e:
        logger.error(f"[后台同步] 团队同步出错: {e}", exc_info=True)
    finally:
        db.close()


@router.post("/sync-team-data")
async def sync_team_data(
    sync_type: str = "all",  # platform, google, all
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    同步团队数据（仅限组长和经理）
    - 组长：同步本组所有成员的数据
    - 经理：同步所有用户的数据
    """
    import threading
    import logging
    
    logger = logging.getLogger(__name__)
    
    # 权限检查
    if current_user.role not in (UserRole.LEADER, UserRole.MANAGER):
        raise HTTPException(status_code=403, detail="仅限组长和经理使用此功能")
    
    # 获取需要同步的用户列表
    if current_user.role == UserRole.MANAGER:
        # 经理：获取所有用户
        users = db.query(User).filter(User.role == UserRole.MEMBER).all()
        user_ids = [u.id for u in users]
        scope = "全部团队"
    else:
        # 组长：获取本组成员
        users = db.query(User).filter(
            User.team_id == current_user.team_id,
            User.role == UserRole.MEMBER
        ).all()
        user_ids = [u.id for u in users]
        
        # 获取组名
        team = db.query(Team).filter(Team.id == current_user.team_id).first()
        scope = team.team_name if team else "本组"
    
    if not user_ids:
        return {
            "success": True,
            "message": "没有找到需要同步的用户",
            "user_count": 0,
            "background": False
        }
    
    logger.info(f"用户 {current_user.username} 触发团队数据同步，范围: {scope}, 用户数: {len(user_ids)}")
    
    # 在后台线程中执行同步
    sync_thread = threading.Thread(
        target=_do_team_sync_background,
        args=(user_ids, sync_type)
    )
    sync_thread.daemon = True
    sync_thread.start()
    
    return {
        "success": True,
        "message": f"同步已在后台开始，正在同步 {scope} 的 {len(user_ids)} 个用户数据，请稍后刷新页面",
        "user_count": len(user_ids),
        "scope": scope,
        "sync_type": sync_type,
        "background": True
    }

