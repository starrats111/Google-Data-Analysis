"""Fix bloomroots: patch loadArticleContent to load JSON for new articles"""
import paramiko, sys, re
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sftp = bt.open_sftp()

br = "/www/wwwroot/bloomroots.top"

with sftp.open(f"{br}/script.js", "r") as f:
    script = f.read().decode("utf-8")

# Find the fallback section in loadArticleContent
old_fallback = """    } else {
        // Fallback for articles without content array
        articleBodyHTML = `
            <p>${article.excerpt}</p>
            <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
            <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
            <p>Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.</p>
        `;
    }"""

new_fallback = """    } else if (typeof article.content === 'string' && article.content.trim()) {
        // HTML content from publishing system
        articleBodyHTML = article.content;
    } else {
        // Load from js/articles/{id}.json for new published articles
        articleBodyHTML = '<p>' + (article.excerpt || 'Loading...') + '</p>';
        if (article.id) {
            fetch('js/articles/' + article.id + '.json')
                .then(function(resp) { return resp.ok ? resp.json() : null; })
                .then(function(data) {
                    if (data && data.content) {
                        var el = document.querySelector('.article-body');
                        if (el) {
                            el.innerHTML = typeof data.content === 'string'
                                ? data.content
                                : data.content.map(function(p) { return '<p>' + p + '</p>'; }).join('');
                        }
                        // Also update hero image if available
                        if (data.image || data.heroImage) {
                            var heroEl = document.querySelector('.article-hero-image');
                            if (heroEl) heroEl.src = data.heroImage || data.image;
                        }
                    }
                })
                .catch(function(err) { console.warn('Failed to load article JSON:', err); });
        }
    }"""

if old_fallback in script:
    script = script.replace(old_fallback, new_fallback)
    with sftp.open(f"{br}/script.js", "w") as f:
        f.write(script.encode("utf-8"))
    print("SUCCESS: Patched loadArticleContent with JSON fallback")
else:
    print("Exact match not found, trying flexible...")
    # Show what's around the fallback
    idx = script.find("Fallback for articles without content array")
    if idx >= 0:
        print(f"Found at position {idx}")
        print("Context:")
        print(repr(script[idx-50:idx+300]))
        
        # Try to match more flexibly
        # Find the } else { before "Fallback"
        else_idx = script.rfind("} else {", 0, idx)
        if else_idx >= 0:
            # Find the closing } of this else block
            # Count braces from else_idx
            brace_start = script.find("{", else_idx)
            depth = 0
            i = brace_start
            while i < len(script):
                if script[i] == '{':
                    depth += 1
                elif script[i] == '}':
                    depth -= 1
                    if depth == 0:
                        break
                elif script[i] in ('`', '"', "'"):
                    quote = script[i]
                    i += 1
                    while i < len(script) and script[i] != quote:
                        if script[i] == '\\':
                            i += 1
                        i += 1
                i += 1
            end = i + 1
            
            old_block = script[else_idx:end]
            print(f"\nFound block ({len(old_block)} chars):")
            print(old_block[:200] + "...")
            
            script = script[:else_idx] + new_fallback.lstrip().rstrip("}") + "}" + script[end:]
            with sftp.open(f"{br}/script.js", "w") as f:
                f.write(script.encode("utf-8"))
            print("Patched with flexible match")
    else:
        print("Cannot find fallback section at all")

# Verify
print("\n=== Verify ===")
def r(cmd, t=15):
    stdin, stdout, stderr = bt.exec_command(cmd, timeout=t)
    stdout.channel.recv_exit_status()
    return stdout.read().decode('utf-8', errors='replace').strip()

print(r(f"grep -n 'JSON\\|json\\|fetch\\|HTML content' {br}/script.js | head -10"))

sftp.close()
bt.close()
print("\nDone!")
