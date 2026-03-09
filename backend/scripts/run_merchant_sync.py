import paramiko, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', 'A123456', timeout=15)

# Run merchant sync via Python directly on server
sync_script = """
import sys
sys.path.insert(0, '/home/admin/Google-Data-Analysis/backend')
from app.database import SessionLocal
from app.services.merchant_platform_sync import MerchantPlatformSyncService

db = SessionLocal()
svc = MerchantPlatformSyncService(db)
print("Starting full merchant sync...")
result = svc.sync_all()
print(f"Result: {result}")
db.close()
"""

# Write temp script
sftp = ssh.open_sftp()
with sftp.open('/tmp/run_merchant_sync.py', 'w') as f:
    f.write(sync_script)
sftp.close()

print('Running full merchant sync (this may take a few minutes)...')
cmd = 'cd /home/admin/Google-Data-Analysis/backend && source venv/bin/activate && python /tmp/run_merchant_sync.py 2>&1'
i, o, e = ssh.exec_command(cmd, timeout=300)
output = o.read().decode()
print(output[-3000:] if len(output) > 3000 else output)

ssh.close()
print('Done')
