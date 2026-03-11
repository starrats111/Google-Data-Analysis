"""Fix zontri article 9: add more affiliate links"""
import paramiko, sys, json
sys.stdout.reconfigure(encoding='utf-8')

BT_HOST = '52.74.221.116'
BT_USER = 'ubuntu'
BT_KEY = r'C:\Users\Administrator\Desktop\密钥\awssg0306.pem'

AFFILIATE_LINK = "https://linkhaitao.cn/index.php?mod=lhdeal&track=27780fE_bLnnIeS84tjeMrK_bpP3_aPlL_bo91KyjcsumjoTSs3pyqsGI7nxfyJTFZFCYrH31VUpn4ywLIQGmlX0&new=https%3A%2F%2Fwww.brooksbrothers.com%2F"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
pkey = paramiko.RSAKey.from_private_key_file(BT_KEY)
ssh.connect(BT_HOST, username=BT_USER, pkey=pkey, timeout=15)

sftp = ssh.open_sftp()

# Read article from both locations
for path in ['/www/wwwroot/zontri.top/js/articles/9.json', '/www/wwwroot/zontri.top/articles/the-quiet-art-of-a-well-made-shirt.json']:
    try:
        with sftp.open(path, 'r') as f:
            article = json.loads(f.read().decode('utf-8'))
        print(f"Read: {path}")
    except:
        print(f"Skip: {path}")
        continue

    content = article['content']
    
    # Replace the existing direct link with affiliate link
    content = content.replace(
        '<a href="https://www.brooksbrothers.com/" target="_blank" rel="noopener">Brooks Brothers</a>',
        f'<a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">Brooks Brothers</a>'
    )
    
    # Add more affiliate links naturally throughout the article
    # 1. In "The Collar Tells You Everything" section - after mentioning the striped oxford
    content = content.replace(
        "The collar had just enough structure to sit neatly under a blazer but relaxed enough to wear open on a Saturday. That balance is harder to find than you'd think.</p>",
        f'The collar had just enough structure to sit neatly under a blazer but relaxed enough to wear open on a Saturday. That balance is harder to find than you\'d think — though <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">Brooks Brothers\' oxford collection</a> comes remarkably close.</p>'
    )
    
    # 2. In "Fabric That Actually Breathes" section - after mentioning gingham
    content = content.replace(
        "I wore it untucked with jeans and it looked completely natural.</p>",
        f'I wore it untucked with jeans and it looked completely natural. If you\'re curious, <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">their gingham and check shirts</a> are a solid starting point.</p>'
    )
    
    # 3. In "The Details Nobody Notices" section - after mentioning buttons and stitching
    content = content.replace(
        "These aren't things you consciously check, but your hands know the difference.</p>",
        f'These aren\'t things you consciously check, but your hands know the difference. It\'s one reason heritage brands like <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">Brooks Brothers</a> still hold up — the details are baked into every piece.</p>'
    )
    
    # 4. In "When a Shirt Becomes a Uniform" section - after mentioning Thomas Mason fabric
    content = content.replace(
        "It's formal enough to respect the occasion but comfortable enough that you're not counting the hours until you can take it off.</p>",
        f'It\'s formal enough to respect the occasion but comfortable enough that you\'re not counting the hours until you can take it off. You can find shirts with exactly this kind of versatility in <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">their dress shirt lineup</a>.</p>'
    )
    
    # 5. In "Finding Your Shirt" section - before the final paragraph
    content = content.replace(
        "And if it passes all those tests, buy two — because the good ones have a way of becoming indispensable before you realize it.</p>",
        f'And if it passes all those tests, buy two — because the good ones have a way of becoming indispensable before you realize it. <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">Browse the full collection here</a> if you\'re ready to start looking.</p>'
    )
    
    article['content'] = content
    
    # Write back
    with sftp.open(path, 'w') as f:
        f.write(json.dumps(article, indent=2, ensure_ascii=False).encode('utf-8'))
    print(f"✓ Updated: {path}")

sftp.close()

# Verify
import re
def run(cmd, timeout=10):
    _, stdout, _ = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace').strip()

raw = run("cat /www/wwwroot/zontri.top/js/articles/9.json")
article = json.loads(raw)
links = re.findall(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>([^<]*)</a>', article['content'])
print(f"\n=== Verification: {len(links)} links ===")
for url, text in links:
    is_affiliate = 'linkhaitao' in url
    print(f"  {'✓' if is_affiliate else '✗'} [{text}] -> {'affiliate' if is_affiliate else url[:60]}")

ssh.close()
print("\nDone!")
