"""
从 ECS 服务器诊断 LH / LB / CF / RW 平台 API 调用
测试每个平台的实际 API 响应，找出同步失败的原因
"""
import paramiko
import json
import sys
import textwrap

SERVER = "47.239.193.33"
USER = "admin"
PASS = "A123456"
PROJECT = "/home/admin/Google-Data-Analysis"

def ssh_exec(ssh, cmd, timeout=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    return out, err

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(SERVER, username=USER, password=PASS, timeout=15)
    print("=== SSH 连接成功 ===\n")

    diag_script = textwrap.dedent(r'''
import sys, os, json, time
sys.path.insert(0, "/home/admin/Google-Data-Analysis/backend")
os.chdir("/home/admin/Google-Data-Analysis/backend")

from app.database import SessionLocal
from app.models.affiliate_account import AffiliateAccount, AffiliatePlatform
from app.models.campaign_link_cache import CampaignLinkCache
from app.models.user import User
from app.services.merchant_platform_sync import MerchantPlatformSyncService, PLATFORM_API_CONFIG
from app.utils.crypto import decrypt_token
from sqlalchemy import func
import httpx

db = SessionLocal()

# 1. 检查各平台的缓存状态
print("=" * 60)
print("1. 各平台缓存状态")
print("=" * 60)
platforms = db.query(
    CampaignLinkCache.platform_code,
    func.count(CampaignLinkCache.id)
).group_by(CampaignLinkCache.platform_code).all()
for p, c in platforms:
    print(f"  {p}: {c} 条")

# 2. 检查各平台的账号和 token 情况
print("\n" + "=" * 60)
print("2. 各平台账号/Token 状态")
print("=" * 60)
accounts = (
    db.query(AffiliateAccount, AffiliatePlatform)
    .join(AffiliatePlatform)
    .filter(AffiliateAccount.is_active.is_(True))
    .all()
)

platform_tokens = {}
for acct, plat in accounts:
    code = plat.platform_code.upper()
    token = MerchantPlatformSyncService._resolve_token(acct, code)
    if code not in platform_tokens:
        platform_tokens[code] = []
    platform_tokens[code].append({
        "acct_name": acct.account_name,
        "user_id": acct.user_id,
        "has_token": bool(token),
        "token_preview": (token[:8] + "...") if token else "NONE",
    })

for code in ["LH", "LB", "CF", "RW", "CG", "BSH", "PM"]:
    items = platform_tokens.get(code, [])
    print(f"\n  [{code}] {len(items)} 个账号:")
    for it in items[:5]:
        print(f"    user={it['user_id']} acct={it['acct_name']} token={it['token_preview']}")

# 3. 逐个测试有问题的平台 API
print("\n" + "=" * 60)
print("3. 平台 API 实测")
print("=" * 60)

timeout = httpx.Timeout(30.0, connect=10.0)

for test_platform in ["LH", "LB", "CF", "RW"]:
    print(f"\n--- [{test_platform}] ---")
    cfg = PLATFORM_API_CONFIG.get(test_platform)
    if not cfg:
        print(f"  未找到配置!")
        continue

    print(f"  配置: mode={cfg['mode']}, url={cfg['url']}")
    
    tokens = platform_tokens.get(test_platform, [])
    if not tokens:
        print(f"  无账号!")
        continue
    
    # 找一个有 token 的账号
    test_token = None
    for t in tokens:
        if t["has_token"]:
            # 重新获取完整 token
            for acct2, plat2 in accounts:
                if acct2.account_name == t["acct_name"] and plat2.platform_code.upper() == test_platform:
                    test_token = MerchantPlatformSyncService._resolve_token(acct2, test_platform)
                    break
            if test_token:
                print(f"  使用账号: {t['acct_name']} (user={t['user_id']})")
                break
    
    if not test_token:
        print(f"  无有效 Token!")
        continue

    # 测试 A: 按当前配置的 mode 调用
    mode = cfg["mode"]
    url = cfg["url"]
    print(f"\n  [测试A] 按配置 mode={mode} 调用...")
    try:
        if mode == "post_json":
            payload = {
                "source": cfg.get("source", ""),
                "token": test_token,
                cfg.get("page_key", "curPage"): 1,
                cfg.get("size_key", "perPage"): 5,
                "relationship": "Joined",
            }
            resp = httpx.post(url, json=payload, timeout=timeout)
        elif mode == "post_form":
            form_data = {
                "token": test_token,
                cfg.get("page_key", "page"): "1",
                cfg.get("size_key", "per_page"): "5",
            }
            if not cfg.get("skip_relationship_filter"):
                form_data["relationship"] = "Joined"
            resp = httpx.post(url, data=form_data, timeout=timeout)
        else:
            params = {
                "token": test_token,
                cfg.get("page_key", "page"): "1",
                cfg.get("size_key", "limit"): "5",
            }
            resp = httpx.get(url, params=params, timeout=timeout)
        
        print(f"  状态码: {resp.status_code}")
        try:
            data = resp.json()
            # 提取 items
            items = MerchantPlatformSyncService._extract_items(data)
            print(f"  返回 items 数量: {len(items)}")
            if items:
                first = items[0]
                print(f"  第一条数据字段: {list(first.keys())[:10]}")
                print(f"  第一条: mcid={first.get('mcid')}, mid={first.get('mid')}, name={first.get('merchant_name', '')[:30]}")
            else:
                # 显示原始响应帮助诊断
                resp_text = json.dumps(data, ensure_ascii=False)[:500]
                print(f"  原始响应: {resp_text}")
        except Exception as e:
            print(f"  JSON 解析失败: {e}")
            print(f"  原始文本: {resp.text[:300]}")
    except Exception as e:
        print(f"  请求失败: {e}")

    # 测试 B: 如果是 LB，尝试 GET 方式
    if test_platform == "LB":
        print(f"\n  [测试B] LB 用 GET 方式调用...")
        try:
            params = {
                "token": test_token,
                "page": "1",
                "limit": "5",
                "type": "json",
                "relationship": "Joined",
            }
            resp = httpx.get(url, params=params, timeout=timeout)
            print(f"  状态码: {resp.status_code}")
            try:
                data = resp.json()
                items = MerchantPlatformSyncService._extract_items(data)
                print(f"  返回 items 数量: {len(items)}")
                if items:
                    first = items[0]
                    print(f"  第一条: mcid={first.get('mcid')}, mid={first.get('mid')}, name={first.get('merchant_name', '')[:30]}")
                else:
                    resp_text = json.dumps(data, ensure_ascii=False)[:500]
                    print(f"  原始响应: {resp_text}")
            except:
                print(f"  原始文本: {resp.text[:300]}")
        except Exception as e:
            print(f"  GET 请求失败: {e}")

        print(f"\n  [测试C] LB 用 POST + type=json 调用...")
        try:
            form_data = {
                "token": test_token,
                "page": "1",
                "limit": "5",
                "type": "json",
                "relationship": "Joined",
            }
            resp = httpx.post(url, data=form_data, timeout=timeout)
            print(f"  状态码: {resp.status_code}")
            try:
                data = resp.json()
                items = MerchantPlatformSyncService._extract_items(data)
                print(f"  返回 items 数量: {len(items)}")
                if items:
                    first = items[0]
                    print(f"  第一条: mcid={first.get('mcid')}, mid={first.get('mid')}, name={first.get('merchant_name', '')[:30]}")
                else:
                    resp_text = json.dumps(data, ensure_ascii=False)[:500]
                    print(f"  原始响应: {resp_text}")
            except:
                print(f"  原始文本: {resp.text[:300]}")
        except Exception as e:
            print(f"  POST+type 请求失败: {e}")

    # 测试 C: 如果是 LH，检查 GET vs POST
    if test_platform == "LH":
        print(f"\n  [测试B] LH 用 GET 方式调用...")
        try:
            params = {
                "token": test_token,
                "page": "1",
                "per_page": "5",
            }
            resp = httpx.get(url, params=params, timeout=timeout)
            print(f"  状态码: {resp.status_code}")
            try:
                data = resp.json()
                items = MerchantPlatformSyncService._extract_items(data)
                print(f"  GET 返回 items 数量: {len(items)}")
                if not items:
                    resp_text = json.dumps(data, ensure_ascii=False)[:500]
                    print(f"  原始响应: {resp_text}")
            except:
                print(f"  原始文本: {resp.text[:300]}")
        except Exception as e:
            print(f"  GET 请求失败: {e}")

# 4. 检查最近的同步日志
print("\n" + "=" * 60)
print("4. 最近同步日志")
print("=" * 60)
import subprocess
try:
    result = subprocess.run(
        ["grep", "-i", "campaignlinksync\|campaign_link_sync\|CampaignLink", 
         "/home/admin/Google-Data-Analysis/backend/logs/app.log"],
        capture_output=True, text=True, timeout=10
    )
    lines = result.stdout.strip().split("\n")
    # 只显示最后 30 行
    for line in lines[-30:]:
        print(f"  {line[:200]}")
except Exception as e:
    print(f"  日志读取失败: {e}")

# 也检查 nohup.out
try:
    result = subprocess.run(
        ["tail", "-100", "/home/admin/Google-Data-Analysis/backend/nohup.out"],
        capture_output=True, text=True, timeout=10
    )
    text = result.stdout.strip()
    # 查找同步相关的行
    sync_lines = [l for l in text.split("\n") if "sync" in l.lower() or "campaign" in l.lower() or "LH" in l or "LB" in l or "CF" in l]
    if sync_lines:
        print("\n  nohup.out 中的同步相关日志:")
        for l in sync_lines[-20:]:
            print(f"    {l[:200]}")
except Exception as e:
    print(f"  nohup.out 读取失败: {e}")

db.close()
print("\n=== 诊断完成 ===")
''')

    # 写入并执行诊断脚本
    ssh.exec_command(f"cat > /tmp/diag_platforms.py << 'PYEOF'\n{diag_script}\nPYEOF")
    import time
    time.sleep(1)

    print("正在执行远程诊断...")
    out, err = ssh_exec(ssh, f"cd {PROJECT}/backend && source venv/bin/activate && python3 /tmp/diag_platforms.py", timeout=120)
    
    if out:
        print(out)
    if err:
        print("STDERR:", err[-500:] if len(err) > 500 else err)
    
    ssh.close()

if __name__ == "__main__":
    main()
