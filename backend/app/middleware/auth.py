"""
认证中间件

安全改进:
- 使用 utc_now() 替代 datetime.utcnow()（兼容 SQLite + jose）
- 支持 Refresh Token 机制
- Access Token 包含 type: "access" 声明
"""
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import Depends, HTTPException, status, Response, Request
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session
import bcrypt

from app.config import settings
from app.database import get_db
from app.models.user import User


def utc_now() -> datetime:
    """获取当前 UTC 时间（naive datetime，兼容 SQLite 和 jose）"""
    return datetime.now(timezone.utc).replace(tzinfo=None)

# OAuth2 scheme
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """验证密码"""
    try:
        return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))
    except Exception:
        return False


def get_password_hash(password: str) -> str:
    """获取密码哈希"""
    # 确保密码不超过 72 字节（bcrypt 限制）
    password_bytes = password.encode('utf-8')
    if len(password_bytes) > 72:
        password_bytes = password_bytes[:72]
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password_bytes, salt)
    return hashed.decode('utf-8')


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """创建访问令牌（Access Token）
    
    包含 type: "access" 声明，用于区分 Access Token 和 Refresh Token
    """
    to_encode = data.copy()
    if expires_delta:
        expire = utc_now() + expires_delta
    else:
        expire = utc_now() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({
        "exp": expire,
        "type": "access"  # 标识为 Access Token
    })
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt


def create_refresh_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """创建刷新令牌（Refresh Token）
    
    使用独立的 REFRESH_SECRET_KEY，有效期更长（默认7天）
    """
    to_encode = data.copy()
    if expires_delta:
        expire = utc_now() + expires_delta
    else:
        expire = utc_now() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({
        "exp": expire,
        "type": "refresh"  # 标识为 Refresh Token
    })
    # 使用独立密钥，如果未配置则回退到主密钥
    secret_key = settings.REFRESH_SECRET_KEY or settings.SECRET_KEY
    encoded_jwt = jwt.encode(to_encode, secret_key, algorithm=settings.ALGORITHM)
    return encoded_jwt


def verify_refresh_token(token: str) -> Optional[str]:
    """验证 Refresh Token 并返回用户名
    
    Returns:
        用户名（如果验证成功），否则返回 None
    """
    try:
        secret_key = settings.REFRESH_SECRET_KEY or settings.SECRET_KEY
        payload = jwt.decode(token, secret_key, algorithms=[settings.ALGORITHM])
        
        # 验证 token 类型
        token_type = payload.get("type")
        if token_type != "refresh":
            return None
        
        username: str = payload.get("sub")
        return username
    except JWTError:
        return None


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    """获取当前用户
    
    验证 Access Token 并返回对应用户
    注意：只接受 type="access" 的 token
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        
        # 验证 token 类型（兼容旧 token，没有 type 字段的视为 access）
        token_type = payload.get("type", "access")
        if token_type != "access":
            raise credentials_exception
        
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception
    return user


async def get_current_manager(
    current_user: User = Depends(get_current_user)
) -> User:
    """获取当前经理用户"""
    if current_user.role != "manager":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not enough permissions"
        )
    return current_user


async def get_current_manager_or_leader(
    current_user: User = Depends(get_current_user)
) -> User:
    """获取经理或组长用户
    
    权限检查顺序：manager > leader > member/employee
    """
    # 先检查 manager（最高权限）
    if current_user.role == "manager":
        return current_user
    # 再检查 leader
    if current_user.role == "leader":
        return current_user
    # 其他角色拒绝
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="仅经理或组长可访问"
    )


# 露出功能授权用户列表 (wj01-wj10)
LUCHU_AUTHORIZED_USERS = [f"wj{str(i).zfill(2)}" for i in range(1, 11)]  # wj01, wj02, ..., wj10


async def get_luchu_authorized_user(
    current_user: User = Depends(get_current_user)
) -> User:
    """
    获取有露出功能权限的用户
    只有 wj01-wj10 可以使用露出功能
    """
    if current_user.username not in LUCHU_AUTHORIZED_USERS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="您没有露出功能的使用权限"
        )
    return current_user




