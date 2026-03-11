"""Fix zontri.top: Add article 9 to articlesIndex on server"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
BT_KEY = r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=15)

sftp = ssh.open_sftp()

# Read current articles-index.js
with sftp.open('/www/wwwroot/zontri.top/js/articles-index.js', 'r') as f:
    content = f.read().decode('utf-8')

print(f"Current file size: {len(content)} bytes")

# Check if article 9 already exists
if "'the-quiet-art-of-a-well-made-shirt'" in content or '"the-quiet-art-of-a-well-made-shirt"' in content:
    print("Article 9 already in index!")
else:
    print("Adding article 9...")
    
    # New entry to add (matching the format: var articlesIndex = [...])
    new_entry = """  {
    id: 9,
    slug: 'the-quiet-art-of-a-well-made-shirt',
    title: 'The Quiet Art of a Well-Made Shirt',
    category: 'fashion',
    categoryName: 'Fashion & Accessories',
    date: '2026-03-09',
    image: 'image/article-9/hero.png',
    excerpt: "There's something about a shirt that fits just right \\u2014 the collar sits where it should, the fabric moves with you, and you stop thinking about what you're wearing entirely.",
    hasProducts: false,
  }"""
    
    # Find "var articlesIndex = [" and insert after the opening bracket
    marker = "var articlesIndex = ["
    idx = content.find(marker)
    if idx == -1:
        print("ERROR: Could not find 'var articlesIndex = ['")
    else:
        insert_pos = idx + len(marker)
        # Insert the new entry right after the opening bracket
        new_content = content[:insert_pos] + "\n" + new_entry + "," + content[insert_pos:]
        
        # Write back
        with sftp.open('/www/wwwroot/zontri.top/js/articles-index.js', 'w') as f:
            f.write(new_content.encode('utf-8'))
        
        print(f"✓ Added article 9 to articlesIndex")
        print(f"New file size: {len(new_content)} bytes")

sftp.close()

# Verify
def run(cmd, timeout=10):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace').strip()

print("\n=== Verification ===")
result = run("grep -c 'quiet-art\\|well-made-shirt' /www/wwwroot/zontri.top/js/articles-index.js")
print(f"Matches found: {result}")

# Show the first few entries
print("\n=== First entries in articlesIndex ===")
print(run("head -30 /www/wwwroot/zontri.top/js/articles-index.js"))

ssh.close()
print("\nDone!")
