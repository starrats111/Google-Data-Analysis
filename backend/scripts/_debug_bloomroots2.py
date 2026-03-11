"""Check loadArticleContent function and titleToSlug matching"""
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

# 1. Full loadArticleContent function
print("=== loadArticleContent FULL ===")
print(r(f"sed -n '/^function loadArticleContent/,/^function /p' {br}/script.js"))

# 2. Check titleToSlug output for the article title
# The title has a colon: "No Palm Oil or Soy: Choosing Purer Organic Nutrition for Your Baby"
# titleToSlug removes special chars except hyphens, so colon is removed
# Result: "no-palm-oil-or-soy-choosing-purer-organic-nutrition-for-your-baby"
# The URL param is: "no-palm-oil-or-soy-choosing-purer-organic-nutrition-for-your-baby"
# These should match!

# 3. Check if the merge code actually runs - does articlesData have id:7 after merge?
print("\n=== Check articlesData merge ===")
# articles-index.js loads BEFORE script.js, so articlesData should be undefined when articles-index.js runs
# Then script.js defines var articlesData = [...] which OVERWRITES the fallback var articlesData = articlesIndex
# THIS IS THE BUG! script.js's var articlesData = [...] overwrites the merged data!

# Let's verify the load order
print(r(f"grep -n 'articles-index.js\\|script.js' {br}/article.html"))

# 4. Check script.js line count and the var articlesData declaration
print("\n=== script.js articlesData declaration ===")
print(r(f"grep -n 'articlesData' {br}/script.js | head -20"))

# 5. Full script.js line count
print(f"\n=== script.js total lines: {r(f'wc -l {br}/script.js')} ===")

# 6. Check if there's a fetch fallback in loadArticleContent
print("\n=== fetch in script.js ===")
print(r(f"grep -n 'fetch\\|json\\|JSON' {br}/script.js | head -20"))

bt.close()
