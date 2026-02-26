"""
Rewardoo TransactionDetails API 测试脚本
根据官方API文档测试数据获取功能
"""
import os
import requests
import json
from datetime import datetime, timedelta

# API配置
API_URL = "https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details"
TOKEN = os.environ.get("REWARDOO_TOKEN", "")  # 从环境变量读取

def test_transaction_details_api():
    """测试TransactionDetails API"""
    print("=" * 60)
    print("Rewardoo TransactionDetails API 测试")
    print("=" * 60)
    
    # 准备测试数据（最近7天）
    end_date = datetime.now()
    begin_date = end_date - timedelta(days=7)
    
    begin_date_str = begin_date.strftime("%Y-%m-%d")
    end_date_str = end_date.strftime("%Y-%m-%d")
    
    print(f"\n📅 测试日期范围: {begin_date_str} ~ {end_date_str}")
    print(f"🔗 API URL: {API_URL}")
    print(f"🔑 Token: {TOKEN[:20]}...")
    
    # 准备请求参数
    params = {
        "token": TOKEN,
        "begin_date": begin_date_str,
        "end_date": end_date_str,
        "page": 1,
        "limit": 1000
    }
    
    print(f"\n📤 请求参数:")
    for key, value in params.items():
        if key == "token":
            print(f"  {key}: {value[:20]}...")
        else:
            print(f"  {key}: {value}")
    
    try:
        print(f"\n⏳ 发送请求...")
        # 使用 application/x-www-form-urlencoded 格式
        response = requests.post(
            API_URL,
            data=params,  # 使用data参数，requests会自动编码为application/x-www-form-urlencoded
            headers={
                "Content-Type": "application/x-www-form-urlencoded"
            },
            timeout=30
        )
        
        print(f"📥 响应状态码: {response.status_code}")
        
        if response.status_code != 200:
            print(f"❌ HTTP错误: {response.status_code}")
            print(f"响应内容: {response.text[:500]}")
            return
        
        # 解析JSON响应
        try:
            result = response.json()
        except json.JSONDecodeError as e:
            print(f"❌ JSON解析失败: {e}")
            print(f"响应内容: {response.text[:500]}")
            return
        
        # 检查状态码
        status = result.get("status", {})
        code = status.get("code")
        msg = status.get("msg", "Unknown")
        
        print(f"\n📊 响应状态:")
        print(f"  Code: {code}")
        print(f"  Message: {msg}")
        
        if code == 0:
            print("✅ 请求成功！")
            
            # 解析数据
            data = result.get("data", {})
            total_trans = data.get("total_trans", 0)
            total_page = data.get("total_page", 0)
            total_items = data.get("total_items", 0)
            transaction_list = data.get("list", [])
            
            print(f"\n📈 数据统计:")
            print(f"  总交易数: {total_trans}")
            print(f"  总页数: {total_page}")
            print(f"  总商品数: {total_items}")
            print(f"  当前页交易数: {len(transaction_list)}")
            
            if transaction_list:
                print(f"\n📋 交易示例（前3条）:")
                for i, trans in enumerate(transaction_list[:3], 1):
                    print(f"\n  交易 {i}:")
                    print(f"    Order ID: {trans.get('order_id', 'N/A')}")
                    print(f"    商户: {trans.get('merchant_name', 'N/A')}")
                    print(f"    交易时间: {trans.get('order_time', 'N/A')}")
                    print(f"    销售金额: ${trans.get('sale_amount', '0')}")
                    print(f"    佣金: ${trans.get('sale_comm', '0')}")
                    print(f"    状态: {trans.get('status', 'N/A')}")
                    print(f"    验证日期: {trans.get('validation_date', 'N/A')}")
            else:
                print("\n⚠️  该日期范围内没有交易数据")
        else:
            print(f"❌ API返回错误: {msg} (Code: {code})")
            
            # 错误码说明
            error_codes = {
                1000: "Affiliate does not exist (联盟账号不存在)",
                1001: "Invalid token (Token无效)",
                1002: "Call frequency too high (调用频率过高)",
                1003: "Missing required parameters or incorrect format (缺少必需参数或格式错误)",
                1005: "uid can not exceed 200 characters (uid不能超过200字符)",
                1006: "Query time span cannot exceed 62 days (查询时间跨度不能超过62天)"
            }
            
            if code in error_codes:
                print(f"   说明: {error_codes[code]}")
    
    except requests.exceptions.Timeout:
        print("❌ 请求超时")
    except requests.exceptions.ConnectionError as e:
        print(f"❌ 连接错误: {e}")
    except Exception as e:
        print(f"❌ 发生错误: {e}")
        import traceback
        traceback.print_exc()


def test_different_date_ranges():
    """测试不同的日期范围"""
    print("\n" + "=" * 60)
    print("测试不同日期范围")
    print("=" * 60)
    
    test_cases = [
        ("最近1天", 1),
        ("最近7天", 7),
        ("最近30天", 30),
        ("最近62天", 62),  # 最大允许范围
    ]
    
    for name, days in test_cases:
        print(f"\n📅 测试: {name} ({days}天)")
        end_date = datetime.now()
        begin_date = end_date - timedelta(days=days-1)  # -1因为包含当天
        
        begin_date_str = begin_date.strftime("%Y-%m-%d")
        end_date_str = end_date.strftime("%Y-%m-%d")
        
        params = {
            "token": TOKEN,
            "begin_date": begin_date_str,
            "end_date": end_date_str,
            "page": 1,
            "limit": 100
        }
        
        try:
            response = requests.post(
                API_URL,
                data=params,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=30
            )
            
            if response.status_code == 200:
                result = response.json()
                status = result.get("status", {})
                code = status.get("code")
                
                if code == 0:
                    data = result.get("data", {})
                    total_trans = data.get("total_trans", 0)
                    print(f"  ✅ 成功 - 交易数: {total_trans}")
                else:
                    print(f"  ❌ 失败 - Code: {code}, Message: {status.get('msg')}")
            else:
                print(f"  ❌ HTTP错误: {response.status_code}")
        except Exception as e:
            print(f"  ❌ 错误: {e}")


if __name__ == "__main__":
    # 基本测试
    test_transaction_details_api()
    
    # 测试不同日期范围
    # test_different_date_ranges()

