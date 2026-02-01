"""
测试数据分析计算公式
"""
import pytest
from app.utils.data_processor import (
    calculate_conservative_epc,
    calculate_conservative_roi,
    validate_calculation_inputs
)


class TestCalculations:
    """测试计算函数"""
    
    def test_calculate_conservative_epc_normal(self):
        """测试正常情况下的EPC计算"""
        # 保守佣金=100，点击=50，EPC应该=2
        result = calculate_conservative_epc(100, 50)
        assert result == 2.0
    
    def test_calculate_conservative_epc_zero_clicks(self):
        """测试点击数为0的情况"""
        result = calculate_conservative_epc(100, 0)
        assert result is None
    
    def test_calculate_conservative_epc_none_input(self):
        """测试输入为None的情况"""
        result = calculate_conservative_epc(None, 50)
        assert result is None
        
        result = calculate_conservative_epc(100, None)
        assert result is None
    
    def test_calculate_conservative_roi_profit(self):
        """测试盈利情况下的ROI计算"""
        # EPC=2, CPC=1, ROI应该=100%
        result = calculate_conservative_roi(2.0, 1.0)
        assert result == 100.0
    
    def test_calculate_conservative_roi_loss(self):
        """测试亏损情况下的ROI计算"""
        # EPC=0.5, CPC=1, ROI应该=-50%
        result = calculate_conservative_roi(0.5, 1.0)
        assert result == -50.0
    
    def test_calculate_conservative_roi_break_even(self):
        """测试盈亏平衡情况"""
        # EPC=1, CPC=1, ROI应该=0%
        result = calculate_conservative_roi(1.0, 1.0)
        assert result == 0.0
    
    def test_calculate_conservative_roi_zero_cpc(self):
        """测试CPC为0的情况"""
        result = calculate_conservative_roi(2.0, 0)
        assert result is None
    
    def test_calculate_conservative_roi_none_input(self):
        """测试输入为None的情况"""
        result = calculate_conservative_roi(None, 1.0)
        assert result is None
        
        result = calculate_conservative_roi(2.0, None)
        assert result is None
    
    def test_validate_calculation_inputs_valid(self):
        """测试有效的输入"""
        is_valid, error = validate_calculation_inputs(100, 50, 1.0)
        assert is_valid is True
        assert error is None
    
    def test_validate_calculation_inputs_invalid_commission(self):
        """测试无效的佣金输入"""
        is_valid, error = validate_calculation_inputs(-10, 50, 1.0)
        assert is_valid is False
        assert "保守佣金" in error
    
    def test_validate_calculation_inputs_invalid_clicks(self):
        """测试无效的点击输入"""
        is_valid, error = validate_calculation_inputs(100, -5, 1.0)
        assert is_valid is False
        assert "点击次数" in error
    
    def test_validate_calculation_inputs_invalid_cpc(self):
        """测试无效的CPC输入"""
        is_valid, error = validate_calculation_inputs(100, 50, -1.0)
        assert is_valid is False
        assert "CPC" in error


# 示例使用场景
if __name__ == "__main__":
    print("=" * 50)
    print("数据分析计算公式测试示例")
    print("=" * 50)
    
    # 示例1：正常情况
    print("\n示例1：正常盈利情况")
    print("-" * 50)
    commission = 1000  # 保守佣金：1000元
    clicks = 500       # 点击：500次
    cpc = 1.5          # CPC：1.5元
    
    epc = calculate_conservative_epc(commission, clicks)
    roi = calculate_conservative_roi(epc, cpc)
    
    print(f"保守佣金: {commission}元")
    print(f"点击次数: {clicks}次")
    print(f"CPC: {cpc}元")
    print(f"保守EPC: {epc}元")
    print(f"保守ROI: {roi}%")
    
    # 示例2：亏损情况
    print("\n示例2：亏损情况")
    print("-" * 50)
    commission = 500   # 保守佣金：500元
    clicks = 1000      # 点击：1000次
    cpc = 1.0          # CPC：1.0元
    
    epc = calculate_conservative_epc(commission, clicks)
    roi = calculate_conservative_roi(epc, cpc)
    
    print(f"保守佣金: {commission}元")
    print(f"点击次数: {clicks}次")
    print(f"CPC: {cpc}元")
    print(f"保守EPC: {epc}元")
    print(f"保守ROI: {roi}%")
    
    # 示例3：边界情况
    print("\n示例3：边界情况（点击数为0）")
    print("-" * 50)
    commission = 1000
    clicks = 0
    cpc = 1.5
    
    epc = calculate_conservative_epc(commission, clicks)
    roi = calculate_conservative_roi(epc, cpc) if epc else None
    
    print(f"保守佣金: {commission}元")
    print(f"点击次数: {clicks}次")
    print(f"CPC: {cpc}元")
    print(f"保守EPC: {epc}")
    print(f"保守ROI: {roi}")

















