#!/bin/bash
# 设置定时任务
# 用法: CRON_SECRET=your-secret-key bash scripts/setup-cron.sh

set -e

if [ -z "$CRON_SECRET" ]; then
  echo "Error: CRON_SECRET environment variable is required"
  echo "Usage: CRON_SECRET=your-secret-key bash scripts/setup-cron.sh"
  exit 1
fi

APP_URL="${APP_URL:-http://localhost:3000}"

# 生成 crontab 条目
DAILY_CRON="0 0 * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/daily-sync' >> /var/log/cron-daily-sync.log 2>&1"
MERCHANT_CRON="0 6 */2 * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/weekly-merchant-check' >> /var/log/cron-weekly-merchant.log 2>&1"

echo "=== Will add the following cron jobs ==="
echo ""
echo "Daily sync (00:00 every day):"
echo "  $DAILY_CRON"
echo ""
echo "Merchant check (06:00 every 2 days):"
echo "  $MERCHANT_CRON"
echo ""

# 添加到 crontab（保留现有条目，避免重复）
TEMP_CRON=$(mktemp)
crontab -l 2>/dev/null | grep -v '/api/cron/daily-sync' | grep -v '/api/cron/weekly-merchant-check' > "$TEMP_CRON" || true
echo "$DAILY_CRON" >> "$TEMP_CRON"
echo "$MERCHANT_CRON" >> "$TEMP_CRON"
crontab "$TEMP_CRON"
rm -f "$TEMP_CRON"

echo "=== Cron jobs installed ==="
crontab -l | grep '/api/cron/'
