"""Final verification: check all sites for JS variable conflicts"""
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

issues = []

# Check SPA sites for const conflicts
SPA_SITES = ["vitahaven.click", "zontri.top", "vitasphere.top", "everydayhaven.top",
             "bloomroots.top", "quiblo.top", "allurahub.top", "mevora.top"]

for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    
    # Get all script files loaded by article.html
    scripts = r(f"grep -o 'src=\"[^\"]*\\.js[^\"]*\"' {root}/article.html 2>/dev/null")
    if not scripts:
        continue
    
    script_files = [s.replace('src="', '').replace('"', '').split('?')[0] for s in scripts.split('\n') if s]
    
    # Collect all const/let declarations across all loaded scripts
    const_vars = {}  # var_name -> [file1, file2, ...]
    for sf in script_files:
        sf_path = f"{root}/{sf}"
        out = r(f"grep -oP '(const|let)\\s+\\w+' {sf_path} 2>/dev/null")
        if out:
            for line in out.split('\n'):
                parts = line.strip().split()
                if len(parts) == 2:
                    kw, vname = parts
                    if vname not in const_vars:
                        const_vars[vname] = []
                    const_vars[vname].append((sf, kw))
    
    # Find conflicts: same const/let variable in multiple files
    conflicts = {k: v for k, v in const_vars.items() if len(v) > 1}
    if conflicts:
        for vname, sources in conflicts.items():
            # Filter out common non-conflicting vars
            if vname in ('i', 'e', 'el', 'item', 'a', 'b', 'key', 'value', 'index', 'match'):
                continue
            issue = f"{domain}: '{vname}' declared as {', '.join(f'{kw} in {f}' for f, kw in sources)}"
            issues.append(issue)
            print(f"  ⚠️ {issue}")
    else:
        print(f"  ✓ {domain}: no const/let conflicts")

# Check that articles-index.js uses var (not const) for articlesIndex
print("\n--- articles-index.js declaration check ---")
for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    out = r(f"grep -o '^\\(const\\|var\\|let\\) articlesIndex' {root}/js/articles-index.js 2>/dev/null")
    if out:
        if "const" in out or "let" in out:
            issues.append(f"{domain}: articles-index.js still uses {out}")
            print(f"  ⚠️ {domain}: {out}")
        else:
            print(f"  ✓ {domain}: {out}")
    else:
        out2 = r(f"test -f {root}/js/articles-index.js && echo Y || echo N")
        if out2 == "Y":
            print(f"  ? {domain}: articlesIndex not found in file")
        else:
            print(f"  - {domain}: no articles-index.js")

# Check merge code exists
print("\n--- merge code check ---")
for domain in SPA_SITES:
    root = f"/www/wwwroot/{domain}"
    out = r(f"grep -c 'forEach\\|unshift' {root}/js/articles-index.js 2>/dev/null")
    has_merge = int(out) > 0 if out and out.isdigit() else False
    print(f"  {'✓' if has_merge else '⚠️'} {domain}: merge code {'present' if has_merge else 'MISSING'}")
    if not has_merge:
        issues.append(f"{domain}: merge code missing in articles-index.js")

bt.close()

print(f"\n{'='*60}")
if issues:
    print(f"ISSUES FOUND: {len(issues)}")
    for i in issues:
        print(f"  ⚠️ {i}")
else:
    print("ALL SITES VERIFIED - NO ISSUES!")
print(f"{'='*60}")
