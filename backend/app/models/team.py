"""
团队/小组模型
"""
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class Team(Base):
    """团队/小组表"""
    __tablename__ = "teams"
    
    id = Column(Integer, primary_key=True, index=True)
    team_code = Column(String(20), unique=True, nullable=False, index=True)  # 'wj', 'jy', 'yz'
    team_name = Column(String(50), nullable=False)  # '文俊组', '静怡组', '雅芝组'
    leader_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # 组长用户ID
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 关系
    members = relationship("User", back_populates="team", foreign_keys="User.team_id")
    leader = relationship("User", foreign_keys=[leader_id], post_update=True)
    
    def __repr__(self):
        return f"<Team {self.team_code}: {self.team_name}>"

