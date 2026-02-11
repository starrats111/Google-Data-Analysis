#!/usr/bin/env python3
"""
wj08 账号全功能测试脚本
测试所有核心功能是否正常工作
"""
import requests
from datetime import date, datetime, timedelta
from typing import Dict, Any, Tuple
import json

# 配置
BASE_URL = "http://localhost:8000"
USERNAME = "wj08"
PASSWORD = "wj123456"
MANAGER_USERNAME = "wenjun123"
MANAGER_PASSWORD = "wj123456"

def get_token(username: str, password: str) -> str:
    """获取登录token"""
    try:
        response = requests.post(
            f"{BASE_URL}/api/auth/login",
            data={"username": username, "password": password}
        )
        if response.status_code == 200:
            return response.json().get("access_token")
        return None
    except Exception as e:
        print(f"登录失败: {e}")
        return None

def api_get(endpoint: str, token: str, params: dict = None) -> Tuple[int, Any]:
    """GET请求"""
    try:
        headers = {"Authorization": f"Bearer {token}"}
        response = requests.get(f"{BASE_URL}{endpoint}", headers=headers, params=params, timeout=30)
        try:
            return response.status_code, response.json()
        except:
            return response.status_code, response.text
    except Exception as e:
        return 0, str(e)

def api_post(endpoint: str, token: str, data: dict = None, params: dict = None) -> Tuple[int, Any]:
    """POST请求"""
    try:
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        response = requests.post(f"{BASE_URL}{endpoint}", headers=headers, json=data, params=params, timeout=60)
        try:
            return response.status_code, response.json()
        except:
            return response.status_code, response.text
    except Exception as e:
        return 0, str(e)

def print_section(title: str):
    """打印分隔标题"""
    print(f"\n{'='*60}")
    print(f"📌 {title}")
    print('='*60)

