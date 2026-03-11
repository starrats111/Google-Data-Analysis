"""Fix article 9: add remaining affiliate links with correct unicode chars"""
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

for path in ['/www/wwwroot/zontri.top/js/articles/9.json', '/www/wwwroot/zontri.top/articles/the-quiet-art-of-a-well-made-shirt.json']:
    try:
        with sftp.open(path, 'r') as f:
            article = json.loads(f.read().decode('utf-8'))
    except:
        continue

    content = article['content']
    
    # Use the actual unicode curly quote \u2019 (right single quotation mark)
    rq = '\u2019'  # '
    
    # 1. Collar section - after "harder to find than you'd think"
    old1 = f"That balance is harder to find than you{rq}d think.</p>"
    new1 = f'That balance is harder to find than you{rq}d think \u2014 though <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">Brooks Brothers{rq} oxford collection</a> comes remarkably close.</p>'
    if old1 in content:
        content = content.replace(old1, new1)
        print(f"  \u2713 Replaced: collar section")
    else:
        print(f"  \u2717 Not found: collar section")
    
    # 2. Details section - after "your hands know the difference"
    old2 = f"These aren{rq}t things you consciously check, but your hands know the difference.</p>"
    new2 = f'These aren{rq}t things you consciously check, but your hands know the difference. It{rq}s one reason heritage brands like <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">Brooks Brothers</a> still hold up \u2014 the details are baked into every piece.</p>'
    if old2 in content:
        content = content.replace(old2, new2)
        print(f"  \u2713 Replaced: details section")
    else:
        print(f"  \u2717 Not found: details section")
    
    # 3. Uniform section - after "not counting the hours"
    old3 = f"It{rq}s formal enough to respect the occasion but comfortable enough that you{rq}re not counting the hours until you can take it off.</p>"
    new3 = f'It{rq}s formal enough to respect the occasion but comfortable enough that you{rq}re not counting the hours until you can take it off. You can find shirts with exactly this kind of versatility in <a href="{AFFILIATE_LINK}" target="_blank" rel="noopener">their dress shirt lineup</a>.</p>'
    if old3 in content:
        content = content.replace(old3, new3)
        print(f"  \u2713 Replaced: uniform section")
    else:
        print(f"  \u2717 Not found: uniform section")
    
    article['content'] = content
    
    with sftp.open(path, 'w') as f:
        f.write(json.dumps(article, indent=2, ensure_ascii=False).encode('utf-8'))
    print(f"\u2713 Saved: {path}")

sftp.close()

# Final verification
import re
def run(cmd, timeout=10):
    _, stdout, _ = ssh.exec_command(cmd, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace').strip()

raw = run("cat /www/wwwroot/zontri.top/js/articles/9.json")
article = json.loads(raw)
links = re.findall(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>([^<]*)</a>', article['content'])
print(f"\n=== Final: {len(links)} links ===")
for url, text in links:
    is_aff = 'linkhaitao' in url
    print(f"  {'✓' if is_aff else '✗'} [{text}]")

ssh.close()
print("\nDone!")
