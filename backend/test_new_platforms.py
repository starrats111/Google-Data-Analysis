"""
测试新平台的API服务
测试 CF, LB, PB, PM 四个平台
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services.creatorflare_service import CreatorFlareService
from app.services.linkbux_service import LinkBuxService
from app.services.partnerboost_service import PartnerBoostService
from app.services.partnermatic_service import PartnerMaticService
from datetime import datetime, timedelta

def test_platform(platform_name: str, service, token: str, begin_date: str, end_date: str):
    """测试单个平台"""
    print(f"\n{'='*60}")
    print(f"测试 {platform_name} 平台")
    print(f"{'='*60}")
    
    try:
        result = service.sync_transactions(begin_date, end_date)
        
        if not result.get("success"):
            print(f"❌ API调用失败: {result.get('message')}")
            return False
        
        data = result.get("data", {})
        transactions = data.get("transactions", [])
        total = data.get("total", 0)
        
        print(f"✓ API调用成功")
        print(f"  总交易数: {total}")
        print(f"  返回交易数: {len(transactions)}")
        
        if transactions:
            # 提取并显示前3条交易
            extracted = service.extract_transaction_data({
                "data": {
                    "list": transactions[:3]
                }
            })
            
            print(f"\n前3条交易示例:")
            for i, tx in enumerate(extracted, 1):
                print(f"  {i}. 订单ID: {tx.get('transaction_id')}")
                print(f"     时间: {tx.get('transaction_time')}")
                print(f"     佣金: ${tx.get('commission_amount', 0):.2f}")
                print(f"     订单金额: ${tx.get('order_amount', 0):.2f}")
                print(f"     状态: {tx.get('status')}")
                print(f"     商户: {tx.get('merchant')}")
        
        return True
        
    except Exception as e:
        print(f"❌ 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """主函数"""
    print("="*60)
    print("新平台API测试脚本")
    print("="*60)
    
    # 测试日期范围（最近7天）
    end_date = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    begin_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    
    print(f"\n测试日期范围: {begin_date} ~ {end_date}")
    
    # 获取Token（从命令行参数或输入）
    if len(sys.argv) > 1:
        tokens_str = sys.argv[1]
        tokens = tokens_str.split(',')
    else:
        print("\n请输入各平台的Token（用逗号分隔，顺序：CF,LB,PB,PM）:")
        print("例如: cf_token,lb_token,pb_token,pm_token")
        tokens_str = input().strip()
        tokens = tokens_str.split(',')
    
    if len(tokens) < 4:
        print("❌ 需要4个Token（CF, LB, PB, PM）")
        return
    
    cf_token, lb_token, pb_token, pm_token = tokens[0].strip(), tokens[1].strip(), tokens[2].strip(), tokens[3].strip()
    
    results = {}
    
    # 测试 CreatorFlare
    if cf_token:
        cf_service = CreatorFlareService(token=cf_token)
        results['CF'] = test_platform("CreatorFlare (CF)", cf_service, cf_token, begin_date, end_date)
    else:
        print("\n⚠️ 跳过 CreatorFlare 测试（未提供Token）")
    
    # 测试 LinkBux
    if lb_token:
        lb_service = LinkBuxService(token=lb_token)
        results['LB'] = test_platform("LinkBux (LB)", lb_service, lb_token, begin_date, end_date)
    else:
        print("\n⚠️ 跳过 LinkBux 测试（未提供Token）")
    
    # 测试 PartnerBoost
    if pb_token:
        pb_service = PartnerBoostService(token=pb_token)
        results['PB'] = test_platform("PartnerBoost (PB)", pb_service, pb_token, begin_date, end_date)
    else:
        print("\n⚠️ 跳过 PartnerBoost 测试（未提供Token）")
    
    # 测试 PartnerMatic
    if pm_token:
        pm_service = PartnerMaticService(token=pm_token)
        results['PM'] = test_platform("PartnerMatic (PM)", pm_service, pm_token, begin_date, end_date)
    else:
        print("\n⚠️ 跳过 PartnerMatic 测试（未提供Token）")
    
    # 总结
    print(f"\n{'='*60}")
    print("测试总结")
    print(f"{'='*60}")
    for platform, success in results.items():
        status = "✓ 成功" if success else "❌ 失败"
        print(f"  {platform}: {status}")
    
    print("\n如果所有测试都成功，可以在platform_data_sync.py中添加同步逻辑")

if __name__ == "__main__":
    main()

