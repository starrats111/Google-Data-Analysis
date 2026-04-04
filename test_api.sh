#!/bin/bash
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxOCIsInVzZXJuYW1lIjoieXowMiIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzc0NTA5NTEyLCJleHAiOjE3NzQ1MTMxMTJ9.vL7_QWhTj0_4tP9BE9UxWpuCg8bszfFXNEhpvquYYjE"

echo "=== available tab ==="
AVAIL=$(curl -s -b "user_token=$TOKEN" "http://localhost:20050/api/user/merchants?tab=available&page=1&pageSize=3")
echo "$AVAIL" | python3 -c "
import sys, json
d = json.load(sys.stdin)
data = d.get('data', {})
print('code:', d.get('code'))
print('total:', data.get('total'))
print('stats:', json.dumps(data.get('stats'), indent=2))
print('merchants returned:', len(data.get('merchants', [])))
"

echo ""
echo "=== claimed tab ==="
CLAIMED=$(curl -s -b "user_token=$TOKEN" "http://localhost:20050/api/user/merchants?tab=claimed&page=1&pageSize=3")
echo "$CLAIMED" | python3 -c "
import sys, json
d = json.load(sys.stdin)
data = d.get('data', {})
print('code:', d.get('code'))
print('total:', data.get('total'))
print('stats:', json.dumps(data.get('stats'), indent=2))
print('merchants returned:', len(data.get('merchants', [])))
"
