"""
数据权限服务
根据用户角色控制数据访问范围

权限规则：
- manager: 查看/编辑/删除所有用户数据
- leader: 查看/编辑/删除本组成员数据
- member: 仅查看/编辑自己的数据
"""

from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import and_

from app.models.user import User, UserRole
from app.models.team import Team


class PermissionService:
    """数据权限服务"""
    
    def __init__(self, db: Session, current_user: User):
        self.db = db
        self.current_user = current_user
    
    @property
    def is_manager(self) -> bool:
        """是否为经理"""
        return self.current_user.role == UserRole.MANAGER
    
    @property
    def is_leader(self) -> bool:
        """是否为组长"""
        return self.current_user.role == UserRole.LEADER
    
    @property
    def is_member(self) -> bool:
        """是否为普通组员"""
        return self.current_user.role in (UserRole.MEMBER, UserRole.EMPLOYEE)
    
    def get_accessible_user_ids(self) -> List[int]:
        """
        获取当前用户可访问的用户ID列表
        
        Returns:
            List[int]: 可访问的用户ID列表
        """
        if self.is_manager:
            # 经理可以访问所有用户
            users = self.db.query(User.id).all()
            return [u[0] for u in users]
        
        elif self.is_leader:
            # 组长可以访问本组所有成员
            if not self.current_user.team_id:
                return [self.current_user.id]
            
            team_members = self.db.query(User.id).filter(
                User.team_id == self.current_user.team_id
            ).all()
            return [u[0] for u in team_members]
        
        else:
            # 普通成员只能访问自己
            return [self.current_user.id]
    
    def get_accessible_team_ids(self) -> Optional[List[int]]:
        """
        获取当前用户可访问的小组ID列表
        
        Returns:
            List[int] | None: 可访问的小组ID列表，None 表示可访问所有小组
        """
        if self.is_manager:
            return None  # None 表示所有小组
        
        elif self.is_leader:
            if self.current_user.team_id:
                return [self.current_user.team_id]
            return []
        
        else:
            if self.current_user.team_id:
                return [self.current_user.team_id]
            return []
    
    def can_view_user(self, target_user_id: int) -> bool:
        """检查是否可以查看指定用户的数据"""
        return target_user_id in self.get_accessible_user_ids()
    
    def can_edit_user(self, target_user_id: int) -> bool:
        """检查是否可以编辑指定用户的数据"""
        if self.is_manager:
            return True
        
        if self.is_leader:
            # 组长可以编辑本组成员
            target_user = self.db.query(User).filter(User.id == target_user_id).first()
            if target_user and target_user.team_id == self.current_user.team_id:
                return True
            return False
        
        # 普通成员只能编辑自己
        return target_user_id == self.current_user.id
    
    def can_delete_user(self, target_user_id: int) -> bool:
        """检查是否可以删除指定用户的数据"""
        # 与编辑权限相同
        return self.can_edit_user(target_user_id)
    
    def can_manage_team(self, team_id: int) -> bool:
        """检查是否可以管理指定小组"""
        if self.is_manager:
            return True
        
        if self.is_leader:
            return self.current_user.team_id == team_id
        
        return False
    
    def filter_by_permission(self, query, user_id_column):
        """
        为查询添加权限过滤
        
        Args:
            query: SQLAlchemy 查询对象
            user_id_column: 用户ID字段（如 AnalysisResult.user_id）
        
        Returns:
            添加了权限过滤的查询对象
        """
        accessible_ids = self.get_accessible_user_ids()
        return query.filter(user_id_column.in_(accessible_ids))
    
    def get_team_info(self) -> dict:
        """获取当前用户的小组信息"""
        if not self.current_user.team_id:
            return None
        
        team = self.db.query(Team).filter(Team.id == self.current_user.team_id).first()
        if not team:
            return None
        
        return {
            "id": team.id,
            "code": team.team_code,
            "name": team.team_name,
            "is_leader": self.is_leader
        }


def get_permission_service(db: Session, current_user: User) -> PermissionService:
    """获取权限服务实例"""
    return PermissionService(db, current_user)

