"""Fix zontri.top and allurahub.top: add JSON fetch fallback to main.js"""
import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8')
pkey = paramiko.RSAKey.from_private_key_file(r"C:\Users\Administrator\Desktop\密钥\awssg0306.pem")
bt = paramiko.SSHClient()
bt.set_missing_host_key_policy(paramiko.AutoAddPolicy())
bt.connect("52.74.221.116", 22, "ubuntu", pkey=pkey, timeout=15)
sftp = bt.open_sftp()

def read_remote(path):
    try:
        with sftp.open(path, "r") as f:
            return f.read().decode("utf-8")
    except:
        return None

def write_remote(path, content):
    with sftp.open(path, "w") as f:
        f.write(content.encode("utf-8"))

sites = {
    "zontri.top": "title",
    "allurahub.top": "title",
}

for domain, url_param in sites.items():
    root = f"/www/wwwroot/{domain}"
    main_path = f"{root}/js/main.js"
    print(f"\n--- {domain} ---")
    
    main = read_remote(main_path)
    if not main:
        print(f"  ERROR: main.js not found!")
        continue
    
    # Check if already has fetch for articles JSON
    if "fetch(" in main and "articles" in main and ".json" in main:
        print(f"  Already has JSON fetch")
        continue
    
    fallback = f"""

// JSON fallback: 如果文章内容为空，从 js/articles/{{id}}.json 加载
(function() {{
  var params = new URLSearchParams(window.location.search);
  var paramVal = params.get('{url_param}');
  if (!paramVal || !document.querySelector('.article-content, .article-body, #articleContent')) return;
  
  var contentEl = document.querySelector('.article-content, .article-body, #articleContent');
  if (!contentEl) return;
  
  // 检查内容是否为空或只有 undefined
  var text = contentEl.textContent || '';
  if (text.trim() && text.trim() !== 'undefined' && text.trim().length > 50) return;
  
  // 尝试从 articlesIndex 找到文章 ID
  if (typeof articlesIndex === 'undefined') return;
  var art = articlesIndex.find(function(a) {{
    return a.slug === paramVal || a.title === paramVal;
  }});
  if (!art || !art.id) return;
  
  fetch('js/articles/' + art.id + '.json')
    .then(function(resp) {{ return resp.ok ? resp.json() : null; }})
    .then(function(data) {{
      if (data && data.content) {{
        contentEl.innerHTML = typeof data.content === 'string'
          ? data.content
          : data.content.map(function(p) {{ return '<p>' + p + '</p>'; }}).join('');
      }}
    }})
    .catch(function() {{}});
}})();
"""
    main = main.rstrip() + "\n" + fallback
    write_remote(main_path, main)
    print(f"  Added JSON fetch fallback to main.js")

sftp.close()
bt.close()
print("\nDone!")
