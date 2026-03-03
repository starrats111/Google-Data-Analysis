"""精确分析数据差异 - 用原始每日数据手动计算三种IS方式的结果"""

# ============================================================
# wj04 原始数据 (2026-02-21 ~ 2026-02-23, 只有3天数据)
# ============================================================
wj04_data = {
    "072-PM1-eazy-DE-1218-18658152": [
        {"date": "02-21", "imp": 82, "clicks": 40, "cost": 8.67, "budget": 10, "bl": 0.7331, "rl": 0.1833, "sis": None, "currency": "USD"},
        {"date": "02-22", "imp": 104, "clicks": 46, "cost": 11.43, "budget": 10, "bl": 0.6252, "rl": 0.2569, "sis": None, "currency": "USD"},
        {"date": "02-23", "imp": 114, "clicks": 60, "cost": 11.92, "budget": 10, "bl": 0.5235, "rl": 0.3435, "sis": None, "currency": "USD"},
    ],
    "135-PM1-coppel-MX-1230-107283": [
        {"date": "02-21", "imp": 1779, "clicks": 1189, "cost": 13.00, "budget": 10, "bl": 0.9001, "rl": 0.0067, "sis": None, "currency": "USD"},
        {"date": "02-22", "imp": 1394, "clicks": 868, "cost": 10.01, "budget": 10, "bl": 0.9001, "rl": 0.0063, "sis": None, "currency": "USD"},
        {"date": "02-23", "imp": 1409, "clicks": 891, "cost": 10.57, "budget": 10, "bl": 0.9001, "rl": 0.0053, "sis": None, "currency": "USD"},
    ],
    "172-PM1-terracycle-US-0130-108500": [
        {"date": "02-21", "imp": 150, "clicks": 91, "cost": 9.54, "budget": 13, "bl": 0.6667, "rl": 0.1273, "sis": None, "currency": "USD"},
        {"date": "02-22", "imp": 103, "clicks": 63, "cost": 11.41, "budget": 13, "bl": 0.7670, "rl": 0.0744, "sis": None, "currency": "USD"},
        {"date": "02-23", "imp": 166, "clicks": 81, "cost": 16.35, "budget": 13, "bl": 0.6755, "rl": 0.1184, "sis": None, "currency": "USD"},
    ],
    "143-PM1-electronicsexpo-US-0109-18645439": [
        {"date": "02-21", "imp": 139, "clicks": 39, "cost": 10.52, "budget": 8.5, "bl": 0.0, "rl": 0.5610, "sis": None, "currency": "USD"},
        {"date": "02-22", "imp": 115, "clicks": 28, "cost": 7.48, "budget": 8.5, "bl": 0.0, "rl": 0.6994, "sis": None, "currency": "USD"},
        {"date": "02-23", "imp": 122, "clicks": 38, "cost": 11.26, "budget": 8.5, "bl": 0.0, "rl": 0.6442, "sis": None, "currency": "USD"},
    ],
}

# wj05 关键广告系列
wj05_data = {
    "117-LH1-hotelcollection-US-1226-154253": [
        {"date": "02-21", "imp": 149, "clicks": 65, "cost": 81.63, "budget": 70, "bl": 0.2239, "rl": 0.7220, "sis": None, "currency": "CNY"},
    ],
    "181-PM1-coppel-MX-0129-107283": [
        {"date": "02-21", "imp": 7037, "clicks": 2295, "cost": 71.03, "budget": 70, "bl": 0.0922, "rl": 0.8670, "sis": None, "currency": "CNY"},
    ],
    "210-CG1-houseofblanks-US-0210-18682754": [
        {"date": "02-21", "imp": 241, "clicks": 85, "cost": 20.08, "budget": 20, "bl": 0.3950, "rl": 0.5589, "sis": None, "currency": "USD"},
        {"date": "02-22", "imp": 269, "clicks": 92, "cost": 19.38, "budget": 20, "bl": 0.0047, "rl": 0.9001, "sis": None, "currency": "USD"},
        {"date": "02-23", "imp": 259, "clicks": 125, "cost": 22.47, "budget": 20, "bl": 0.0750, "rl": 0.8697, "sis": None, "currency": "USD"},
        {"date": "02-24", "imp": 284, "clicks": 106, "cost": 20.42, "budget": 15, "bl": 0.3132, "rl": 0.6437, "sis": None, "currency": "USD"},
        {"date": "02-26", "imp": 80, "clicks": 13, "cost": 1.39, "budget": 15, "bl": 0.0, "rl": 0.9001, "sis": 0.0999, "currency": "USD"},
    ],
    "200-CG1-trovata-US-0205-8005206": [
        {"date": "02-21", "imp": 163, "clicks": 37, "cost": 11.50, "budget": 20, "bl": 0.0, "rl": 0.5637, "sis": None, "currency": "USD"},
        {"date": "02-22", "imp": 166, "clicks": 46, "cost": 13.38, "budget": 20, "bl": 0.0, "rl": 0.5645, "sis": None, "currency": "USD"},
        {"date": "02-23", "imp": 223, "clicks": 84, "cost": 33.60, "budget": 20, "bl": 0.0032, "rl": 0.4387, "sis": None, "currency": "USD"},
    ],
    "209-CG1-1stphorm-US-0210-18680626": [
        {"date": "02-21", "imp": 565, "clicks": 85, "cost": 12.43, "budget": 15, "bl": 0.0, "rl": 0.9001, "sis": None, "currency": "USD"},
        {"date": "02-22", "imp": 615, "clicks": 120, "cost": 18.12, "budget": 15, "bl": 0.1043, "rl": 0.8101, "sis": None, "currency": "USD"},
        {"date": "02-23", "imp": 640, "clicks": 78, "cost": 15.60, "budget": 15, "bl": 0.2299, "rl": 0.6837, "sis": None, "currency": "USD"},
    ],
}

