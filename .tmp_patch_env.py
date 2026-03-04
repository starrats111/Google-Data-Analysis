from pathlib import Path
import secrets

p = Path('D:/Google Analysis/backend/.env')
lines = []
if p.exists():
    lines = p.read_text(encoding='utf-8').splitlines()

kv = {}
for ln in lines:
    stripped = ln.strip()
    if not stripped or stripped.startswith('#'):
        continue
    if '=' in ln:
        k, v = ln.split('=', 1)
        kv[k.strip()] = v

if not kv.get('ENVIRONMENT'):
    kv['ENVIRONMENT'] = 'development'

if (not kv.get('SECRET_KEY')) or kv.get('SECRET_KEY') == 'your-secret-key-change-in-production':
    kv['SECRET_KEY'] = secrets.token_urlsafe(48)

if (not kv.get('REFRESH_SECRET_KEY')) or kv.get('REFRESH_SECRET_KEY') in ('', 'your-secret-key-change-in-production'):
    kv['REFRESH_SECRET_KEY'] = secrets.token_urlsafe(48)

if not kv.get('DATABASE_URL'):
    kv['DATABASE_URL'] = 'sqlite:///./google_analysis.db'

if not kv.get('COOKIE_SECURE'):
    kv['COOKIE_SECURE'] = 'False'

if not kv.get('COOKIE_SAMESITE'):
    kv['COOKIE_SAMESITE'] = 'lax'

if 'GOOGLE_ADS_SHARED_DEVELOPER_TOKEN' not in kv:
    kv['GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'] = ''

order = [
    'ENVIRONMENT',
    'SECRET_KEY',
    'REFRESH_SECRET_KEY',
    'DATABASE_URL',
    'COOKIE_SECURE',
    'COOKIE_SAMESITE',
    'GOOGLE_ADS_SHARED_DEVELOPER_TOKEN',
]

out = ['# Local dev env for browser test']
for k in order:
    out.append(f'{k}={kv.get(k, "")}')

for k, v in kv.items():
    if k not in order:
        out.append(f'{k}={v}')

p.write_text('\n'.join(out) + '\n', encoding='utf-8')
print('env_patched')
