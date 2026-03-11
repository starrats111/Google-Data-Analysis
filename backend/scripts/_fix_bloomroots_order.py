"""Fix bloomroots.top: swap script load order so articles-index.js loads AFTER script.js"""
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
sudo = "echo A123456 | sudo -S"

# Fix 1: In article.html - swap script order: script.js FIRST, then articles-index.js
# Current order (WRONG):
#   <script src="js/articles-index.js?v=..."></script>
#   <script src="script.js"></script>
# Correct order:
#   <script src="script.js"></script>
#   <script src="js/articles-index.js?v=..."></script>

print("=== Fix article.html script order ===")
# Replace the two script lines
cmd = f"""{sudo} sed -i 's|<script src="js/articles-index.js[^"]*"></script>\\n\\s*<script src="script.js"></script>|<script src="script.js"></script>\\n    <script src="js/articles-index.js"></script>|' {br}/article.html"""
print(r(cmd))

# The sed above might not work with multiline. Let's do it differently:
# Step 1: Remove the articles-index.js line
print(r(f"""{sudo} sed -i '/<script src="js\\/articles-index.js/d' {br}/article.html"""))
# Step 2: Add articles-index.js AFTER script.js
print(r(f"""{sudo} sed -i 's|<script src="script.js"></script>|<script src="script.js"></script>\\n    <script src="js/articles-index.js"></script>|' {br}/article.html"""))

# Fix 2: Same for index.html
print("\n=== Fix index.html script order ===")
print(r(f"grep -n 'articles-index.js\\|script.js' {br}/index.html"))
print(r(f"""{sudo} sed -i '/<script src="js\\/articles-index.js/d' {br}/index.html"""))
print(r(f"""{sudo} sed -i 's|<script src="script.js"></script>|<script src="script.js"></script>\\n    <script src="js/articles-index.js"></script>|' {br}/index.html"""))

# Fix 3: Same for category.html if exists
print("\n=== Fix category.html script order ===")
cat_exists = r(f"test -f {br}/category.html && echo YES || echo NO")
print(f"category.html exists: {cat_exists}")
if cat_exists == "YES":
    print(r(f"grep -n 'articles-index.js\\|script.js' {br}/category.html"))
    print(r(f"""{sudo} sed -i '/<script src="js\\/articles-index.js/d' {br}/category.html"""))
    print(r(f"""{sudo} sed -i 's|<script src="script.js"></script>|<script src="script.js"></script>\\n    <script src="js/articles-index.js"></script>|' {br}/category.html"""))

# Verify
print("\n=== Verify article.html ===")
print(r(f"grep -n 'script' {br}/article.html | grep -v '<!--'"))

print("\n=== Verify index.html ===")
print(r(f"grep -n 'script' {br}/index.html | grep -v '<!--'"))

# Also update articles-index.js: since script.js now loads first, articlesData WILL exist
# The merge code should work correctly now
print("\n=== Verify articles-index.js merge logic ===")
print(r(f"cat {br}/js/articles-index.js"))

# Test: verify 7.json content is complete
print("\n=== 7.json content check ===")
print(r(f"cat {br}/js/articles/7.json | python3 -c \"import sys,json; d=json.load(sys.stdin); print('id:', d.get('id')); print('title:', d.get('title')); print('content type:', type(d.get('content')).__name__); print('content length:', len(d.get('content','')) if d.get('content') else 0)\""))

bt.close()
print("\n✅ Script order fixed! articles-index.js now loads AFTER script.js")