CNY_RATE = 7.2

def analyze(name, days, user):
    total_cost_raw = sum(d["cost"] for d in days)
    total_imp = sum(d["imp"] for d in days)
    total_clicks = sum(d["clicks"] for d in days)
    
    # 货币转换
    currency = days[0]["currency"]
    if currency == "CNY":
        total_cost_usd = total_cost_raw / CNY_RATE
    else:
        total_cost_usd = total_cost_raw
    
    # 方法1: max() - 当前服务器L7D分析使用的方式
    max_bl = max(d["bl"] for d in days)
    max_rl = max(d["rl"] for d in days)
    
    # 方法2: 最后一天 - by-campaign API使用的方式
    last_bl = days[-1]["bl"]
    last_rl = days[-1]["rl"]
    
    # 方法3: impressions加权平均 - 已修复但未部署的方式
    bl_wsum = sum(d["bl"] * d["imp"] for d in days if d["imp"] > 0)
    rl_wsum = sum(d["rl"] * d["imp"] for d in days if d["imp"] > 0)
    total_weight = sum(d["imp"] for d in days if d["imp"] > 0)
    weighted_bl = bl_wsum / total_weight if total_weight > 0 else 0
    weighted_rl = rl_wsum / total_weight if total_weight > 0 else 0
    
    return {
        "name": name, "days": len(days), "currency": currency,
        "cost_raw": total_cost_raw, "cost_usd": total_cost_usd,
        "imp": total_imp, "clicks": total_clicks,
        "max_bl": max_bl, "max_rl": max_rl,
        "last_bl": last_bl, "last_rl": last_rl,
        "weighted_bl": weighted_bl, "weighted_rl": weighted_rl,
    }

print("=" * 140)
print("  数据差异根因分析")
print("=" * 140)
print()
print("  三种IS计算方式对比:")
print("  [MAX]  = max(7天IS) — 当前服务器L7D分析使用")
print("  [LAST] = 最后一天IS — by-campaign API使用")
print("  [AVG]  = impressions加权平均 — 已修复未部署")
print()

for user, data in [("wj04", wj04_data), ("wj05", wj05_data)]:
    print(f"\n  {'=' * 130}")
    print(f"  {user} 关键广告系列对比")
    print(f"  {'=' * 130}")
    print(f"  {'广告系列':<50} {'天':>2} {'币':>3} {'原始费用':>8} {'USD费用':>8} | {'MAX_BL':>7} {'LAST_BL':>8} {'AVG_BL':>7} | {'MAX_RL':>7} {'LAST_RL':>8} {'AVG_RL':>7}")
    print("  " + "-" * 130)
    
    for name, days in data.items():
        r = analyze(name, days, user)
        short = name[:50]
        bl_diff = abs(r["max_bl"] - r["last_bl"]) > 0.02 or abs(r["max_bl"] - r["weighted_bl"]) > 0.02
        rl_diff = abs(r["max_rl"] - r["last_rl"]) > 0.02 or abs(r["max_rl"] - r["weighted_rl"]) > 0.02
        flag = " <<<" if bl_diff or rl_diff else ""
        
        print(f"  {short:<50} {r['days']:>2} {r['currency']:>3} {r['cost_raw']:>8.2f} {r['cost_usd']:>8.2f} | {r['max_bl']:>7.4f} {r['last_bl']:>8.4f} {r['weighted_bl']:>7.4f} | {r['max_rl']:>7.4f} {r['last_rl']:>8.4f} {r['weighted_rl']:>7.4f}{flag}")

# 特别分析 wj05 的 CNY 问题
print(f"\n\n  {'=' * 130}")
print(f"  wj05 货币转换分析")
print(f"  {'=' * 130}")
print(f"  117-LH1-hotelcollection: 原始费用=81.63 CNY, 转USD={81.63/7.2:.2f}")
print(f"  181-PM1-coppel-MX:       原始费用=71.03 CNY, 转USD={71.03/7.2:.2f}")
print(f"  by-campaign API 显示: hotelcollection=11.34, coppel=9.87 (已正确转换)")
print(f"  L7D l7d-data 显示:    hotelcollection=29.08, coppel=28.95 (???)")
print(f"  差异: hotelcollection L7D显示29.08 vs BC显示11.34 => L7D可能包含更多天数据")

# 分析天数差异
print(f"\n\n  {'=' * 130}")
print(f"  关键发现: 数据天数不一致!")
print(f"  {'=' * 130}")
print(f"  by-campaign API 日期范围: 2/21-2/27 (past7days)")
print(f"  但实际数据库中:")
print(f"  - wj04: 所有广告系列只有 2/21, 2/22, 2/23 三天数据")
print(f"  - wj05: 大部分只有 2/21-2/23, 少数有 2/24 或 2/26")
print(f"  - wj05 houseofblanks: 有5天 (2/21,22,23,24,26)")
print(f"  - wj05 lovingtan: 有4天 (2/21,22,23,24)")
print(f"  => 2/24之后的数据同步可能出了问题!")
