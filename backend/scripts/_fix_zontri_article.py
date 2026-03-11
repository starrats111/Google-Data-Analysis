"""Fix zontri.top: Add missing article to articles-index.js"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
BT_KEY = r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=15)

def run(cmd, timeout=10):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    o = stdout.read().decode('utf-8', errors='replace').strip()
    e = stderr.read().decode('utf-8', errors='replace').strip()
    if e and 'warning' not in e.lower(): print(f'ERR: {e[:500]}')
    return o

# Step 1: Read the article JSON to get metadata
print("=== Reading article JSON ===")
article_json = run("cat /www/wwwroot/zontri.top/js/articles/9.json")
article = json.loads(article_json)
print(f"Article: {article['title']} (id={article['id']}, slug={article['slug']})")

# Step 2: Read current articles-index.js
print("\n=== Reading current articles-index.js ===")
index_content = run("cat /www/wwwroot/zontri.top/js/articles-index.js")

# Step 3: Check if article 9 already exists
if '"id": 9' in index_content or '"id":9' in index_content:
    print("Article 9 already in index!")
else:
    print("Article 9 NOT in index, adding it...")
    
    # Build the new entry
    new_entry = {
        "id": article["id"],
        "title": article["title"],
        "slug": article["slug"],
        "category": article["category"],
        "date": article["date"],
        "excerpt": article["excerpt"],
        "image": article["image"],
        "featured": True,
        "hasProducts": bool(article.get("products"))
    }
    new_entry_json = json.dumps(new_entry, indent=2, ensure_ascii=False)
    
    # Insert before the closing ]; of articlesIndex
    # Find the position to insert (before the last ] in articlesIndex array)
    
    # Also need to add to the data.js-compatible articles array
    # The server uses articles-index.js which has articlesIndex AND a compat line
    
    # Read and modify
    # Find "const articlesIndex = [" ... "];" and add entry before "];"
    
    # Strategy: use sed to insert before the first "];" after articlesIndex
    # But safer to use Python SFTP
    
    sftp = ssh.open_sftp()
    
    # Read the file
    with sftp.open('/www/wwwroot/zontri.top/js/articles-index.js', 'r') as f:
        content = f.read().decode('utf-8')
    
    # Find the articlesIndex array closing
    # The array ends with "];" before products or other data
    # We need to insert the new entry before the "];" that closes articlesIndex
    
    # Parse: find "const articlesIndex = [" and its matching "];"
    idx_start = content.find('const articlesIndex = [')
    if idx_start == -1:
        print("ERROR: Could not find articlesIndex in file")
    else:
        # Find the matching ]; 
        # Simple approach: find the first "];" after the array starts
        bracket_pos = content.find('];', idx_start)
        if bracket_pos == -1:
            print("ERROR: Could not find closing ]; for articlesIndex")
        else:
            # Insert new entry before ];
            insert_text = f',\n  {json.dumps(new_entry, ensure_ascii=False)}\n'
            new_content = content[:bracket_pos] + insert_text + content[bracket_pos:]
            
            # Write back
            with sftp.open('/www/wwwroot/zontri.top/js/articles-index.js', 'w') as f:
                f.write(new_content.encode('utf-8'))
            
            print(f"✓ Added article {article['id']} to articlesIndex")
    
    sftp.close()

# Step 4: Also check if data.js needs updating (it has "const articles = articlesIndex;")
print("\n=== Checking data.js ===")
data_js = run("tail -5 /www/wwwroot/zontri.top/js/data.js")
print(data_js)

# Step 5: Verify
print("\n=== Verifying ===")
verify = run("grep 'quiet\\|well-made\\|shirt.*art' /www/wwwroot/zontri.top/js/articles-index.js | head -5")
print(verify if verify else "Not found in articles-index.js after update!")

# Also check if data.js is separate or same as articles-index.js
print("\n=== data.js structure ===")
print(run("head -5 /www/wwwroot/zontri.top/js/data.js"))
print("...")
print(run("grep 'articlesIndex\\|const articles' /www/wwwroot/zontri.top/js/data.js"))

ssh.close()
print("\nDone!")
