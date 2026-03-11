import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.239.193.33", username="admin", password="A123456", timeout=10)

def run(cmd, timeout=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace')

PROJECT = "/home/admin/Google-Data-Analysis"

# 1. Kill any running resync processes first
print("=== Cleaning up ===")
run("kill $(ps aux | grep full_resync | grep -v grep | awk '{print $2}') 2>/dev/null")

# 2. Pull latest code
print("=== Pulling code ===")
out, _ = run(f"cd {PROJECT} && git fetch origin && git reset --hard origin/main 2>&1")
print(out[-500:])

# 3. Verify the fix is present
print("\n=== Verify _extract_jsonld_images exists ===")
out, _ = run(f"grep -c '_extract_jsonld_images' {PROJECT}/backend/app/services/merchant_crawler.py")
print(f"Occurrences: {out.strip()}")

out, _ = run(f"grep -c '_JS_IMG_RE' {PROJECT}/backend/app/services/merchant_crawler.py")
print(f"JS IMG RE: {out.strip()}")

out, _ = run(f"grep '_applyCrawlImages' {PROJECT}/frontend/src/components/PublishWizard/index.jsx | head -3")
print(f"Frontend fix: {out.strip()}")

# 4. Restart backend
print("\n=== Restarting backend ===")
run("pkill -9 -f uvicorn 2>/dev/null; sleep 2; fuser -k 8000/tcp 2>/dev/null; sleep 2")
channel = ssh.get_transport().open_session()
channel.exec_command(f"cd {PROJECT}/backend && source venv/bin/activate && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /home/admin/backend.log 2>&1 &")
time.sleep(6)
out, _ = run("curl -s http://localhost:8000/health")
print(f"Health: {out}")

# 5. Test crawl with a sample URL
print("\n=== Test crawl ===")
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.services.merchant_crawler import crawl
result = crawl('https://www.nasm.org')
print('Failed:', result.get('crawl_failed'))
print('Brand:', result.get('brand_name'))
total = sum(len(p.get('images',[])) for p in result.get('pages',[]))
print('Total images:', total)
if total > 0:
    for p in result.get('pages',[]):
        for img in p.get('images',[])[:3]:
            print(' ', img[:80])
" 2>&1""", timeout=60)
print(out)

# 6. Test Pexels fallback
print("=== Test Pexels fallback ===")
out, _ = run(f"""cd {PROJECT}/backend && source venv/bin/activate && python3 -c "
from app.services.merchant_crawler import search_images
imgs = search_images('luxury travel products official', count=8)
print('Pexels results:', len(imgs))
for img in imgs[:3]:
    print(' ', img[:80])
" 2>&1""", timeout=30)
print(out)

ssh.close()
print("\nDone!")
