"""Check DNS for both domains"""
import httpx, sys
sys.stdout.reconfigure(encoding='utf-8')

for domain in ['viva-luxe-life.top', 'deliveryandplate.top']:
    try:
        r = httpx.get(f'https://dns.google/resolve?name={domain}&type=A', timeout=10)
        data = r.json()
        answers = data.get('Answer', [])
        if answers:
            for a in answers:
                ip = a.get("data", "?")
                t = a.get("type")
                print(f'{domain} -> {ip} (type={t})')
        else:
            print(f'{domain} -> NO A RECORD')
    except Exception as e:
        print(f'{domain} -> ERROR: {e}')
