"""Verify AI service is working after fix"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', 22, 'admin', password='A123456', timeout=15)

def r(cmd, t=60):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return (
        stdout.read().decode('utf-8', errors='replace').strip(),
        stderr.read().decode('utf-8', errors='replace').strip()
    )

BACKEND = "/home/admin/Google-Data-Analysis/backend"

# Test 1: Health check
print("=== Test 1: Health check ===")
out, _ = r("curl -s http://localhost:8000/health")
print(f"Health: {out}")

# Test 2: Test analyze_merchant via API
print("\n=== Test 2: Test AI analyze_merchant ===")
test_cmd = f"""cd {BACKEND} && source venv/bin/activate && python3 -c "
import sys, json; sys.path.insert(0, '.')
from app.services.article_gen_service import ArticleGenService

svc = ArticleGenService()

# Simulate crawl data
crawl_data = {{
    'brand_name': 'Nike',
    'raw_text': 'Nike. Just Do It. Nike delivers innovative products, experiences and services to inspire athletes. Free shipping on orders over 50 dollars. Shop for shoes, clothing and accessories. Nike Air Max, Nike Dunk, Nike Jordan. Running shoes, basketball shoes, lifestyle sneakers. Men, Women, Kids collections.',
}}

print('Calling analyze_merchant...')
result = svc.analyze_merchant(crawl_data, 'en')
print(f'Category: {{result.get(\"category\", \"MISSING\")}}')
print(f'Products: {{result.get(\"products\", [])}}')
print(f'Selling points: {{result.get(\"selling_points\", [])}}')
print(f'Titles count: {{len(result.get(\"titles\", []))}}')
titles = result.get('titles', [])
for i, t in enumerate(titles[:3]):
    print(f'  Title {{i+1}}: {{t}}')
print(f'Keywords: {{result.get(\"keywords\", [])}}')

# Check if it's placeholder data
if titles and titles[0].get('title_en', '').startswith('Title '):
    print('WARNING: Still returning placeholder titles!')
else:
    print('SUCCESS: Real AI-generated titles!')
" 2>&1
"""
out, err = r(test_cmd, 90)
print(out)
if err:
    print(f"STDERR: {err[:500]}")

# Test 3: Verify PubSite records via API
print("\n=== Test 3: PubSite records ===")
out, _ = r(f"""cd {BACKEND} && source venv/bin/activate && python3 -c "
import sys; sys.path.insert(0, '.')
from app.database import SessionLocal
from app.models.site import PubSite
db = SessionLocal()
sites = db.query(PubSite).all()
print(f'Total: {{len(sites)}} sites')
for s in sites:
    print(f'  {{s.domain}} | {{s.site_type}} | {{s.article_html_pattern}}')
db.close()
" """, 15)
print(out)

ssh.close()
print("\nDone.")
