"""Deploy to backend server: git pull + restart uvicorn"""
import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

BACKEND = "/home/admin/Google-Data-Analysis/backend"
PROJECT = "/home/admin/Google-Data-Analysis"

def r(cmd, t=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# Step 1: Git pull
print("=== Step 1: Git pull ===")
out, err = r(f"cd {PROJECT} && git pull origin main", 30)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

# Step 2: Kill existing uvicorn
print("\n=== Step 2: Kill existing uvicorn ===")
out, _ = r("pkill -f 'uvicorn app.main' || echo 'No process to kill'")
print(out)
time.sleep(2)

# Step 3: Start uvicorn
print("\n=== Step 3: Start uvicorn ===")
out, err = r(f"cd {BACKEND} && source venv/bin/activate && nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /home/admin/backend.log 2>&1 & echo STARTED", 10)
print(out)
time.sleep(5)

# Step 4: Verify
print("\n=== Step 4: Verify ===")
out, _ = r("ps aux | grep uvicorn | grep -v grep")
print(f"Processes:\n{out}")

out, _ = r('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health')
print(f"Health check: {out}")

# Step 5: Quick AI test
print("\n=== Step 5: Quick AI test ===")
out, err = r(f"""cd {BACKEND} && source venv/bin/activate && python3 -c "
import sys; sys.path.insert(0, '.')
from app.services.article_gen_service import ArticleGenService, _extract_json_text

# Test _extract_json_text
tests = [
    ('```json\\n{{\\\"test\\\": true}}\\n```', 'markdown wrapped'),
    ('Here is the result:\\n{{\\\"test\\\": true}}', 'prefix text'),
    ('{{\\\"test\\\": true}}', 'clean json'),
    ('', 'empty'),
]
for raw, desc in tests:
    result = _extract_json_text(raw)
    print(f'  {desc}: {repr(result[:80])}')

# Test actual API call
svc = ArticleGenService()
try:
    result = svc.analyze_merchant({{'raw_text': 'Nike is a global sportswear brand', 'brand_name': 'Nike'}}, 'en')
    print(f'\\nAI analyze_merchant result:')
    print(f'  category: {{result.get(\"category\")}}')
    print(f'  titles: {{len(result.get(\"titles\", []))}} items')
    print(f'  keywords: {{result.get(\"keywords\", [])}}')
    if result.get('titles'):
        print(f'  first title: {{result[\"titles\"][0]}}')
except Exception as e:
    print(f'  AI test failed: {{e}}')
" """, 60)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

# Step 6: Verify updated files
print("\n=== Step 6: Verify deployed files ===")
out, _ = r(f"head -20 {BACKEND}/app/services/article_gen_service.py")
print(out)

ssh.close()
print("\nDone!")
