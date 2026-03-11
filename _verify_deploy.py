import paramiko
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

checks = [
    ("article_gen_service.py - new prompt", "grep -c 'AUTHENTICITY FIRST' /home/admin/Google-Data-Analysis/backend/app/services/article_gen_service.py"),
    ("article_gen_service.py - link postprocess", "grep -c '_ensure_link_count' /home/admin/Google-Data-Analysis/backend/app/services/article_gen_service.py"),
    ("merchant_crawler.py - stealth headers", "grep -c '_build_stealth_headers' /home/admin/Google-Data-Analysis/backend/app/services/merchant_crawler.py"),
    ("merchant_crawler.py - GA cookies", "grep -c '_generate_ga_cookies' /home/admin/Google-Data-Analysis/backend/app/services/merchant_crawler.py"),
    ("humanizer_service.py - paragraph diversity", "grep -c '_diversify_paragraph_starts' /home/admin/Google-Data-Analysis/backend/app/services/humanizer_service.py"),
    ("humanizer_service.py - transition control", "grep -c '_control_transition_density' /home/admin/Google-Data-Analysis/backend/app/services/humanizer_service.py"),
]

all_ok = True
for label, cmd in checks:
    stdin, stdout, stderr = ssh.exec_command(cmd)
    count = stdout.read().decode().strip()
    ok = count != '0'
    if not ok:
        all_ok = False
    print(f"  [{('OK' if ok else 'FAIL')}] {label}: {count}")

print()
stdin, stdout, stderr = ssh.exec_command("ls -la /home/admin/Google-Data-Analysis/frontend/dist/index.html 2>/dev/null")
print("Frontend dist:", stdout.read().decode().strip())

stdin, stdout, stderr = ssh.exec_command("ls /home/admin/Google-Data-Analysis/frontend/dist/assets/ 2>/dev/null | wc -l")
print("Frontend assets count:", stdout.read().decode().strip())

print()
stdin, stdout, stderr = ssh.exec_command("tail -5 /home/admin/backend.log")
print("Backend log (last 5 lines):")
print(stdout.read().decode()[-400:])

print()
print("ALL CHECKS PASSED!" if all_ok else "SOME CHECKS FAILED!")

ssh.close()
