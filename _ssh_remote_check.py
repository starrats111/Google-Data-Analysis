import paramiko
import sys

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

commands = [
    ('1. alembic directory', 'ls -la /home/admin/Google-Data-Analysis/backend/alembic/ 2>/dev/null || echo "alembic dir not found"'),
    ('2. alembic.ini', 'ls -la /home/admin/Google-Data-Analysis/backend/alembic.ini 2>/dev/null || echo "alembic.ini not found"'),
    ('3. gspread deps in requirements.txt', "grep -i -E 'gspread|google-auth|google-api' /home/admin/Google-Data-Analysis/backend/requirements.txt 2>/dev/null || echo 'not found'"),
    ('4. users table team_id', 'sqlite3 /home/admin/Google-Data-Analysis/backend/google_analysis.db "SELECT id, username, team_id FROM users LIMIT 20;"'),
    ('5. NULL team_id count', 'sqlite3 /home/admin/Google-Data-Analysis/backend/google_analysis.db "SELECT COUNT(*) FROM users WHERE team_id IS NULL;"'),
    ('6. google_mcc_accounts schema', 'sqlite3 /home/admin/Google-Data-Analysis/backend/google_analysis.db ".schema google_mcc_accounts"'),
    ('7. 429 error count', 'grep -c "429" /home/admin/backend.log 2>/dev/null || echo "0"'),
    ('8. disk and memory', 'df -h / && free -m'),
    ('9. backend process', 'ps aux | grep uvicorn | grep -v grep'),
    ('10. db backup files', 'ls -lh /home/admin/Google-Data-Analysis/backend/*.db*'),
]

for title, cmd in commands:
    print('=' * 60)
    print('>>> ' + title)
    print('=' * 60)
    stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    if out.strip():
        print(out)
    if err.strip():
        print('[STDERR] ' + err)
    print()

client.close()
print('=== ALL DONE ===')
