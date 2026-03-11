"""Test AI service on backend server using actual settings"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

def r(cmd, t=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

BACKEND = "/home/admin/Google-Data-Analysis/backend"

# Test 1: Use actual settings module
print("=== Test 1: Load settings and test AI ===")
test_py = r'''
import sys, os, json
os.chdir("''' + BACKEND + r'''")
sys.path.insert(0, ".")
from dotenv import load_dotenv
load_dotenv()

# Check dotenv loaded correctly
api_key = os.getenv("gemini_api_key", "")
base_url = os.getenv("gemini_base_url", "")
model = os.getenv("gemini_model", "")
print(f"Direct env: key={api_key[:15]}... base={base_url} model={model}")

# Now test via settings
from app.config import settings
print(f"Settings: key={settings.gemini_api_key[:15]}... base={settings.gemini_base_url} model={settings.gemini_model}")

# Test AI call
import httpx
url = f"{settings.gemini_base_url.rstrip('/')}/v1/chat/completions"
headers = {"Authorization": f"Bearer {settings.gemini_api_key}", "Content-Type": "application/json"}

for model_name in ["claude-sonnet-4-6", "deepseek-chat"]:
    try:
        payload = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": "You are a JSON API. Respond with ONLY valid JSON, no explanation."},
                {"role": "user", "content": 'Analyze this merchant: brand="Nike", website sells shoes and sportswear. Return JSON: {"category":"fashion","products":["shoes"],"selling_points":["quality"],"titles":[{"title":"t1","title_en":"T1"}],"keywords":["nike"]}'}
            ],
            "max_tokens": 500, "temperature": 0.3
        }
        resp = httpx.post(url, json=payload, headers=headers, timeout=30)
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            print(f"\n  {model_name}: OK")
            print(f"  Response: {content[:300]}")
            # Try to parse
            try:
                parsed = json.loads(content.strip())
                print(f"  Parsed OK: keys={list(parsed.keys())}")
            except:
                print(f"  JSON parse FAILED")
        else:
            print(f"\n  {model_name}: HTTP {resp.status_code}")
            print(f"  Body: {resp.text[:300]}")
    except Exception as e:
        print(f"\n  {model_name}: ERROR -> {e}")
'''

sftp = ssh.open_sftp()
with sftp.open("/tmp/_test_ai_full.py", "w") as f:
    f.write(test_py.encode("utf-8"))

out, err = r(f"cd {BACKEND} && source venv/bin/activate && python3 /tmp/_test_ai_full.py", 90)
print(out)
if err:
    print(f"STDERR: {err}")

# Test 2: Check recent crawl logs 
print("\n\n=== Test 2: Recent backend logs ===")
out, _ = r("tail -300 /home/admin/backend.log 2>/dev/null | grep -i 'crawl\\|分析\\|ArticleGen\\|商家\\|标题\\|failed\\|error\\|Exception' | tail -30")
print(out or "(no matching logs)")

# Test 3: Check if the crawl function works
print("\n\n=== Test 3: Test crawl function ===")
crawl_test = r'''
import sys, os
os.chdir("''' + BACKEND + r'''")
sys.path.insert(0, ".")
from dotenv import load_dotenv
load_dotenv()
from app.services.merchant_crawler import crawl

result = crawl("https://www.nike.com/")
print(f"brand_name: {result.get('brand_name', 'EMPTY')}")
print(f"crawl_failed: {result.get('crawl_failed', False)}")
print(f"error: {result.get('error', '')}")
print(f"raw_text length: {len(result.get('raw_text', ''))}")
print(f"pages: {len(result.get('pages', []))}")
print(f"images: {sum(len(p.get('images',[])) for p in result.get('pages',[]))}")
if result.get('raw_text'):
    print(f"raw_text preview: {result['raw_text'][:200]}")
'''
with sftp.open("/tmp/_test_crawl.py", "w") as f:
    f.write(crawl_test.encode("utf-8"))
out, err = r(f"cd {BACKEND} && source venv/bin/activate && python3 /tmp/_test_crawl.py", 60)
print(out)
if err:
    print(f"STDERR: {err}")

sftp.close()
ssh.close()
print("\nDone!")
