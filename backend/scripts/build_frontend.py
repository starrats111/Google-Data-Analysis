import paramiko
import time

for attempt in range(5):
    try:
        print(f'Attempt {attempt+1}/5...')
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect('47.239.193.33', 22, 'admin', 'A123456',
                    timeout=30, banner_timeout=60, allow_agent=False, look_for_keys=False)
        print('Connected, starting build...')
        cmd = (
            "cd /home/admin/Google-Data-Analysis/frontend && "
            "export NODE_OPTIONS='--max-old-space-size=512' && "
            "GENERATE_SOURCEMAP=false npm run build 2>&1 | tail -25"
        )
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=300)
        out = stdout.read().decode(errors='replace').strip()
        err = stderr.read().decode(errors='replace').strip()
        ssh.close()
        print('OUTPUT:')
        print(out)
        if err:
            print('STDERR:')
            print(err[-500:])
        break
    except Exception as e:
        print(f'Failed: {e}')
        try:
            ssh.close()
        except:
            pass
        if attempt < 4:
            wait = 15 * (attempt + 1)
            print(f'Waiting {wait}s...')
            time.sleep(wait)
