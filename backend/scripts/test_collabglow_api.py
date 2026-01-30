#!/usr/bin/env python3
"""
CollabGlow API 测试脚本
用于测试佣金验证 API 并提取订单和佣金数据
"""

import requests
import json
from datetime import datetime, timedelta
from typing import Dict, List, Optional

# API 配置
API_URL = "https://api.collabglow.com/api/commission_validation"
SOURCE = "collabglow"
TOKEN = "916a0dbbfe6c3e7fb19fb5ee119b82a2"  # 请替换为你的实际 token


def test_commission_validation(begin_date: str, end_date: str) -> Optional[Dict]:
    """
    测试佣金验证 API
    
    Args:
        begin_date: 开始日期，格式 YYYY-MM-DD
        end_date: 结束日期，格式 YYYY-MM-DD
    
    Returns:
        API 响应数据，如果失败返回 None
    """
    headers = {
        "Content-Type": "application/json"
    }
    
    payload = {
        "source": SOURCE,
        "token": TOKEN,
        "beginDate": begin_date,
        "endDate": end_date
    }
    
    print(f"\n{'='*60}")
    print(f"测试 CollabGlow API")
    print(f"{'='*60}")
    print(f"URL: {API_URL}")
    print(f"开始日期: {begin_date}")
    print(f"结束日期: {end_date}")
    print(f"{'='*60}\n")
    
    try:
        response = requests.post(API_URL, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        
        result = response.json()
        
        # 检查返回码
        code = result.get("code")
        message = result.get("message", "")
        
        print(f"返回码: {code}")
        print(f"消息: {message}\n")
        
        if code == "0":
            data = result.get("data", {})
            commission_list = data.get("list", [])
            
            print(f"✅ 成功获取 {len(commission_list)} 条佣金记录\n")
            
            # 打印详细信息
            if commission_list:
                print("佣金明细:")
                print("-" * 100)
                total_commission = 0
                
                for idx, item in enumerate(commission_list, 1):
                    brand_id = item.get("brand_id", 0)
                    mcid = item.get("mcid", "N/A")
                    sale_comm = item.get("sale_comm", 0)
                    settlement_date = item.get("settlement_date", "N/A")
                    note = item.get("note", "N/A")
                    settlement_id = item.get("settlement_id", "N/A")
                    
                    total_commission += float(sale_comm) if sale_comm else 0
                    
                    print(f"\n记录 #{idx}:")
                    print(f"  品牌ID: {brand_id}")
                    print(f"  MCID: {mcid}")
                    print(f"  佣金金额: ${sale_comm:.2f}")
                    print(f"  结算日期: {settlement_date}")
                    print(f"  备注: {note}")
                    print(f"  结算ID: {settlement_id}")
                
                print("\n" + "-" * 100)
                print(f"总佣金: ${total_commission:.2f}")
                print("-" * 100)
            else:
                print("⚠️  该时间段内没有佣金记录")
            
            return result
        else:
            print(f"❌ API 返回错误: {message}")
            if code == "1000":
                print("   错误说明: Publisher does not exist (发布者不存在)")
            elif code == "1001":
                print("   错误说明: Invalid token (无效的 token)")
            elif code == "1006":
                print("   错误说明: Query time span cannot exceed 62 days (查询时间跨度不能超过62天)")
            elif code == "10001":
                print("   错误说明: Missing required parameters or incorrect format (缺少必需参数或格式不正确)")
            return None
            
    except requests.exceptions.RequestException as e:
        print(f"❌ 请求失败: {str(e)}")
        return None
    except json.JSONDecodeError as e:
        print(f"❌ JSON 解析失败: {str(e)}")
        print(f"响应内容: {response.text[:500]}")
        return None
    except Exception as e:
        print(f"❌ 发生错误: {str(e)}")
        import traceback
        traceback.print_exc()
        return None


def extract_commission_data(result: Dict) -> List[Dict]:
    """
    从 API 响应中提取佣金数据
    
    Args:
        result: API 响应数据
    
    Returns:
        提取的佣金数据列表
    """
    if not result or result.get("code") != "0":
        return []
    
    data = result.get("data", {})
    commission_list = data.get("list", [])
    
    extracted = []
    for item in commission_list:
        extracted.append({
            "brand_id": item.get("brand_id", 0),
            "mcid": item.get("mcid"),
            "sale_commission": item.get("sale_comm", 0),
            "settlement_date": item.get("settlement_date"),
            "note": item.get("note"),
            "settlement_id": item.get("settlement_id")
        })
    
    return extracted


def main():
    """主函数"""
    print("\n" + "="*60)
    print("CollabGlow API 测试脚本")
    print("="*60)
    
    # 测试1: 查询最近30天的数据
    today = datetime.now()
    end_date = today.strftime("%Y-%m-%d")
    begin_date = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    
    print(f"\n📅 测试1: 查询最近30天的佣金数据")
    result1 = test_commission_validation(begin_date, end_date)
    
    if result1:
        extracted_data = extract_commission_data(result1)
        print(f"\n✅ 成功提取 {len(extracted_data)} 条佣金记录")
        
        # 保存到文件（可选）
        output_file = f"collabglow_commission_{begin_date}_to_{end_date}.json"
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(extracted_data, f, ensure_ascii=False, indent=2)
        print(f"💾 数据已保存到: {output_file}")
    
    # 测试2: 查询上个月的数据
    print(f"\n\n{'='*60}")
    first_day_this_month = today.replace(day=1)
    last_day_last_month = first_day_this_month - timedelta(days=1)
    first_day_last_month = last_day_last_month.replace(day=1)
    
    begin_date2 = first_day_last_month.strftime("%Y-%m-%d")
    end_date2 = last_day_last_month.strftime("%Y-%m-%d")
    
    print(f"📅 测试2: 查询上个月 ({begin_date2} ~ {end_date2}) 的佣金数据")
    result2 = test_commission_validation(begin_date2, end_date2)
    
    if result2:
        extracted_data2 = extract_commission_data(result2)
        print(f"\n✅ 成功提取 {len(extracted_data2)} 条佣金记录")
        
        output_file2 = f"collabglow_commission_{begin_date2}_to_{end_date2}.json"
        with open(output_file2, "w", encoding="utf-8") as f:
            json.dump(extracted_data2, f, ensure_ascii=False, indent=2)
        print(f"💾 数据已保存到: {output_file2}")
    
    print(f"\n{'='*60}")
    print("测试完成！")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()

