"""Diagnose AI service on server: check API connectivity, model availability, and response format"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)

def r(cmd, t=30):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# Step 0: Find backend path
print("=== Finding backend path ===")
out, _ = r("find /www /home /opt -name 'article_gen_service.py' -path '*/services/*' 2>/dev/null | head -3", 15)
print(f"Found: {out}")
if out:
    backend_path = out.split("\n")[0].replace("/app/services/article_gen_service.py", "")
    print(f"Backend path: {backend_path}")
else:
    print("Cannot find backend, trying alternatives...")
    for p in ["/www/wwwroot/google-analysis/backend", "/home/ubuntu/google-analysis/backend", "/opt/backend"]:
        out2, _ = r(f"test -f {p}/app/services/article_gen_service.py && echo YES || echo NO")
        if out2 == "YES":
            backend_path = p
            print(f"Found at: {backend_path}")
            break
    else:
        print("ERROR: Cannot find backend!")
        bt.close()
        sys.exit(1)

# Step 1: Check current config (API key, base URL, model)
print("\n=== Step 1: Check AI config ===")
config_cmd = f"""cd {backend_path} && python3 -c "
import sys; sys.path.insert(0, '.')
from app.config import settings
print(f'API Key: {{settings.gemini_api_key[:15]}}...' if settings.gemini_api_key else 'API Key: NOT SET')
print(f'Base URL: {{settings.gemini_base_url}}')
print(f'Model: {{settings.gemini_model}}')
"
"""
out, err = r(config_cmd, 15)
print(out)
if err:
    print(f"STDERR: {err}")

# Step 2: Test AI API directly
print("\n=== Step 2: Test AI API ===")
test_cmd = f"""cd {backend_path} && python3 -c "
import sys, json; sys.path.insert(0, '.')
from app.config import settings
import httpx

url = settings.gemini_base_url.rstrip('/') + '/v1/chat/completions'
headers = {{
    'Authorization': f'Bearer {{settings.gemini_api_key}}',
    'Content-Type': 'application/json',
}}

models_to_test = ['claude-sonnet-4-6', 'deepseek-chat', settings.gemini_model]

for model in models_to_test:
    print(f'\\nTesting model: {{model}}')
    payload = {{
        'model': model,
        'messages': [
            {{'role': 'system', 'content': 'You are a JSON API. Respond with ONLY valid JSON.'}},
            {{'role': 'user', 'content': 'Return JSON: {{\\\"test\\\": true, \\\"message\\\": \\\"hello\\\"}}'}},
        ],
        'max_tokens': 100,
        'temperature': 0.1,
    }}
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, json=payload, headers=headers)
            print(f'  Status: {{resp.status_code}}')
            if resp.status_code == 200:
                data = resp.json()
                content = data['choices'][0]['message']['content']
                print(f'  Response: {{content[:200]}}')
            else:
                print(f'  Error: {{resp.text[:300]}}')
    except Exception as e:
        print(f'  Error: {{e}}')
"
"""
out, err = r(test_cmd, 60)
print(out)
if err:
    print(f"STDERR: {err}")

# Step 3: Check recent server logs for AI errors
print("\n=== Step 3: Recent AI-related logs ===")
log_cmd = f"grep -i 'ArticleGen\\|analyze_merchant\\|标题生成\\|商家分析\\|模型.*失败\\|failed' {backend_path}/../*.log {backend_path}/logs/*.log /var/log/supervisor/*.log 2>/dev/null | tail -20"
out, _ = r(log_cmd, 15)
print(out if out else "No relevant logs found")

# Step 4: Test merchant_crawler
print("\n=== Step 4: Test merchant crawler ===")
crawl_cmd = f"""cd {backend_path} && timeout 30 python3 -c "
import sys; sys.path.insert(0, '.')
from app.services.merchant_crawler import crawl
result = crawl('https://www.nike.com/')
print(f'Brand: {{result.get(\"brand_name\", \"EMPTY\")}}')
print(f'Crawl failed: {{result.get(\"crawl_failed\", False)}}')
print(f'Pages: {{len(result.get(\"pages\", []))}}')
text = result.get('raw_text', '')
print(f'Raw text length: {{len(text)}}')
print(f'Raw text sample: {{text[:300]}}')
" 2>&1 || echo 'TIMEOUT or ERROR'
"""
out, err = r(crawl_cmd, 45)
print(out[:2000])

bt.close()
print("\nDone.")
