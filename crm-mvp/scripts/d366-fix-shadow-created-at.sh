#!/bin/bash
# D-366 存量修复：把今天补录进来的「影子行」created_at 改回真实创建日
#
# 现场：MCC 736-710-9619 于 2026-10-13 01:42 从 wj07(user 8) 转登记给 wj05(user 6)，
# 10-14 06:11:37 补录任务一次性在 wj05 名下插 19 行同 gcid 的老系列，created_at 全盖成当刻。
# 后果：①小组总览「今日投放」显示 19 条（实际 0 条）；
#       ②spend-guard 把它们当「新广告」纳入窗口；③loss-digest 的天龄算成 0 天。
#
# 真值来源：同 gcid 最早一行的 created_at（原主人 user 8 名下 9/14~9/19 的行）。
# 只改 created_at，不动 is_deleted / 花费 / 任何归属字段。
#
# 用法：bash d366-fix-shadow-created-at.sh          # 只看，不改（默认）
#       bash d366-fix-shadow-created-at.sh --apply  # 真改
set -euo pipefail
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

DB=google-data-analysis
Q() { sudo mysql "$DB" -t -e "$1"; }
CUT='2026-10-13 16:00:00'   # 2026-10-14 00:00:00 CST

SEL="SELECT c.id, c.user_id, c.google_campaign_id AS gcid, c.created_at AS wrong_at,
            o.real_created AS right_at
     FROM campaigns c
     JOIN (SELECT google_campaign_id g, MIN(created_at) real_created
           FROM campaigns WHERE google_campaign_id IS NOT NULL GROUP BY google_campaign_id) o
       ON o.g = c.google_campaign_id
     WHERE c.is_deleted = 0
       AND c.google_campaign_id IS NOT NULL
       AND c.created_at >= '$CUT'
       AND o.real_created < '$CUT'"

echo "===== 1. 待修行（今日入库但 gcid 今日前已存在） ====="
Q "$SEL ORDER BY c.id;"

echo "===== 2. 修前：各人今日入库条数（= 卡片当前显示的「今日投放」） ====="
Q "SELECT u.username, COUNT(*) AS today_rows
   FROM campaigns c LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL AND c.created_at >= '$CUT'
   GROUP BY u.username ORDER BY today_rows DESC;"

if [ "$APPLY" -eq 0 ]; then
  echo
  echo ">>> DRY RUN：未做任何修改。确认无误后加 --apply 重跑。"
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
SNAP="/home/ubuntu/d366-rollback-$STAMP.sql"
echo "===== 3. 回滚快照 → $SNAP ====="
sudo mysql "$DB" -B -N -e "$SEL" | awk -F'\t' \
  '{printf "UPDATE campaigns SET created_at = %c%s%c WHERE id = %s;\n", 39, $4, 39, $1}' \
  | sudo tee "$SNAP" > /dev/null
echo "快照行数：$(sudo grep -c '^UPDATE' "$SNAP")"
sudo head -3 "$SNAP"

echo "===== 4. 执行修复（单事务） ====="
sudo mysql "$DB" <<SQL
START TRANSACTION;
UPDATE campaigns c
  JOIN (SELECT google_campaign_id g, MIN(created_at) real_created
        FROM campaigns WHERE google_campaign_id IS NOT NULL GROUP BY google_campaign_id) o
    ON o.g = c.google_campaign_id
SET c.created_at = o.real_created
WHERE c.is_deleted = 0
  AND c.google_campaign_id IS NOT NULL
  AND c.created_at >= '$CUT'
  AND o.real_created < '$CUT';
SELECT ROW_COUNT() AS rows_updated;
COMMIT;
SQL

echo "===== 5. 修后复核：各人今日入库条数 ====="
Q "SELECT u.username, COUNT(*) AS today_rows
   FROM campaigns c LEFT JOIN users u ON u.id = c.user_id
   WHERE c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL AND c.created_at >= '$CUT'
   GROUP BY u.username ORDER BY today_rows DESC;"

echo "===== 6. 复核：还有没有残留影子 ====="
Q "$SEL ORDER BY c.id;"
echo "（上表为空 = 修干净了）"

echo
echo ">>> 回滚：sudo mysql $DB < $SNAP"
