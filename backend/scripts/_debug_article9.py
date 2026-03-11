"""Debug which replacements failed"""
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
with sftp.open('/www/wwwroot/zontri.top/js/articles/9.json', 'r') as f:
    article = json.loads(f.read().decode('utf-8'))

content = article['content']

# Check which target strings exist
targets = [
    "That balance is harder to find than you'd think",
    "That balance is harder to find than you\\'d think",
    "That balance is harder to find than you\\u2019d think",
    "These aren't things you consciously check",
    "These aren\\'t things you consciously check",  
    "These aren\\u2019t things you consciously check",
    "It's formal enough to respect the occasion",
    "It\\u2019s formal enough to respect the occasion",
]

for t in targets:
    found = t in content
    print(f"{'✓' if found else '✗'} '{t[:60]}...'")

# Show the actual characters around key phrases
import re
for phrase in ["balance is harder", "consciously check", "formal enough"]:
    idx = content.find(phrase)
    if idx >= 0:
        snippet = content[max(0,idx-30):idx+80]
        print(f"\nContext for '{phrase}':")
        print(f"  ...{repr(snippet)}...")

sftp.close()
ssh.close()
