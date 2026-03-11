"""Restart backend + verify (fire-and-forget style)"""
import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

BACKEND = "/home/admin/Google-Data-Analysis/backend"

def r(cmd, t=15):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# Kill existing
print("Killing existing uvicorn...")
r("pkill -f 'uvicorn app.main' 2>/dev/null; sleep 1; pkill -9 -f 'uvicorn app.main' 2>/dev/null", 10)
time.sleep(2)

# Verify killed
out, _ = r("ps aux | grep uvicorn | grep -v grep")
print(f"After kill: {out or 'clean'}")

# Start with fire-and-forget (don't wait for stdout)
print("\nStarting uvicorn...")
ssh.exec_command(
    f"cd {BACKEND} && source venv/bin/activate && "
    f"nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 "
    f"> /home/admin/backend.log 2>&1 &"
)
print("Command sent (fire-and-forget)")

# Wait for startup
print("Waiting 8 seconds for startup...")
time.sleep(8)

# Verify
print("\n=== Verification ===")
out, _ = r("ps aux | grep uvicorn | grep -v grep")
print(f"Processes:\n{out}")

out, _ = r('curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health', 10)
print(f"Health check: {out}")

# Check articles.py was updated
print("\n=== Check articles.py URL logic ===")
out, _ = r(f"grep -n 'article_html_pattern\\|detected_config' {BACKEND}/app/api/articles.py | head -10")
print(out)

# Quick AI test
print("\n=== Quick AI test ===")
out, err = r(f"""cd {BACKEND} && source venv/bin/activate && python3 -c "
import sys; sys.path.insert(0, '.')
from app.services.article_gen_service import _extract_json_text
import json

# Test markdown wrapped JSON
raw = '\`\`\`json\n{{\"status\": \"ok\"}}\n\`\`\`'
result = _extract_json_text(raw)
parsed = json.loads(result)
print(f'Markdown test: {{parsed}}')

# Test prefix text
raw2 = 'Here is the JSON:\n{{\"category\": \"fashion\", \"titles\": []}}'
result2 = _extract_json_text(raw2)
parsed2 = json.loads(result2)
print(f'Prefix test: {{parsed2}}')

print('All JSON extraction tests passed!')
" """, 15)
print(out)
if err:
    print(f"STDERR: {err[:300]}")

# Check recent log
print("\n=== Recent backend log ===")
out, _ = r("tail -5 /home/admin/backend.log")
print(out)

ssh.close()
print("\nDone!")
