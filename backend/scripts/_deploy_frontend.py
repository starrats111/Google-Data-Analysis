"""Deploy frontend dist to server"""
import paramiko, sys, os
sys.stdout.reconfigure(encoding='utf-8')

BE_HOST = '47.239.193.33'
BE_USER = 'admin'
BE_PASS = 'A123456'
REMOTE_DIST = '/home/admin/Google-Data-Analysis/frontend/dist'
LOCAL_DIST = r'd:\Google Analysis\frontend\dist'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(BE_HOST, username=BE_USER, password=BE_PASS, timeout=30)
sftp = ssh.open_sftp()

def upload_dir(local_dir, remote_dir):
    """Recursively upload a directory"""
    count = 0
    for item in os.listdir(local_dir):
        local_path = os.path.join(local_dir, item)
        remote_path = f"{remote_dir}/{item}"
        if os.path.isfile(local_path):
            sftp.put(local_path, remote_path)
            count += 1
        elif os.path.isdir(local_path):
            try:
                sftp.stat(remote_path)
            except FileNotFoundError:
                sftp.mkdir(remote_path)
            count += upload_dir(local_path, remote_path)
    return count

# Upload index.html first
print("Uploading index.html...")
sftp.put(os.path.join(LOCAL_DIST, 'index.html'), f'{REMOTE_DIST}/index.html')

# Upload assets directory
print("Uploading assets/...")
try:
    sftp.stat(f'{REMOTE_DIST}/assets')
except FileNotFoundError:
    sftp.mkdir(f'{REMOTE_DIST}/assets')

count = upload_dir(os.path.join(LOCAL_DIST, 'assets'), f'{REMOTE_DIST}/assets')
print(f"✓ Uploaded {count} asset files")

# Upload _headers if exists
headers_path = os.path.join(LOCAL_DIST, '_headers')
if os.path.exists(headers_path):
    sftp.put(headers_path, f'{REMOTE_DIST}/_headers')
    print("✓ Uploaded _headers")

sftp.close()

# Verify
def run(cmd, timeout=10):
    _, o, _ = ssh.exec_command(cmd, timeout=timeout)
    return o.read().decode('utf-8', errors='replace').strip()

print(f"\n=== Verification ===")
print(f"Files: {run(f'ls {REMOTE_DIST}/ | wc -l')} items")
print(f"Assets: {run(f'ls {REMOTE_DIST}/assets/ | wc -l')} files")
print(f"index.html size: {run(f'wc -c < {REMOTE_DIST}/index.html')} bytes")

ssh.close()
print("\n✓ Frontend deployed!")
