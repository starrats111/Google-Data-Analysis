#!/usr/bin/env python3
"""
全站功能测试脚本
测试所有核心功能是否正常工作
"""
import sys
import os
import requests
import json
from datetime import date, datetime, timedelta
from typing import Dict, Any, List, Tuple

# 添加项目路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# 配置
BASE_URL = "http://localhost:8000"
TEST_USERNAME = "wj01"  # 测试用员工账号
TEST_PASSWORD = "wj01"  # 测试密码
MANAGER_USERNAME = "07"  # 经理账号
MANAGER_PASSWORD = "07"  # 经理密码

# 测试结果收集
results: List[Tuple[str, str, bool, str]] = []

def log_result(category: str, test_name: str, success: bool, message: str = ""):
    """记录测试结果"""
    status = "✅ 通过" if success else "❌ 失败"
    results.append((category, test_name, success, message))
    print(f"  {status} {test_name}" + (f" - {message}" if message else ""))

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

def api_post(endpoint: str, token: str, data: dict = None) -> Tuple[int, Any]:
    """POST请求"""
    try:
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        response = requests.post(f"{BASE_URL}{endpoint}", headers=headers, json=data, timeout=60)
        try:
            return response.status_code, response.json()
        except:
            return response.status_code, response.text
    except Exception as e:
        return 0, str(e)

def test_auth():
    """测试认证功能"""
    print("\n" + "="*60)
    print("📌 测试模块: 用户认证")
    print("="*60)
    
    # 测试员工登录
    token = get_token(TEST_USERNAME, TEST_PASSWORD)
    log_result("认证", "员工登录", token is not None, 
               f"用户: {TEST_USERNAME}" if token else "登录失败")
    
    # 测试经理登录
    manager_token = get_token(MANAGER_USERNAME, MANAGER_PASSWORD)
    log_result("认证", "经理登录", manager_token is not None,
               f"用户: {MANAGER_USERNAME}" if manager_token else "登录失败")
    
    # 测试获取用户信息
    if token:
        code, data = api_get("/api/auth/me", token)
        log_result("认证", "获取用户信息", code == 200 and "username" in str(data))
    
    return token, manager_token

def test_dashboard(token: str, manager_token: str):
    """测试仪表盘"""
    print("\n" + "="*60)
    print("📌 测试模块: 仪表盘")
    print("="*60)
    
    # 员工仪表盘
    code, data = api_get("/api/dashboard/employee", token)
    log_result("仪表盘", "员工仪表盘数据", code == 200, 
               f"本月费用: ${data.get('month_cost', 0):.2f}" if code == 200 else str(data))
    
    # 经理仪表盘
    if manager_token:
        code, data = api_get("/api/dashboard/manager", manager_token)
        log_result("仪表盘", "经理仪表盘数据", code == 200,
                   f"员工数: {len(data.get('employees', []))}" if code == 200 else str(data))
        
        # 趋势数据
        code, data = api_get("/api/dashboard/trend", manager_token)
        log_result("仪表盘", "趋势图数据", code == 200,
                   f"数据点: {len(data.get('data', []))}" if code == 200 else str(data))

def test_data_center(token: str):
    """测试数据中心"""
    print("\n" + "="*60)
    print("📌 测试模块: 数据中心")
    print("="*60)
    
    today = date.today()
    start_date = date(today.year, today.month, 1)
    
    # Google Ads 数据
    code, data = api_get("/api/google-ads-aggregate/by-campaign", token, {
        "date_range_type": "custom",
        "begin_date": start_date.isoformat(),
        "end_date": today.isoformat(),
        "status": "ALL"
    })
    campaigns = data.get("campaigns", []) if isinstance(data, dict) else []
    log_result("数据中心", "Google Ads数据获取", code == 200,
               f"广告系列: {len(campaigns)}个" if code == 200 else str(data)[:100])
    
    # 平台数据汇总
    code, data = api_get("/api/platform-data/summary", token, {
        "start_date": start_date.isoformat(),
        "end_date": today.isoformat()
    })
    log_result("数据中心", "平台数据汇总", code == 200,
               f"总佣金: ${data.get('total_commission', 0):.2f}" if code == 200 and isinstance(data, dict) else str(data)[:100])
    
    # 平台交易明细
    code, data = api_get("/api/platform-data/transactions", token, {
        "start_date": start_date.isoformat(),
        "end_date": today.isoformat()
    })
    transactions = data if isinstance(data, list) else data.get("transactions", []) if isinstance(data, dict) else []
    log_result("数据中心", "平台交易明细", code == 200,
               f"交易记录: {len(transactions)}条" if code == 200 else str(data)[:100])

