"""Create .env file for CRM on the server"""
import paramiko

HOST = "47.239.193.33"
PORT = 22
USER = "admin"
PASS = "A123456"

ENV_CONTENT = """DATABASE_URL="mysql://crm:CrmPass2026!@localhost:3306/google-data-analysis"
SHADOW_DATABASE_URL="mysql://crm:CrmPass2026!@localhost:3306/google-data-analysis_shadow"
JWT_SECRET="NbegeUzQSbIHJ7CuJu2UWfnvjyz8kDgwrJLtXgD46Ei0T54i0VJL4Q4h2U9ryF-o"
REFRESH_SECRET="D8e-PpTmQBVYKnS2a2gmAosmba9-t9IdMhoclH4-ilskY1FSKOPdxOtOUW18ByiH"
NODE_ENV=production
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASS, timeout=10)

sftp = client.open_sftp()
with sftp.open('/home/admin/Google-Data-Analysis/crm-mvp/.env', 'w') as f:
    f.write(ENV_CONTENT)
sftp.close()

print("Created crm-mvp/.env")

stdin, stdout, stderr = client.exec_command(
    "cat ~/Google-Data-Analysis/crm-mvp/.env | head -3", timeout=10
)
print(stdout.read().decode())
client.close()
