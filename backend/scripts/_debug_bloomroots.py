"""Deep debug bloomroots article page loading"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

br = "/www/wwwroot/bloomroots.top"

# 1. article.html full content
print("=== 1. article.html FULL ===")
print(r(f"cat {br}/article.html"))

# 2. articles-index.js full content
print("\n=== 2. articles-index.js FULL ===")
print(r(f"cat {br}/js/articles-index.js"))

# 3. script.js first 30 lines (check articlesData)
print("\n=== 3. script.js first 30 lines ===")
print(r(f"head -30 {br}/script.js"))

# 4. script.js: initPage / loadArticleByTitle function
print("\n=== 4. script.js: initPage + loadArticleByTitle ===")
print(r(f"sed -n '/function initPage/,/^function /p' {br}/script.js | head -30"))
print("---")
print(r(f"sed -n '/function loadArticleByTitle/,/^function /p' {br}/script.js | head -50"))

# 5. Check if article slug matches
slug = "no-palm-oil-or-soy-choosing-purer-organic-nutrition-for-your-baby"
print(f"\n=== 5. Search for slug in script.js ===")
print(r(f"grep -n '{slug}' {br}/script.js | head -5"))
print(r(f"grep -n '{slug}' {br}/js/articles-index.js | head -5"))

# 6. Check titleToSlug function
print("\n=== 6. titleToSlug function ===")
print(r(f"sed -n '/function titleToSlug/,/^}}/p' {br}/script.js"))

# 7. js/articles/7.json exists?
print("\n=== 7. js/articles/7.json ===")
print(r(f"head -c 500 {br}/js/articles/7.json 2>/dev/null || echo 'NOT FOUND'"))

# 8. Check DOMContentLoaded
print("\n=== 8. DOMContentLoaded ===")
print(r(f"grep -n 'DOMContentLoaded\\|initPage\\|loadArticle' {br}/script.js | head -10"))

bt.close()
