"""Final verification: check REAL cross-file conflicts only"""
import paramiko, sys, re
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

SPA_SITES = ["vitahaven.click", "zontri.top", "vitasphere.top", "everydayhaven.top",
             "bloomroots.top", "quiblo.top", "allurahub.top", "mevora.top"]

issues = []

for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    
    # Get script files from article.html
    scripts_raw = r(f"grep -o 'src=\"[^\"]*\\.js[^\"]*\"' {root}/article.html 2>/dev/null")
    if not scripts_raw:
        continue
    
    script_files = [s.replace('src="', '').replace('"', '').split('?')[0] for s in scripts_raw.split('\n') if s]
    
    # For each file, get TOP-LEVEL const/let declarations only
    # Top-level = not indented (starts at column 0)
    file_top_vars = {}
    for sf in script_files:
        sf_path = f"{root}/{sf}"
        # Get lines that start with const/let/var at column 0
        out = r(f"grep -n '^const \\|^let \\|^var ' {sf_path} 2>/dev/null")
        if out:
            for line in out.split('\n'):
                # Extract variable name
                m = re.match(r'\d+:(const|let|var)\s+(\w+)', line.strip())
                if m:
                    kw, vname = m.group(1), m.group(2)
                    if vname not in file_top_vars:
                        file_top_vars[vname] = []
                    file_top_vars[vname].append((sf, kw))
    
    # Find cross-file conflicts
    for vname, sources in file_top_vars.items():
        unique_files = set(f for f, _ in sources)
        if len(unique_files) > 1:
            # Real cross-file conflict
            has_const_or_let = any(kw in ('const', 'let') for _, kw in sources)
            if has_const_or_let:
                issue = f"{domain}: '{vname}' - {', '.join(f'{kw} in {f}' for f, kw in sources)}"
                issues.append(issue)

# Check articles-index.js declarations
print("--- articles-index.js declaration check ---")
for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    out = r(f"head -5 {root}/js/articles-index.js 2>/dev/null | grep 'articlesIndex'")
    if out:
        if "const " in out:
            issues.append(f"{domain}: articles-index.js still uses const")
            print(f"  ⚠️ {domain}: {out.strip()}")
        else:
            print(f"  ✓ {domain}: {out.strip()}")

# Check merge code
print("\n--- merge code check ---")
for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    out = r(f"grep -c 'forEach' {root}/js/articles-index.js 2>/dev/null")
    has_merge = int(out) > 0 if out and out.isdigit() else False
    if not has_merge:
        issues.append(f"{domain}: merge code missing")
    print(f"  {'✓' if has_merge else '⚠️'} {domain}: merge={'YES' if has_merge else 'NO'}")

# Check JSON fetch fallback
print("\n--- JSON fetch fallback check ---")
for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    has_fetch = False
    for jsf in ["js/main.js", "js/article.js", "script.js"]:
        out = r(f"grep -c 'fetch.*articles.*json' {root}/{jsf} 2>/dev/null")
        if out and int(out) > 0:
            has_fetch = True
            break
    if not has_fetch:
        issues.append(f"{domain}: no JSON fetch fallback")
    print(f"  {'✓' if has_fetch else '⚠️'} {domain}: JSON fetch={'YES' if has_fetch else 'NO'}")

# Check js/articles/ directory
print("\n--- js/articles/ directory check ---")
for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    out = r(f"test -d {root}/js/articles && echo Y || echo N")
    if out == "N":
        issues.append(f"{domain}: js/articles/ directory missing")
    print(f"  {'✓' if out == 'Y' else '⚠️'} {domain}: js/articles/ {'exists' if out == 'Y' else 'MISSING'}")

bt.close()

print(f"\n{'='*60}")
if issues:
    print(f"REAL ISSUES: {len(issues)}")
    for i in issues:
        print(f"  ⚠️ {i}")
else:
    print("✅ ALL SITES VERIFIED - NO ISSUES!")
print(f"{'='*60}")
