"""
数据处理工具函数
包含EPC和ROI的计算函数
"""
import numpy as np
from typing import Optional


def calculate_conservative_epc(commission: float, clicks: int) -> Optional[float]:
    """
    计算保守EPC（Earnings Per Click）
    
    公式：保守EPC = 保守佣金 / 点击
    
    参数:
        commission: 保守佣金
        clicks: 点击次数
    
    返回:
        保守EPC值，如果点击为0或输入无效则返回None
    
    示例:
        >>> calculate_conservative_epc(100, 50)
        2.0
        >>> calculate_conservative_epc(100, 0)
        None
    """
    if clicks == 0 or clicks is None or commission is None:
        return None
    
    try:
        result = commission / clicks
        if np.isinf(result) or np.isnan(result):
            return None
        return round(result, 4)
    except (ZeroDivisionError, TypeError, ValueError):
        return None


def calculate_conservative_roi(epc: float, cpc: float) -> Optional[float]:
    """
    计算保守ROI（Return on Investment）
    
    公式：保守ROI = (保守EPC - CPC) / CPC × 100%
    
    参数:
        epc: 保守EPC
        cpc: 每次点击成本（Cost Per Click）
    
    返回:
        保守ROI（百分比），如果CPC为0或输入无效则返回None
    
    示例:
        >>> calculate_conservative_roi(2.0, 1.0)
        100.0
        >>> calculate_conservative_roi(1.5, 1.0)
        50.0
        >>> calculate_conservative_roi(0.5, 1.0)
        -50.0
        >>> calculate_conservative_roi(2.0, 0)
        None
    """
    if cpc == 0 or cpc is None or epc is None:
        return None
    
    try:
        result = ((epc - cpc) / cpc) * 100
        if np.isinf(result) or np.isnan(result):
            return None
        return round(result, 2)
    except (ZeroDivisionError, TypeError, ValueError):
        return None


def validate_calculation_inputs(commission: float, clicks: int, cpc: float) -> tuple[bool, Optional[str]]:
    """
    验证计算输入的合法性
    
    参数:
        commission: 保守佣金
        clicks: 点击次数
        cpc: 每次点击成本
    
    返回:
        (是否有效, 错误信息)
    """
    if commission is None or commission < 0:
        return False, "保守佣金必须大于等于0"
    
    if clicks is None or clicks < 0:
        return False, "点击次数必须大于等于0"
    
    if cpc is None or cpc < 0:
        return False, "CPC必须大于等于0"
    
    return True, None

