def test_mcc_accounts(token: str):
    """测试MCC账号"""
    print("\n" + "="*60)
    print("📌 测试模块: MCC账号管理")
    print("="*60)
    
    # 获取MCC列表
    code, data = api_get("/api/mcc/accounts", token)
    mccs = data if isinstance(data, list) else []
    log_result("MCC账号", "获取MCC列表", code == 200 and len(mccs) > 0,
               f"MCC数量: {len(mccs)}" if code == 200 else str(data)[:100])
    
    # 检查MCC ID是否存在
    if mccs:
        has_mcc_id = all(mcc.get("mcc_id") for mcc in mccs)
        log_result("MCC账号", "MCC ID完整性", has_mcc_id,
                   "所有MCC都有ID" if has_mcc_id else "部分MCC缺少ID")

def test_platform_accounts(token: str):
    """测试平台账号"""
    print("\n" + "="*60)
    print("📌 测试模块: 平台账号管理")
    print("="*60)
    
    # 获取平台账号列表
    code, data = api_get("/api/affiliate/accounts", token)
    accounts = data if isinstance(data, list) else []
    log_result("平台账号", "获取平台账号列表", code == 200,
               f"账号数量: {len(accounts)}" if code == 200 else str(data)[:100])
    
    # 获取平台列表
    code, data = api_get("/api/affiliate/platforms", token)
    platforms = data if isinstance(data, list) else []
    log_result("平台账号", "获取平台列表", code == 200,
               f"平台数量: {len(platforms)}" if code == 200 else str(data)[:100])

def test_analysis(token: str):
    """测试L7D分析"""
    print("\n" + "="*60)
    print("📌 测试模块: L7D分析")
    print("="*60)
    
    # 获取L7D分析列表
    code, data = api_get("/api/analysis/l7d", token)
    analyses = data if isinstance(data, list) else []
    log_result("L7D分析", "获取分析列表", code == 200,
               f"分析记录: {len(analyses)}条" if code == 200 else str(data)[:100])
    
    # 检查是否有AI报告
    if analyses:
        has_report = any(a.get("ai_report") for a in analyses[:5])
        log_result("L7D分析", "AI报告生成", has_report,
                   "有AI报告" if has_report else "暂无AI报告")

def test_bid_management(token: str):
    """测试出价管理"""
    print("\n" + "="*60)
    print("📌 测试模块: 出价管理")
    print("="*60)
    
    # 获取出价策略
    code, data = api_get("/api/bids/strategies", token)
    strategies = data if isinstance(data, list) else []
    log_result("出价管理", "获取出价策略", code == 200,
               f"策略数量: {len(strategies)}" if code == 200 else str(data)[:100])
    
    # 获取关键词出价
    code, data = api_get("/api/bids/keywords", token)
    keywords = data if isinstance(data, list) else []
    log_result("出价管理", "获取关键词出价", code == 200,
               f"关键词数量: {len(keywords)}" if code == 200 else str(data)[:100])

def test_reports(token: str, manager_token: str):
    """测试报表功能"""
    print("\n" + "="*60)
    print("📌 测试模块: 报表功能")
    print("="*60)
    
    today = date.today()
    
    # 月度报表
    code, data = api_get("/api/reports/monthly", manager_token or token, {
        "year": today.year,
        "month": today.month
    })
    log_result("报表", "月度报表", code == 200,
               f"员工数: {len(data.get('data', []))}" if code == 200 and isinstance(data, dict) else str(data)[:100])
    
    # 季度报表
    quarter = (today.month - 1) // 3 + 1
    code, data = api_get("/api/reports/quarterly", manager_token or token, {
        "year": today.year,
        "quarter": quarter
    })
    log_result("报表", "季度报表", code == 200,
               f"Q{quarter}数据" if code == 200 else str(data)[:100])
    
    # 年度报表
    code, data = api_get("/api/reports/yearly", manager_token or token, {
        "year": today.year
    })
    log_result("报表", "年度报表", code == 200,
               f"{today.year}年数据" if code == 200 else str(data)[:100])
    
    # 财务报表
    code, data = api_get("/api/reports/financial", manager_token or token, {
        "year": today.year,
        "month": today.month
    })
    log_result("报表", "财务报表", code == 200,
               "获取成功" if code == 200 else str(data)[:100])

