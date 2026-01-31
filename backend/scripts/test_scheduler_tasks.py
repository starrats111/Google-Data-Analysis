"""
测试定时任务脚本
用于手动触发和测试定时任务功能
"""
import sys
import os
from pathlib import Path

# 添加项目根目录到Python路径
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

from datetime import date, timedelta
from app.database import SessionLocal
from app.services.scheduler import (
    sync_platform_data_job,
    sync_google_ads_data_job,
    daily_analysis_job,
    weekly_l7d_analysis_job
)
import logging

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)


def test_platform_data_sync():
    """测试平台数据同步任务"""
    print("\n" + "=" * 60)
    print("测试1: 平台数据同步任务（4点和16点执行）")
    print("=" * 60)
    print("功能: 逐天同步平台过去1周数据（MID、商家、订单数、佣金、拒付佣金）")
    print("说明: 逐天同步，确保数据完整")
    print("-" * 60)
    
    try:
        sync_platform_data_job()
        print("✓ 平台数据同步任务测试完成")
    except Exception as e:
        print(f"✗ 平台数据同步任务测试失败: {e}")
        import traceback
        traceback.print_exc()


def test_google_ads_sync():
    """测试Google Ads数据同步任务"""
    print("\n" + "=" * 60)
    print("测试2: Google Ads数据同步任务（每天早上8点执行）")
    print("=" * 60)
    print("功能: 自动提取前7天Google ads数据")
    print("-" * 60)
    
    try:
        sync_google_ads_data_job()
        print("✓ Google Ads数据同步任务测试完成")
    except Exception as e:
        print(f"✗ Google Ads数据同步任务测试失败: {e}")
        import traceback
        traceback.print_exc()


def test_daily_analysis():
    """测试每日分析任务"""
    print("\n" + "=" * 60)
    print("测试3: 每日分析任务（每天早上8点05分执行）")
    print("=" * 60)
    print("功能: 取前一天的平台数据和对应商家的Google ads数据进行每日分析")
    print("-" * 60)
    
    try:
        daily_analysis_job()
        print("✓ 每日分析任务测试完成")
    except Exception as e:
        print(f"✗ 每日分析任务测试失败: {e}")
        import traceback
        traceback.print_exc()


def test_l7d_analysis():
    """测试L7D分析任务"""
    print("\n" + "=" * 60)
    print("测试4: 每周L7D分析任务（每周一/三/五早上8点10分执行）")
    print("=" * 60)
    print("功能: 自动生成L7D数据")
    print("-" * 60)
    
    try:
        weekly_l7d_analysis_job()
        print("✓ L7D分析任务测试完成")
    except Exception as e:
        print(f"✗ L7D分析任务测试失败: {e}")
        import traceback
        traceback.print_exc()


def main():
    """主函数"""
    print("\n" + "=" * 60)
    print("定时任务功能测试")
    print("=" * 60)
    print("\n此脚本用于测试以下定时任务:")
    print("1. 平台数据同步（4点和16点）- 提取过去1周数据")
    print("2. Google Ads数据同步（早上8点）- 提取前7天数据")
    print("3. 每日分析（早上8点05分）- 分析前一天数据")
    print("4. 每周L7D分析（周一/三/五早上8点10分）- 生成L7D数据")
    print("\n注意: 这些测试会实际执行数据同步和分析操作")
    print("=" * 60)
    
    # 询问用户要测试哪些任务
    print("\n请选择要测试的任务（输入数字，多个用逗号分隔，或输入'all'测试全部）:")
    print("1. 平台数据同步")
    print("2. Google Ads数据同步")
    print("3. 每日分析")
    print("4. L7D分析")
    print("all. 全部测试")
    
    choice = input("\n请输入选择: ").strip().lower()
    
    if choice == 'all':
        test_platform_data_sync()
        test_google_ads_sync()
        test_daily_analysis()
        test_l7d_analysis()
    elif '1' in choice:
        test_platform_data_sync()
    elif '2' in choice:
        test_google_ads_sync()
    elif '3' in choice:
        test_daily_analysis()
    elif '4' in choice:
        test_l7d_analysis()
    else:
        print("无效的选择")
        return
    
    print("\n" + "=" * 60)
    print("测试完成")
    print("=" * 60)


if __name__ == "__main__":
    main()

