"""Check server's article_gen_service.py and backend state"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

def r(cmd, t=15):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

BE = "/home/admin/Google-Data-Analysis/backend"

# Check FAST_MODELS in deployed code
print("=== FAST_MODELS in deployed article_gen_service.py ===")
print(r(f"grep 'FAST_MODELS\\|SMART_MODELS' {BE}/app/services/article_gen_service.py | head -5"))

# Check _call_api JSON extraction
print("\n=== _call_api method signature + JSON extraction ===")
print(r(f"grep -n 'def _call_api\\|startswith\\|extract\\|JSON' {BE}/app/services/article_gen_service.py | head -10"))

# Check analyze_merchant method
print("\n=== analyze_merchant system prompt ===")
print(r(f"grep -n 'analyze_merchant\\|You are a JSON' {BE}/app/services/article_gen_service.py | head -10"))

# Check if API key loaded correctly in running backend
print("\n=== Test API key loading ===")
test = f"""cd {BE} && source venv/bin/activate && python3 -c "
import sys; sys.path.insert(0, '.')
from app.config import settings
k = settings.gemini_api_key
print(f'Key loaded: {{k[:10]}}...{{k[-5:]}}' if len(k)>15 else f'Key: {{repr(k)}}')
print(f'Base URL: {{settings.gemini_base_url}}')
print(f'Model: {{settings.gemini_model}}')
"
"""
print(r(test, 20))

# Check merchant crawl endpoint for recent errors
print("\n=== Recent errors ===")
print(r(f"tail -100 /home/admin/backend.log 2>/dev/null | grep -i 'ArticleGen\\|article_gen\\|crawl\\|analyze_merchant\\|error\\|failed\\|失败' | tail -20"))

# Check git status
print("\n=== Git status ===")
print(r(f"cd /home/admin/Google-Data-Analysis && git log --oneline -5"))

ssh.close()
print("\nDone!")