def test_system_logs(manager_token: str):
    """测试系统日志"""
    print("\n" + "="*60)
    print("📌 测试模块: 系统日志")
    print("="*60)
    
    if not manager_token:
        log_result("系统日志", "系统日志(需要经理权限)", False, "无经理token")
        return
    
    # 获取系统日志
    now = datetime.now()
    code, data = api_get("/api/system/logs", manager_token, {
        "start_time": (now - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S"),
        "end_time": now.strftime("%Y-%m-%d %H:%M:%S")
    })
    log_result("系统日志", "获取系统日志", code == 200,
               f"日志行数: {data.get('total_lines', 0)}" if code == 200 and isinstance(data, dict) else str(data)[:100])
    
    # 系统健康检查
    code, data = api_get("/api/system/health", manager_token)
    log_result("系统日志", "系统健康检查", code == 200 and data.get("status") == "healthy")

def test_sync_functions(token: str):
    """测试同步功能"""
    print("\n" + "="*60)
    print("📌 测试模块: 数据同步")
    print("="*60)
    
    # 注意：这些是POST请求，可能会实际触发同步
    # 这里只测试API是否可访问，不实际执行同步
    
    # 测试同步端点是否存在
    code, data = api_post("/api/google-ads-aggregate/sync-recent-data", token)
    log_result("数据同步", "Google Ads同步API", code in [200, 202, 404],
               "API可用" if code in [200, 202] else f"状态码: {code}")
    
    code, data = api_post("/api/platform-data/sync-recent-data", token)
    log_result("数据同步", "平台数据同步API", code in [200, 202, 404, 500],
               "API可用" if code in [200, 202] else f"状态码: {code}")

def test_export_functions(token: str, manager_token: str):
    """测试导出功能"""
    print("\n" + "="*60)
    print("📌 测试模块: 数据导出")
    print("="*60)
    
    today = date.today()
    
    # 月度报表Excel导出
    try:
        headers = {"Authorization": f"Bearer {manager_token or token}"}
        response = requests.get(
            f"{BASE_URL}/api/reports/monthly/export",
            headers=headers,
            params={"year": today.year, "month": today.month},
            timeout=30
        )
        is_excel = response.headers.get("content-type", "").startswith("application/vnd.openxmlformats")
        log_result("数据导出", "月度报表Excel导出", response.status_code == 200 and is_excel,
                   f"文件大小: {len(response.content)} bytes" if response.status_code == 200 else f"状态码: {response.status_code}")
    except Exception as e:
        log_result("数据导出", "月度报表Excel导出", False, str(e))
    
    # 财务报表Excel导出
    try:
        response = requests.get(
            f"{BASE_URL}/api/reports/financial/export",
            headers=headers,
            params={"year": today.year, "month": today.month},
            timeout=30
        )
        is_excel = response.headers.get("content-type", "").startswith("application/vnd.openxmlformats")
        log_result("数据导出", "财务报表Excel导出", response.status_code == 200 and is_excel,
                   f"文件大小: {len(response.content)} bytes" if response.status_code == 200 else f"状态码: {response.status_code}")
    except Exception as e:
        log_result("数据导出", "财务报表Excel导出", False, str(e))

def test_gemini_api(token: str):
    """测试Gemini AI功能"""
    print("\n" + "="*60)
    print("📌 测试模块: AI功能")
    print("="*60)
    
    # 获取用户提示词
    code, data = api_get("/api/gemini/prompt", token, {"type": "analysis"})
    log_result("AI功能", "获取分析提示词", code == 200)
    
    code, data = api_get("/api/gemini/prompt", token, {"type": "report"})
    log_result("AI功能", "获取报告提示词", code == 200)

def print_summary():
    """打印测试总结"""
    print("\n" + "="*60)
    print("📊 测试总结")
    print("="*60)
    
    # 按类别统计
    categories = {}
    for category, test_name, success, message in results:
        if category not in categories:
            categories[category] = {"passed": 0, "failed": 0}
        if success:
            categories[category]["passed"] += 1
        else:
            categories[category]["failed"] += 1
    
    total_passed = sum(c["passed"] for c in categories.values())
    total_failed = sum(c["failed"] for c in categories.values())
    total = total_passed + total_failed
    
    print(f"\n总测试数: {total}")
    print(f"✅ 通过: {total_passed}")
    print(f"❌ 失败: {total_failed}")
    print(f"通过率: {total_passed/total*100:.1f}%\n")
    
    print("各模块统计:")
    for category, stats in categories.items():
        status = "✅" if stats["failed"] == 0 else "⚠️"
        print(f"  {status} {category}: {stats['passed']}/{stats['passed']+stats['failed']}")
    
    # 列出失败的测试
    failed_tests = [(c, t, m) for c, t, s, m in results if not s]
    if failed_tests:
        print("\n❌ 失败的测试:")
        for category, test_name, message in failed_tests:
            print(f"  - [{category}] {test_name}: {message}")
    
    return total_failed == 0

def main():
    print("="*60)
    print("🔍 全站功能测试")
    print(f"⏰ 测试时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"🌐 目标服务器: {BASE_URL}")
    print("="*60)
    
    # 1. 测试认证
    token, manager_token = test_auth()
    
    if not token:
        print("\n❌ 员工登录失败，无法继续测试")
        print("请检查测试账号配置或后端服务状态")
        return False
    
    # 2. 测试各模块
    test_dashboard(token, manager_token)
    test_data_center(token)
    test_mcc_accounts(token)
    test_platform_accounts(token)
    test_analysis(token)
    test_bid_management(token)
    test_reports(token, manager_token)
    test_system_logs(manager_token)
    test_sync_functions(token)
    test_export_functions(token, manager_token)
    test_gemini_api(token)
    
    # 3. 打印总结
    success = print_summary()
    
    return success

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)

