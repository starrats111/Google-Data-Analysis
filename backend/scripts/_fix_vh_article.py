"""Fix vitahaven article 7:
1. Add data.js to article.html
2. Fix script order (data.js first, then articles-index.js, then main.js)
3. Check and fix 7.json content and images
"""
import paramiko, sys, json, re
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sudo = "echo A123456 | sudo -S"
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

vh = "/www/wwwroot/vitahaven.click"
slug = "building-the-ultimate-home-gym-a-complete-guide-to-major-fitness-equipment"

# === Fix 1: Add data.js to article.html BEFORE articles-index.js ===
print("=== Fix article.html: add data.js ===")
# Check current state
current = r(f"grep -n '<script' {vh}/article.html")
print(f"Before: {current}")

# Insert data.js before articles-index.js
r(f"""{sudo} sed -i 's|<script src="js/articles-index.js|<script src="js/data.js"></script>\\n    <script src="js/articles-index.js|' {vh}/article.html""")

# Verify
after = r(f"grep -n '<script' {vh}/article.html")
print(f"After: {after}")

# === Fix 2: Fix 7.json - check content and images ===
print("\n=== Fix 7.json images ===")
raw = r(f"cat {vh}/js/articles/7.json")
data = json.loads(raw)

# Check what images exist
img_dir = f"{vh}/image/post-{slug}"
existing = r(f"ls {img_dir}/ 2>/dev/null").split('\n')
print(f"Existing images: {existing}")

# The hero image is from majorfitness.com CDN - it's an external URL
# Content images: content-2.jpg, content-3.png, content-4.jpg exist
# content-1 is missing (download failed)

# Fix the content to include all available images
content = data.get('content', '')
print(f"Current content length: {len(content)}")
print(f"Current img tags: {len(re.findall(r'<img', content))}")

# Check if hero image needs to be local
hero_img = data.get('image', '')
print(f"Hero image: {hero_img[:80]}")

# Fix: set hero to a working image path
# The hero image is an external URL from majorfitness.com - might be blocked
# Let's use content-2.jpg as hero since content-1 is missing
if 'hero' not in ' '.join(existing):
    print("No hero image found, using content-2 as hero")
    # Copy content-2 as hero
    r(f"{sudo} cp {img_dir}/content-2.jpg {img_dir}/hero.jpg 2>/dev/null")
    data['image'] = f"image/post-{slug}/hero.jpg"
    data['heroImage'] = f"image/post-{slug}/hero.jpg"

# Make sure content has all available images inserted
available_imgs = [f for f in existing if f.startswith('content-')]
print(f"Available content images: {available_imgs}")

# Check if content already has img tags for these
for img_file in available_imgs:
    img_path = f"image/post-{slug}/{img_file}"
    if img_path not in content:
        print(f"  Missing in content: {img_path}")

# Rebuild content with images properly inserted
# Find h2 positions in content
h2_positions = [m.start() for m in re.finditer(r'<h2|<h3', content)]
print(f"H2/H3 positions: {len(h2_positions)}")

# Insert missing images at h2 boundaries
img_paths = [f"image/post-{slug}/{f}" for f in sorted(available_imgs)]
existing_imgs_in_content = set(re.findall(r'image/post-[^"]+', content))
missing_imgs = [p for p in img_paths if p not in existing_imgs_in_content]

if missing_imgs:
    print(f"Inserting {len(missing_imgs)} missing images into content")
    # Insert at h2 boundaries
    if h2_positions and len(h2_positions) > 1:
        step = max(1, len(h2_positions) // (len(missing_imgs) + 1))
        for i, img_path in enumerate(missing_imgs):
            idx = min((i + 1) * step, len(h2_positions) - 1)
            pos = h2_positions[idx]
            img_tag = f'\n<div class="ab-page-hero-img"><img src="{img_path}" alt="Article illustration" loading="lazy" /></div>\n'
            content = content[:pos] + img_tag + content[pos:]
            # Recalculate positions after insertion
            h2_positions = [m.start() for m in re.finditer(r'<h2|<h3', content)]
    else:
        # Append at end
        for img_path in missing_imgs:
            content += f'\n<div class="ab-page-hero-img"><img src="{img_path}" alt="Article illustration" loading="lazy" /></div>\n'

data['content'] = content
print(f"Updated content length: {len(content)}")
print(f"Updated img tags: {len(re.findall(r'<img', content))}")

# Write updated 7.json
json_str = json.dumps(data, ensure_ascii=False, indent=2)
# Upload via sftp
import tempfile, os
tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False, encoding='utf-8')
tmp.write(json_str)
tmp.close()

sftp = bt.open_sftp()
sftp.put(tmp.name, f"{vh}/js/articles/7.json")
sftp.close()
os.unlink(tmp.name)
print("7.json updated!")

# === Fix 3: Also update articles-index.js hero image ===
print("\n=== Fix articles-index.js hero image ===")
idx_content = r(f"cat {vh}/js/articles-index.js")
if 'majorfitness.com' in idx_content:
    new_idx = idx_content.replace(
        "image: 'http://www.majorfitness.com/cdn/shop/files/8_8c9be44f-f078-4cd0-9d40-841e0b47311a.png?v=1771916851&width=940'",
        f"image: 'image/post-{slug}/hero.jpg'"
    )
    # Write back
    tmp2 = tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False, encoding='utf-8')
    tmp2.write(new_idx)
    tmp2.close()
    sftp = bt.open_sftp()
    sftp.put(tmp2.name, f"{vh}/js/articles-index.js")
    sftp.close()
    os.unlink(tmp2.name)
    print("articles-index.js hero image updated to local path")

# Verify
print("\n=== Verify ===")
print(r(f"grep -n '<script' {vh}/article.html"))
print(r(f"ls -la {img_dir}/"))
print(r(f"python3 -c \"import json; d=json.load(open('{vh}/js/articles/7.json')); print('imgs:', len(__import__('re').findall(r'<img', d.get('content',''))))\""))

bt.close()
print("\n✅ Done!")
