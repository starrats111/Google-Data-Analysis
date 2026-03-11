"""Test AI API directly with the key from server .env"""
import httpx, json, sys
sys.stdout.reconfigure(encoding='utf-8')

API_KEY = "sk-GnyqfCWVSvemBuu0wobhFBBPEmX8f6lmy7Rki2BuUEqp9yMC"
BASE_URL = "https://api.gemai.cc"

models = [
    "claude-sonnet-4-6",
    "deepseek-chat",
    "claude-sonnet-4-20250514",
    "gpt-4o-mini",
    "gpt-4o",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
]

for model in models:
    try:
        url = f"{BASE_URL}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a JSON API. Return ONLY valid JSON, nothing else."},
                {"role": "user", "content": 'Return: {"status":"ok"}'}
            ],
            "max_tokens": 50,
            "temperature": 0
        }
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, json=payload, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                print(f"  OK  {model}: {content[:80]}")
            else:
                body = resp.text[:200]
                print(f"  ERR {model}: HTTP {resp.status_code} -> {body}")
    except Exception as e:
        print(f"  ERR {model}: {str(e)[:150]}")
