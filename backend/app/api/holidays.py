"""
节日营销 API — 节日列表查询 + AI 推荐商家
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.services.holiday_service import get_upcoming_holidays, recommend_merchants_for_holiday

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/holidays", tags=["节日营销"])


@router.get("")
async def list_holidays(
    country: str = Query("US", description="国家代码"),
    days: int = Query(30, ge=7, le=90, description="未来天数"),
    current_user: User = Depends(get_current_user),
):
    """查询指定国家未来 N 天内的节日"""
    holidays = get_upcoming_holidays(country.upper(), days)
    return {"country": country.upper(), "days": days, "holidays": holidays}


class RecommendRequest(BaseModel):
    holiday_name: str
    country: str = "US"


@router.post("/recommend-merchants")
async def recommend_merchants(
    data: RecommendRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """根据节日推荐商家"""
    merchants = recommend_merchants_for_holiday(
        holiday_name=data.holiday_name,
        country_code=data.country.upper(),
        db=db,
        user_id=current_user.id,
    )
    return {
        "holiday_name": data.holiday_name,
        "country": data.country.upper(),
        "total": len(merchants),
        "merchants": merchants,
    }
