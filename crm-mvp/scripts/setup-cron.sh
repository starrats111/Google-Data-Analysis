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
MERCHANT_CRON="0 0 * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/weekly-merchant-check' >> /var/log/cron-weekly-merchant.log 2>&1"
DAILY_CRON="0 6 * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/daily-sync' >> /var/log/cron-daily-sync.log 2>&1"
KYLINK_SYNC_CRON="*/30 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/kylink-sync' >> /var/log/cron-kylink-sync.log 2>&1"
# 换链接库存自适应补货（每 5 分钟）：扫描近期有 lease 活动且库存低于低水位的广告系列并补货
SUFFIX_REPLENISH_CRON="*/5 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/suffix-replenish' >> /var/log/cron-suffix-replenish.log 2>&1"
# 上级联盟巡航验证回填（每 30 分钟）：扫描有链接但 parent_network 为空的商家并巡航识别上级联盟
# 注意：日志须写到 ubuntu 可写目录 /var/log/crm-cron/，否则 cron 重定向失败、整条命令不执行
PARENT_BACKFILL_CRON="*/30 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/parent-network-backfill?limit=40' >> /var/log/crm-cron/parent-network-backfill.log 2>&1"
# D-190 花费哨兵：2026-07-27 经 07 拍板停用（「CRM 都是自己手动关停」），改由 D-191 每日
# 亏损提醒把零出单超线的系列推给归属人自己决定。代码与 spend_guard_actions 表保留，
# 需要时把下面两行取消注释 + .env 里 SPEND_GUARD_ENABLED 改回 1 即可复活。
# SPEND_GUARD_CRON="*/15 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/spend-guard' >> /var/log/crm-cron/spend-guard.log 2>&1"
# D-191 每日亏损提醒（每天 09:30 CST）：在投但一直亏钱的系列，按归属人推站内通知 + 飞书汇总
LOSS_DIGEST_CRON="30 9 * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' '${APP_URL}/api/cron/loss-digest' >> /var/log/crm-cron/loss-digest.log 2>&1"

echo "=== Will add the following cron jobs ==="
echo ""
echo "Merchant check (00:00 every day):"
echo "  $MERCHANT_CRON"
echo ""
echo "Daily sync (06:00 every day):"
echo "  $DAILY_CRON"
echo ""
echo "kylink sync (every 30 minutes):"
echo "  $KYLINK_SYNC_CRON"
echo ""
echo "suffix replenish (every 5 minutes):"
echo "  $SUFFIX_REPLENISH_CRON"
echo ""
echo "parent-network backfill (every 30 minutes):"
echo "  $PARENT_BACKFILL_CRON"
echo ""
echo "loss digest (09:30 every day):"
echo "  $LOSS_DIGEST_CRON"
echo ""

# 添加到 crontab（保留现有条目，避免重复）
TEMP_CRON=$(mktemp)
crontab -l 2>/dev/null | grep -v '/api/cron/daily-sync' | grep -v '/api/cron/weekly-merchant-check' | grep -v '/api/cron/kylink-sync' | grep -v '/api/cron/suffix-replenish' | grep -v '/api/cron/parent-network-backfill' | grep -v '/api/cron/spend-guard' | grep -v '/api/cron/loss-digest' > "$TEMP_CRON" || true
echo "$DAILY_CRON" >> "$TEMP_CRON"
echo "$MERCHANT_CRON" >> "$TEMP_CRON"
echo "$KYLINK_SYNC_CRON" >> "$TEMP_CRON"
echo "$SUFFIX_REPLENISH_CRON" >> "$TEMP_CRON"
echo "$PARENT_BACKFILL_CRON" >> "$TEMP_CRON"
echo "$LOSS_DIGEST_CRON" >> "$TEMP_CRON"
crontab "$TEMP_CRON"
rm -f "$TEMP_CRON"

echo "=== Cron jobs installed ==="
crontab -l | grep '/api/cron/'
