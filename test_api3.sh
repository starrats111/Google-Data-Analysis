#!/bin/bash
cd /home/ubuntu/Google-Data-Analysis/crm-mvp

SECRET=$(grep JWT_SECRET .env | cut -d= -f2 | tr -d '"' | tr -d "'")

TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({ userId: '8', username: 'wj07', role: 'user' }, '${SECRET}', { expiresIn: '1h' });
console.log(token);
")

echo "Calling API with user_token cookie..."
curl -s "http://localhost:20050/api/user/data-center/campaigns?date_start=2026-03-01&date_end=2026-03-27" \
  -H "Cookie: user_token=${TOKEN}" > /tmp/api_result.json

echo "Response size: $(wc -c < /tmp/api_result.json) bytes"

node -e "
const fs = require('fs');
const raw = fs.readFileSync('/tmp/api_result.json', 'utf8');
try {
  const data = JSON.parse(raw);
  if (data.code === 0 && data.data) {
    const d = data.data;
    console.log('totalCost:', d.summary.totalCost);
    console.log('totalCommission:', d.summary.totalCommission);
    console.log('campaignCount:', d.summary.campaignCount);
    console.log('costByMcc:', JSON.stringify(d.costByMcc));
    let rowTotal = 0;
    for (const r of (d.rows || [])) {
      if (r.cost > 0) {
        console.log('  ' + r.campaign_name + ' -> ' + r.cost);
        rowTotal += r.cost;
      }
    }
    console.log('rowTotal:', rowTotal.toFixed(2));
  } else {
    console.log('API response:', raw.substring(0, 500));
  }
} catch(e) {
  console.log('Parse error:', e.message);
  console.log('Raw:', raw.substring(0, 500));
}
"