def main():
    today = date.today()
    start_of_month = date(today.year, today.month, 1)
    yesterday = today - timedelta(days=1)
    
    print("="*60)
    print(f"🔍 wj08 账号全功能测试")
    print(f"⏰ 测试时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"🌐 目标服务器: {BASE_URL}")
    print("="*60)
    
    # ==================== 1. 登录测试 ====================
    print_section("1. 用户认证")
    
    token = get_token(USERNAME, PASSWORD)
    if token:
        print(f"✅ wj08 登录成功")
    else:
        print(f"❌ wj08 登录失败，无法继续测试")
        return
    
    headers = {"Authorization": f"Bearer {token}"}
    
    # 获取用户信息
    code, data = api_get("/api/auth/me", token)
    if code == 200:
        print(f"✅ 用户信息: {data.get('username')} (角色: {data.get('role')})")
    else:
        print(f"❌ 获取用户信息失败: {code}")
    
    # ==================== 2. MCC账号测试 ====================
    print_section("2. MCC账号管理")
    
    code, data = api_get("/api/mcc/accounts", token)
    if code == 200 and isinstance(data, list):
        print(f"✅ MCC账号数量: {len(data)}个")
        for mcc in data:
            print(f"   - {mcc.get('mcc_name')} (ID: {mcc.get('mcc_id')}, 货币: {mcc.get('currency', 'USD')})")
    else:
        print(f"❌ 获取MCC账号失败: {code}")
    
    # ==================== 3. 平台账号测试 ====================
    print_section("3. 平台账号管理")
    
    code, data = api_get("/api/affiliate/accounts", token)
    if code == 200 and isinstance(data, list):
        print(f"✅ 平台账号数量: {len(data)}个")
        for acc in data:
            platform = acc.get('platform', {})
            pname = platform.get('platform_name', acc.get('platform_code', '未知')) if isinstance(platform, dict) else acc.get('platform_code', '未知')
            print(f"   - {pname}: {acc.get('account_name')} (渠道ID: {acc.get('account_code', '-')})")
    else:
        print(f"❌ 获取平台账号失败: {code}")
    
    # ==================== 4. Google Ads数据测试 ====================
    print_section("4. Google Ads数据 (数据中心)")
    
    code, data = api_get("/api/google-ads-aggregate/by-campaign", token, {
        "date_range_type": "custom",
        "begin_date": start_of_month.isoformat(),
        "end_date": today.isoformat(),
        "status": "ALL"
    })
    if code == 200:
        campaigns = data.get("campaigns", [])
        total_cost = sum(c.get("cost", 0) for c in campaigns)
        total_clicks = sum(c.get("clicks", 0) for c in campaigns)
        total_impressions = sum(c.get("impressions", 0) for c in campaigns)
        enabled = len([c for c in campaigns if c.get("status") == "已启用"])
        paused = len([c for c in campaigns if c.get("status") == "已暂停"])
        
        print(f"✅ 广告系列: 共{len(campaigns)}个 (已启用:{enabled}, 已暂停:{paused})")
        print(f"   本月总费用: ${total_cost:.2f}")
        print(f"   本月总点击: {total_clicks}")
        print(f"   本月总展示: {total_impressions}")
        
        # 显示前5个广告系列
        if campaigns:
            print(f"\n   前5个广告系列:")
            for c in campaigns[:5]:
                print(f"   - {c.get('campaign_name', '未知')[:30]}: ${c.get('cost', 0):.2f}")
    else:
        print(f"❌ 获取Google Ads数据失败: {code}")
    
    # ==================== 5. 平台数据测试 ====================
    print_section("5. 平台数据 (数据中心)")
    
    code, data = api_get("/api/platform-data/summary", token, {
        "begin_date": start_of_month.isoformat(),
        "end_date": today.isoformat()
    })
    if code == 200:
        total_comm = data.get("total_commission", 0)
        total_orders = data.get("total_orders", 0)
        rejected = data.get("rejected_commission", 0)
        
        print(f"✅ 平台数据汇总:")
        print(f"   总佣金: ${total_comm:.2f}")
        print(f"   总订单: {total_orders}单")
        print(f"   拒付佣金: ${rejected:.2f}")
        
        # 按平台分类
        platform_breakdown = data.get("platform_breakdown", [])
        if platform_breakdown:
            print(f"\n   按平台分类:")
            for pb in platform_breakdown:
                print(f"   - {pb.get('platform', '未知')}: ${pb.get('commission', 0):.2f} ({pb.get('orders', 0)}单)")
    else:
        print(f"❌ 获取平台数据失败: {code}")
    
    # ==================== 6. L7D分析测试 ====================
    print_section("6. L7D分析")
    
    # 获取已有的L7D分析
    code, data = api_get("/api/analysis", token, {"analysis_type": "l7d"})
    if code == 200 and isinstance(data, list):
        print(f"✅ 已有L7D分析记录: {len(data)}条")
        if data:
            latest = data[0]
            print(f"   最新分析日期: {latest.get('analysis_date')}")
            has_report = bool(latest.get('ai_report'))
            print(f"   AI报告: {'有' if has_report else '无'}")
    else:
        print(f"❌ 获取L7D分析列表失败: {code}")
    
    # 尝试生成新的L7D分析 (POST)
    code, data = api_post("/api/analysis/l7d", token, params={"end_date": yesterday.isoformat()})
    if code == 200:
        result = data.get("data", {})
        rows = result.get("rows", [])
        print(f"✅ 生成L7D分析成功: {len(rows)}个广告系列")
    elif code == 500:
        print(f"⚠️ L7D分析生成: 可能没有足够数据 - {str(data)[:100]}")
    else:
        print(f"❌ 生成L7D分析失败: {code} - {str(data)[:100]}")
    
    # ==================== 7. 出价管理测试 ====================
    print_section("7. 出价管理")
    
    # 获取出价策略
    code, data = api_get("/api/bids/strategies", token)
    if code == 200 and isinstance(data, list):
        print(f"✅ 出价策略: {len(data)}条")
        if data:
            for s in data[:3]:
                print(f"   - {s.get('campaign_name', '未知')[:30]}: {s.get('bidding_strategy_type', '未知')}")
        else:
            print(f"   (需要先同步出价数据)")
    else:
        print(f"❌ 获取出价策略失败: {code}")
    
    # 获取关键词出价
    code, data = api_get("/api/bids/keywords", token)
    if code == 200 and isinstance(data, list):
        print(f"✅ 关键词出价: {len(data)}条")
    else:
        print(f"❌ 获取关键词出价失败: {code}")
    
    # ==================== 8. 仪表盘测试 ====================
    print_section("8. 员工仪表盘")
    
    code, data = api_get("/api/dashboard/employee-insights", token, {"range": "month"})
    if code == 200:
        print(f"✅ 员工洞察数据获取成功")
        if isinstance(data, dict):
            print(f"   本月费用: ${data.get('total_cost', 0):.2f}")
            print(f"   本月佣金: ${data.get('total_commission', 0):.2f}")
    else:
        print(f"❌ 获取员工洞察失败: {code}")
    
    # ==================== 9. 报表测试 ====================
    print_section("9. 报表功能")
    
    # 月度报表
    code, data = api_get("/api/reports/monthly", token, {
        "year": today.year,
        "month": today.month
    })
    if code == 200:
        report_data = data.get("data", [])
        wj08_data = next((d for d in report_data if d.get("username") == "wj08"), None)
        if wj08_data:
            print(f"✅ 月度报表 - wj08数据:")
            print(f"   广告费: ${wj08_data.get('ad_cost', 0):.2f}")
            print(f"   账面佣金: ${wj08_data.get('book_commission', 0):.2f}")
            print(f"   失效佣金: ${wj08_data.get('rejected_commission', 0):.2f}")
            print(f"   订单数: {wj08_data.get('orders', 0)}")
        else:
            print(f"⚠️ 月度报表中未找到wj08数据")
    else:
        print(f"❌ 获取月度报表失败: {code}")
    
    # ==================== 10. 导出测试 ====================
    print_section("10. 导出功能")
    
    # 测试月度报表Excel导出
    try:
        response = requests.get(
            f"{BASE_URL}/api/reports/monthly/export",
            headers=headers,
            params={"year": today.year, "month": today.month},
            timeout=30
        )
        is_excel = "spreadsheet" in response.headers.get("content-type", "")
        if response.status_code == 200 and is_excel:
            print(f"✅ 月度报表Excel导出: {len(response.content)} bytes")
        else:
            print(f"❌ 月度报表Excel导出失败: {response.status_code}")
    except Exception as e:
        print(f"❌ 月度报表Excel导出异常: {e}")
    
    # ==================== 11. AI功能测试 ====================
    print_section("11. AI功能")
    
    # 获取分析提示词
    code, data = api_get("/api/gemini/prompt", token, {"type": "analysis"})
    if code == 200:
        prompt = data.get("prompt", "")
        print(f"✅ 分析提示词: {len(prompt)}字符")
    else:
        print(f"❌ 获取分析提示词失败: {code}")
    
    # 获取报告提示词
    code, data = api_get("/api/gemini/prompt", token, {"type": "report"})
    if code == 200:
        prompt = data.get("prompt", "")
        print(f"✅ 报告提示词: {len(prompt)}字符")
    else:
        print(f"❌ 获取报告提示词失败: {code}")
    
    # ==================== 12. 经理功能测试 ====================
    print_section("12. 经理功能 (使用经理账号)")
    
    manager_token = get_token(MANAGER_USERNAME, MANAGER_PASSWORD)
    if manager_token:
        print(f"✅ 经理登录成功")
        
        # 系统日志
        code, data = api_get("/api/system/logs", manager_token, {
            "start_time": (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "lines": 20
        })
        if code == 200:
            print(f"✅ 系统日志: {data.get('total_lines', 0)}行")
        else:
            print(f"❌ 系统日志失败: {code}")
        
        # 经理总览
        code, data = api_get("/api/dashboard/overview", manager_token)
        if code == 200:
            print(f"✅ 经理总览: {data.get('total_employees', 0)}个员工")
        else:
            print(f"❌ 经理总览失败: {code}")
        
        # 查看wj08员工数据
        code, data = api_get("/api/dashboard/employees", manager_token)
        if code == 200 and isinstance(data, list):
            wj08_emp = next((e for e in data if e.get("username") == "wj08"), None)
            if wj08_emp:
                print(f"✅ wj08员工数据:")
                print(f"   本月费用: ${wj08_emp.get('month_cost', 0):.2f}")
                print(f"   本月佣金: ${wj08_emp.get('month_commission', 0):.2f}")
                print(f"   MCC数量: {wj08_emp.get('mcc_count', 0)}")
            else:
                print(f"⚠️ 员工列表中未找到wj08")
        else:
            print(f"❌ 获取员工列表失败: {code}")
    else:
        print(f"❌ 经理登录失败")
    
    # ==================== 测试总结 ====================
    print("\n" + "="*60)
    print("📊 测试完成")
    print("="*60)
    print(f"\n如有 ❌ 标记的项目，请检查相关功能。")
    print(f"如有 ⚠️ 标记的项目，可能是数据不足或需要先同步。")

if __name__ == "__main__":
    main()

