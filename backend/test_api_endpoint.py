"""
测试 API 端点是否正常工作
"""
import requests
import json

# API 基础URL
BASE_URL = "http://127.0.0.1:8000"

# 测试参数
test_params = {
    "begin_date": "2026-01-01",
    "end_date": "2026-01-31",
    "platform": "LH"  # 前端传递的值
}

print("=" * 60)
print("测试 API 端点: /api/platform-data/detail")
print("=" * 60)
print(f"\n请求参数:")
print(json.dumps(test_params, indent=2, ensure_ascii=False))

# 1. 检查服务健康状态
print("\n1. 检查服务健康状态...")
try:
    health_response = requests.get(f"{BASE_URL}/health", timeout=5)
    if health_response.status_code == 200:
        print(f"   ✓ 服务运行正常: {health_response.json()}")
    else:
        print(f"   ✗ 服务异常: {health_response.status_code}")
        print(f"   响应: {health_response.text}")
        exit(1)
except requests.exceptions.ConnectionError:
    print("   ✗ 无法连接到服务，请确保服务已启动")
    print("   启动命令: cd ~/Google-Data-Analysis/backend && source venv/bin/activate && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &")
    exit(1)
except Exception as e:
    print(f"   ✗ 错误: {e}")
    exit(1)

# 2. 测试 API 端点（需要认证）
print("\n2. 测试 API 端点（需要登录token）...")
print("   注意: 此测试需要有效的认证token")
print("   如果测试失败，请在前端浏览器中查看实际的 API 请求")

# 尝试获取登录token（需要用户名和密码）
print("\n   提示: 要完整测试，需要:")
print("   1. 在前端登录获取 token")
print("   2. 使用 curl 命令测试:")
print(f"      curl -X GET '{BASE_URL}/api/platform-data/detail?begin_date=2026-01-01&end_date=2026-01-31&platform=LH' \\")
print("           -H 'Authorization: Bearer YOUR_TOKEN'")

# 3. 检查 API 路由是否注册
print("\n3. 检查 API 文档...")
try:
    docs_response = requests.get(f"{BASE_URL}/docs", timeout=5)
    if docs_response.status_code == 200:
        print(f"   ✓ API 文档可访问: {BASE_URL}/docs")
        print(f"   可以在浏览器中打开查看 API 定义")
    else:
        print(f"   ✗ API 文档不可访问: {docs_response.status_code}")
except Exception as e:
    print(f"   ✗ 错误: {e}")

print("\n" + "=" * 60)
print("建议:")
print("1. 确保服务正在运行: curl http://127.0.0.1:8000/health")
print("2. 在前端浏览器中打开开发者工具 (F12)")
print("3. 查看 Network 标签，找到 /api/platform-data/detail 请求")
print("4. 检查请求的 URL、参数和响应")
print("=" * 60)

