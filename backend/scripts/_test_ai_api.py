"""Test AI API connectivity and model availability"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

def r(cmd, t=30):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    return out, err

# 1. Check .env for API key
print("=== Check .env API key ===")
out, _ = r("grep -i 'gemini_api_key\\|gemini_base_url\\|gemini_model' /home/admin/Google-Data-Analysis/backend/.env | head -10")
print(out)

# 2. Test API with different models
print("\n=== Test AI API Models ===")
test_script = '''
import sys, json, os
sys.path.insert(0, ".")
os.chdir("/home/admin/Google-Data-Analysis/backend")

# Load env
from dotenv import load_dotenv
load_dotenv()

import httpx

api_key = os.getenv("gemini_api_key", "")
base_url = os.getenv("gemini_base_url", "https://api.gemai.cc")
print(f"API Key: {api_key[:10]}...{api_key[-5:]}" if len(api_key) > 15 else f"API Key: {api_key}")
print(f"Base URL: {base_url}")

models_to_test = [
    "claude-sonnet-4-6",
    "deepseek-chat",
    "claude-sonnet-4-20250514",
    "gpt-4o-mini",
    "gpt-4o",
]

for model in models_to_test:
    try:
        url = f"{base_url.rstrip('/')}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a JSON API. Respond with ONLY valid JSON."},
                {"role": "user", "content": "Return exactly: {\\"status\\":\\"ok\\",\\"model\\":\\"" + model + "\\"}"}
            ],
            "max_tokens": 100,
            "temperature": 0
        }
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, json=payload, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                print(f"  {model}: OK -> {content[:100]}")
            else:
                print(f"  {model}: HTTP {resp.status_code} -> {resp.text[:200]}")
    except Exception as e:
        print(f"  {model}: ERROR -> {str(e)[:200]}")
'''

with paramiko.SFTPClient.from_transport(ssh.get_transport()) as sftp:
    with sftp.open("/tmp/_test_ai.py", "w") as f:
        f.write(test_script.encode("utf-8"))

out, err = r("cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 /tmp/_test_ai.py", 60)
print(out)
if err:
    print(f"STDERR: {err}")

# 3. Check backend logs for recent AI errors
print("\n=== Recent backend AI errors ===")
out, _ = r("grep -i 'ArticleGen\\|失败\\|error\\|模型.*失败' /home/admin/backend.log 2>/dev/null | tail -20")
print(out if out else "(no errors found)")

ssh.close()
print("\nDone!")
