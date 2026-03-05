"""测试 Claude API Key 可用的模型"""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

test_script = '''
cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "
import anthropic
import os, sys
sys.path.insert(0, '.')
from app.config import settings

api_key = settings.CLAUDE_API_KEY
base_url = settings.CLAUDE_BASE_URL

print(f'API Key: {api_key[:10]}...{api_key[-4:]}')
print(f'Base URL: {base_url}')
print()

client = anthropic.Anthropic(api_key=api_key, base_url=base_url)

models_to_test = [
    '[特价B]claude-sonnet-4-20250514',
    '[特价B]claude-opus-4-5-20251101',
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-sonnet-4-20250514',
    'claude-3-haiku-20240307',
]

for model in models_to_test:
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=10,
            messages=[{'role': 'user', 'content': 'Hi'}]
        )
        print(f'OK: {model} -> {resp.content[0].text[:20]}')
    except Exception as e:
        err = str(e)[:80]
        print(f'FAIL: {model} -> {err}')
"
'''

stdin, stdout, stderr = ssh.exec_command(test_script, timeout=120)
print(stdout.read().decode())
err = stderr.read().decode()
if err.strip():
    print("[stderr]", err[-500:])

ssh.close()
