"""
阶段标签API
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from urllib.parse import unquote

from app.database import get_db
from app.services.stage_label_service import StageLabelService

router = APIRouter(prefix="/api/stage-label", tags=["stage-label"])


@router.get("/{label}")
async def get_stage_label_detail(
    label: str,
    db: Session = Depends(get_db)
):
    """获取阶段标签详情"""
    try:
        # URL解码
        decoded_label = unquote(label)
        
        # 加载阶段标签服务
        service = StageLabelService()
        rules = service.load_rules()
        
        # 查找匹配的规则
        for rule in rules:
            if rule['label'] == decoded_label:
                return {
                    "label": rule['label'],
                    "when_to_use": rule.get('when_to_use', ''),
                    "action_ad": rule.get('action_ad', ''),
                    "action_data": rule.get('action_data', ''),
                    "action_risk": rule.get('action_risk', ''),
                    "trigger_conditions": rule.get('trigger_conditions', ''),
                }
        
        # 如果没有找到，返回默认信息
        return {
            "label": decoded_label,
            "when_to_use": "请查看表4.xlsx了解详细说明",
            "action_ad": "请查看表4.xlsx了解详细操作",
            "action_data": "请查看表4.xlsx了解详细操作",
            "action_risk": "请查看表4.xlsx了解详细操作",
            "trigger_conditions": "",
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"获取阶段标签详情失败: {str(e)}")











