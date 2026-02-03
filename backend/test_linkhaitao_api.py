"""
测试LinkHaitao API，查看实际返回的数据格式
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
print(f"测试LinkHaitao API: {begin_date} ~ {end_date}")
print("=" * 60)

try:
    result = service.sync_commissions_and_orders(begin_date, end_date)
    
    if not result.get("success"):
        print(f"❌ API调用失败: {result.get('message')}")
        sys.exit(1)
    
    print(f"\n✓ API调用成功")
    print(f"  总订单数: {result.get('total_orders', 0)}")
    print(f"  总佣金: ${result.get('total_commission', 0):.2f}")
    
    data = result.get("data", {})
    orders = data.get("orders", [])
    commissions = data.get("commissions", [])
    
    print(f"\n订单数据: {len(orders)} 条")
    print(f"佣金数据: {len(commissions)} 条")
    
    # 检查前10条订单的佣金字段
    print(f"\n前10条订单的佣金字段检查:")
    print(f"{'订单ID':<20} {'佣金字段':<15} {'佣金值':<15} {'订单金额':<15} {'状态':<15} {'商户':<30}")
    print("-" * 110)
    
    for i, order in enumerate(orders[:10], 1):
        order_id = order.get("order_id") or "N/A"
        commission = order.get("commission")
        cashback = order.get("cashback")
        amount = order.get("amount")
        status = order.get("status")
        merchant = order.get("merchant")
        
        # 检查佣金字段
        comm_field = "commission" if commission is not None else ("cashback" if cashback is not None else "NONE")
        comm_value = commission if commission is not None else (cashback if cashback is not None else 0)
        
        print(f"{str(order_id):<20} {comm_field:<15} ${comm_value or 0:<14.2f} ${amount or 0:<14.2f} {str(status):<15} {str(merchant or 'N/A'):<30}")
    
    # 检查佣金为0但订单金额不为0的订单
    print(f"\n佣金为0但订单金额不为0的订单（前10条）:")
    zero_comm_orders = [o for o in orders if (o.get("commission") or o.get("cashback") or 0) == 0 and (o.get("amount") or 0) > 0]
    print(f"找到 {len(zero_comm_orders)} 条")
    
    if zero_comm_orders:
        print(f"{'订单ID':<20} {'佣金':<15} {'订单金额':<15} {'状态':<15} {'商户':<30} {'原始数据':<50}")
        print("-" * 140)
        for order in zero_comm_orders[:10]:
            order_id = order.get("order_id") or "N/A"
            commission = order.get("commission") or order.get("cashback") or 0
            amount = order.get("amount") or 0
            status = order.get("status")
            merchant = order.get("merchant")
            raw_data = json.dumps(order, ensure_ascii=False)[:50]
            print(f"{str(order_id):<20} ${commission:<14.2f} ${amount:<14.2f} {str(status):<15} {str(merchant or 'N/A'):<30} {raw_data:<50}")
    
    # 统计不同状态的订单
    print(f"\n按状态统计:")
    status_count = {}
    status_commission = {}
    for order in orders:
        status = order.get("status", "unknown")
        commission = order.get("commission") or order.get("cashback") or 0
        status_count[status] = status_count.get(status, 0) + 1
        status_commission[status] = status_commission.get(status, 0) + commission
    
    for status in sorted(status_count.keys()):
        print(f"  {status}: 订单数={status_count[status]}, 佣金=${status_commission[status]:.2f}")
    
    print("\n" + "=" * 60)
    print("建议:")
    print("1. 检查API返回的订单数据中，佣金字段是否正确")
    print("2. 检查佣金为0的订单是否真的没有佣金，还是字段解析问题")
    print("3. 对比API返回的总佣金和系统统计的佣金")
    print("=" * 60)
    
except Exception as e:
    print(f"❌ 测试失败: {e}")
    import traceback
    traceback.print_exc()

