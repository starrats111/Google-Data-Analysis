"""Verify AI service - write test script to server first"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', password='A123456', timeout=15)
sftp = ssh.open_sftp()

BACKEND = "/home/admin/Google-Data-Analysis/backend"

def r(cmd, t=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return (
        stdout.read().decode('utf-8', errors='replace').strip(),
        stderr.read().decode('utf-8', errors='replace').strip()
    )

# Write test script to server
test_script = '''import sys, json
sys.path.insert(0, ".")
from app.services.article_gen_service import ArticleGenService

svc = ArticleGenService()

crawl_data = {
    "brand_name": "Nike",
    "raw_text": "Nike. Just Do It. Nike delivers innovative products, experiences and services to inspire athletes. Free shipping on orders over 50 dollars. Shop for shoes, clothing and accessories. Nike Air Max, Nike Dunk, Nike Jordan. Running shoes, basketball shoes, lifestyle sneakers. Men, Women, Kids collections.",
}

print("Calling analyze_merchant...")
result = svc.analyze_merchant(crawl_data, "en")
print("Category:", result.get("category", "MISSING"))
print("Products:", result.get("products", []))
print("Selling points:", result.get("selling_points", []))

titles = result.get("titles", [])
print("Titles count:", len(titles))
for i, t in enumerate(titles[:3]):
    print(f"  Title {i+1}: {t}")
print("Keywords:", result.get("keywords", []))

if titles and titles[0].get("title_en", "").startswith("Title "):
    print("\\nWARNING: Still returning placeholder titles!")
else:
    print("\\nSUCCESS: Real AI-generated titles!")
'''

with sftp.open("/tmp/_test_ai.py", "w") as f:
    f.write(test_script.encode("utf-8"))

print("=== Test 1: Health check ===")
out, _ = r("curl -s http://localhost:8000/health")
print(f"Health: {out}")

print("\n=== Test 2: AI analyze_merchant ===")
out, err = r(f"cd {BACKEND} && source venv/bin/activate && python3 /tmp/_test_ai.py 2>&1", 90)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

sftp.close()
ssh.close()
print("\nDone.")
