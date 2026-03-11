import paramiko
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('47.239.193.33', port=22, username='admin', password='A123456', timeout=15)

# 1. Check articles-index.js for this article
print("=== articles-index.js entries ===")
stdin, stdout, stderr = ssh.exec_command(
    "grep -i '1st.phorm\\|protein.powder\\|why-choose' /www/wwwroot/zontri.top/js/articles-index.js"
)
print(stdout.read().decode()[:2000])

# 2. Find the article JSON file
print("\n=== Find article JSON ===")
stdin, stdout, stderr = ssh.exec_command(
    "grep -rl '1st.phorm\\|1stphorm\\|protein.powder' /www/wwwroot/zontri.top/js/articles/ 2>/dev/null | head -5"
)
files = stdout.read().decode().strip()
print(f"Files: {files}")

if files:
    for f in files.split('\n'):
        f = f.strip()
        if not f:
            continue
        print(f"\n=== Content of {f} ===")
        stdin, stdout, stderr = ssh.exec_command(f"cat {f}")
        content = stdout.read().decode()
        try:
            data = json.loads(content)
            print(f"ID: {data.get('id')}")
            print(f"Title: {data.get('title')}")
            print(f"Slug: {data.get('slug')}")
            print(f"Category: {data.get('category')}")
            print(f"Date: {data.get('date')}")
            
            # Check content
            html = data.get('content', '')
            print(f"Content length: {len(html)} chars")
            
            # Count links
            import re
            links = re.findall(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>', html)
            print(f"Total <a> links: {len(links)}")
            for i, link in enumerate(links):
                print(f"  Link {i+1}: {link[:120]}")
            
            # Check for tracking links
            tracking = [l for l in links if 'linkhaitao' in l or 'track' in l.lower()]
            print(f"Tracking/affiliate links: {len(tracking)}")
            
            # Show first 800 chars of content
            print(f"\nContent preview:\n{html[:800]}")
            print(f"\n... (truncated) ...\n")
            print(f"Content end:\n{html[-500:]}")
        except json.JSONDecodeError:
            print(f"Raw content (first 500): {content[:500]}")
else:
    # Try listing all articles
    print("\n=== All article files ===")
    stdin, stdout, stderr = ssh.exec_command("ls -la /www/wwwroot/zontri.top/js/articles/")
    print(stdout.read().decode())
    
    # Search in index
    print("\n=== Full index search ===")
    stdin, stdout, stderr = ssh.exec_command("cat /www/wwwroot/zontri.top/js/articles-index.js | head -100")
    print(stdout.read().decode()[:3000])

ssh.close()
