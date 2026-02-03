"""
直接测试LinkHaitao API，查看实际返回的原始数据格式
特别是状态字段的值
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.services.linkhaitao_service import LinkHaitaoService
from datetime import datetime, timedelta
import json

# 需要替换为实际的token
TOKEN = input("请输入LinkHaitao Token: ").strip()

if not TOKEN:
    print("❌ 未提供Token")
    sys.exit(1)

service = LinkHaitaoService(token=TOKEN)

# 测试日期范围
begin_date = "2026-01-01"
end_date = "2026-01-31"

print("=" * 60)
print(f"测试LinkHaitao API原始数据: {begin_date} ~ {end_date}")
print("=" * 60)

try:
    # 直接调用API获取原始数据
    result = service.sync_commissions_and_orders(begin_date, end_date)
    
    if not result.get("success"):
        print(f"❌ API调用失败: {result.get('message')}")
        sys.exit(1)
    
    print(f"\n✓ API调用成功")
    print(f"  总订单数: {result.get('total_orders', 0)}")
    print(f"  总佣金: ${result.get('total_commission', 0):.2f}")
    
    data = result.get("data", {})
    orders = data.get("orders", [])
    
    print(f"\n订单数据: {len(orders)} 条")
    
    # 统计所有不同的状态值
    status_count = {}
    status_commission = {}
    status_examples = {}
    
    for order in orders:
        status = order.get("status")
        commission = order.get("commission") or order.get("cashback") or 0
        order_id = order.get("order_id")
        
        if status not in status_count:
            status_count[status] = 0
            status_commission[status] = 0
            status_examples[status] = []
        
        status_count[status] += 1
        status_commission[status] += commission
        
        # 保存前3个示例
        if len(status_examples[status]) < 3:
            status_examples[status].append({
                "order_id": order_id,
                "status": status,
                "commission": commission,
                "amount": order.get("amount"),
                "merchant": order.get("merchant"),
            })
    
    print(f"\n所有不同的状态值:")
    print(f"{'状态值':<30} {'订单数':<10} {'总佣金':<15} {'示例订单ID':<20}")
    print("-" * 75)
    for status in sorted(status_count.keys()):
        count = status_count[status]
        comm = status_commission[status]
        examples = ", ".join([ex["order_id"] for ex in status_examples[status][:3]])
        print(f"{str(status or 'NULL'):<30} {count:<10} ${comm:<14.2f} {examples:<20}")
    
    # 显示每个状态的详细示例
    print(f"\n各状态的详细示例（前3条）:")
    for status in sorted(status_count.keys()):
        print(f"\n状态: {status} ({status_count[status]} 条)")
        for i, ex in enumerate(status_examples[status][:3], 1):
            print(f"  {i}. 订单ID: {ex['order_id']}, 佣金: ${ex['commission']:.2f}, 订单金额: ${ex['amount'] or 0:.2f}, 商户: {ex['merchant']}")
    
    # 检查佣金为0的记录
    print(f"\n佣金为0但订单金额不为0的记录:")
    zero_comm_orders = [o for o in orders if (o.get("commission") or o.get("cashback") or 0) == 0 and (o.get("amount") or 0) > 0]
    print(f"找到 {len(zero_comm_orders)} 条")
    
    if zero_comm_orders:
        # 按状态统计
        zero_by_status = {}
        for order in zero_comm_orders:
            status = order.get("status")
            if status not in zero_by_status:
                zero_by_status[status] = []
            zero_by_status[status].append(order)
        
        for status, status_orders in sorted(zero_by_status.items()):
            total_amount = sum(o.get("amount") or 0 for o in status_orders)
            print(f"  {status}: {len(status_orders)} 条, 总金额: ${total_amount:.2f}")
            # 显示前3条示例
            for i, order in enumerate(status_orders[:3], 1):
                print(f"    {i}. 订单ID: {order.get('order_id')}, 订单金额: ${order.get('amount') or 0:.2f}, 商户: {order.get('merchant')}")
                # 显示原始数据中的佣金相关字段
                comm_fields = {k: v for k, v in order.items() if 'comm' in k.lower() or 'cashback' in k.lower() or 'commission' in k.lower()}
                if comm_fields:
                    print(f"       佣金相关字段: {comm_fields}")
    
    # 显示一条完整订单的原始数据（用于调试）
    if orders:
        print(f"\n一条完整订单的原始数据（用于调试）:")
        sample_order = orders[0]
        print(json.dumps(sample_order, ensure_ascii=False, indent=2, default=str))
    
    print("\n" + "=" * 60)
    print("建议:")
    print("1. 检查API返回的状态值是否与预期一致")
    print("2. 如果状态值不同，需要更新状态映射")
    print("3. 检查佣金为0的记录，看看是否真的没有佣金")
    print("=" * 60)
    
except Exception as e:
    print(f"❌ 测试失败: {e}")
    import traceback
    traceback.print_exc()

