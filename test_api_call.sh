#!/bin/bash
# Get a valid JWT for wj07 and call the campaigns API
cd /home/ubuntu/Google-Data-Analysis/crm-mvp

# Generate a JWT token for wj07 (user_id=8)
TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
const secret = process.env.JWT_SECRET || 'dev-secret';
const token = jwt.sign({ userId: '8', username: 'wj07', role: 'user' }, secret, { expiresIn: '1h' });
console.log(token);
" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  # Try reading from .env
  SECRET=$(grep JWT_SECRET .env | cut -d= -f2 | tr -d '"' | tr -d "'")
  TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({ userId: '8', username: 'wj07', role: 'user' }, '$SECRET', { expiresIn: '1h' });
console.log(token);
  " 2>/dev/null)
fi

echo "Token: ${TOKEN:0:20}..."

# Call the API
RESPONSE=$(curl -s "http://localhost:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-27" \
  -H "Cookie: token=$TOKEN")

# Extract summary
echo "$RESPONSE" | node -e "
const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
if (data.code === 0 && data.data) {
  const d = data.data;
  console.log('Summary:', JSON.stringify(d.summary, null, 2));
  console.log('CostByMcc:', JSON.stringify(d.costByMcc, null, 2));
  console.log('Row count:', d.rows?.length);
  if (d.rows) {
    let rowTotal = 0;
    for (const r of d.rows) {
      if (r.cost > 0) {
        console.log('  ', r.campaign_name, '-> cost:', r.cost);
        rowTotal += r.cost;
      }
    }
    console.log('Row total cost:', rowTotal.toFixed(2));
  }
} else {
  console.log('Error:', JSON.stringify(data));
}
" 2>&1
