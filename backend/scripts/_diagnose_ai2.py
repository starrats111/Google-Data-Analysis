"""Diagnose AI service on the actual backend server (47.239.193.33)"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

BACKEND = "/home/admin/Google-Data-Analysis/backend"

def r(cmd, t=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# Step 1: Check backend is running
print("=== Step 1: Backend status ===")
out, _ = r("ps aux | grep uvicorn | grep -v grep")
print(out if out else "NOT RUNNING!")

# Step 2: Check AI config
print("\n=== Step 2: AI config ===")
out, err = r(f"""cd {BACKEND} && source venv/bin/activate && python3 -c "
import sys; sys.path.insert(0, '.')
from app.config import settings
print(f'API Key: {{settings.gemini_api_key[:20]}}...' if settings.gemini_api_key else 'API Key: NOT SET')
print(f'Base URL: {{settings.gemini_base_url}}')
print(f'Model: {{settings.gemini_model}}')
" """, 15)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

# Step 3: Check current article_gen_service.py models on server
print("\n=== Step 3: Current models in article_gen_service.py ===")
out, _ = r(f"grep -n 'FAST_MODELS\\|SMART_MODELS\\|fallback' {BACKEND}/app/services/article_gen_service.py | head -10")
print(out)

# Step 4: Test AI API with each model
print("\n=== Step 4: Test AI API ===")
out, err = r(f"""cd {BACKEND} && source venv/bin/activate && python3 -c "
import sys, json; sys.path.insert(0, '.')
from app.config import settings
import httpx

url = settings.gemini_base_url.rstrip('/') + '/v1/chat/completions'
headers = {{
    'Authorization': f'Bearer {{settings.gemini_api_key}}',
    'Content-Type': 'application/json',
}}

models_to_test = ['claude-sonnet-4-6', 'deepseek-chat', 'gpt-4o-mini', settings.gemini_model]

for model in models_to_test:
    print(f'Testing model: {{model}}')
    payload = {{
        'model': model,
        'messages': [
            {{'role': 'system', 'content': 'You are a JSON API. Respond with ONLY valid JSON, nothing else.'}},
            {{'role': 'user', 'content': 'Return: {{\\\"status\\\": \\\"ok\\\"}}'}},
        ],
        'max_tokens': 50,
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
        print(f'  Error: {{type(e).__name__}}: {{e}}')
    print()
" """, 120)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

# Step 5: Check recent backend logs
print("\n=== Step 5: Recent backend logs (AI-related) ===")
out, _ = r(f"grep -i 'ArticleGen\\|分析失败\\|模型.*失败\\|crawl.*fail\\|500\\|Error' /home/admin/backend.log 2>/dev/null | tail -30")
print(out[:2000] if out else "No relevant logs or log file not found")

# Step 6: Check crawler
print("\n=== Step 6: Test crawler ===")
out, err = r(f"""cd {BACKEND} && source venv/bin/activate && timeout 25 python3 -c "
import sys; sys.path.insert(0, '.')
from app.services.merchant_crawler import crawl
result = crawl('https://www.nike.com/')
print(f'Brand: {{result.get(\"brand_name\", \"EMPTY\")}}')
print(f'Crawl failed: {{result.get(\"crawl_failed\", False)}}')
print(f'Pages: {{len(result.get(\"pages\", []))}}')
text = result.get('raw_text', '')
print(f'Raw text length: {{len(text)}}')
if text:
    print(f'Sample: {{text[:200]}}')
" 2>&1 || echo 'TIMEOUT or ERROR'""", 40)
print(out[:1500])

ssh.close()
print("\nDone.")
