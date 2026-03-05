"""测试新 API Key 对 Claude 模型的访问"""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

test_script = '''
cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python3 -c "
import anthropic

api_key = 'sk-GnyqfCWVSvemBuu0wobhFBBPEmX8f6lmy7Rki2BuUEqp9yMC'
base_url = 'https://api.gemai.cc'

client = anthropic.Anthropic(api_key=api_key, base_url=base_url)

models = [
    '[特价B]claude-sonnet-4-20250514',
    '[特价B]claude-opus-4-5-20251101',
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307',
]

for model in models:
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=10,
            messages=[{'role': 'user', 'content': 'Say OK'}]
        )
        print(f'OK: {model} -> {resp.content[0].text[:30]}')
    except Exception as e:
        err = str(e)[:100]
        print(f'FAIL: {model} -> {err}')
"
'''

stdin, stdout, stderr = ssh.exec_command(test_script, timeout=120)
print(stdout.read().decode())
err = stderr.read().decode()
if err.strip():
    print("[stderr]", err[-300:])

ssh.close()
