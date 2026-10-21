#!/bin/bash
# D-366 存量修复②：MCC 交接造成的同 gcid 跨人双记花费，按交接日切归属
#
# 01 定的口径（2026-10-14）：
#   「这个 Google 账号已经转到 wj05 名下，从今天开始花费就记在 wj05 名下，
#     wj07 和 wj05 不要重复统计」
#   → 交接日之前的花费归【旧主人】，交接日起归【新主人】，任何一天只能有一个人记。
#
# 交接日 = 该 MCC 当前【活】登记行的 created_at（CST 日期）。
# 要删的是：新主人名下、交接日【之前】的 ads_daily_stats 行（软删，不物删）。
#
# 两道保险：
#   ①只删「旧主人同一天也有行」的：否则那 284 个格子里的 $440.70 会被删没
#     （这些日期旧主人名下根本没有行，钱只存在新主人这一侧）。
#   ②只处理「活登记行 = 最晚一手」的 MCC。排除两个反例：
#     - 984-715-0598：活行 wj04(05-28) 比最晚手 wj111(05-29) 早，且 D-364 已处理过该 MCC
#     - 482-938-3854：一个活登记行都没有（全软删），分不出新旧
#
# 今后不会再长：daily-sync 只加载 is_deleted=0 AND is_active=1 的 MCC，
# 旧主人的登记行已软删，新花费只会往新主人侧写。
#
# 用法：bash d366-fix-handover-dup-cost.sh          # dry run（默认）
#       bash d366-fix-handover-dup-cost.sh --apply  # 真改
set -euo pipefail
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

DB=google-data-analysis
Q() { sudo mysql "$DB" -t -e "$1"; }

# 待删行的判定（整个脚本只认这一个 WHERE，dry run 与 apply 共用）
TARGET="FROM ads_daily_stats s
  JOIN campaigns c        ON c.id = s.campaign_id AND c.is_deleted = 0
  JOIN google_mcc_accounts m ON m.id = c.mcc_id AND m.is_deleted = 0
  WHERE s.is_deleted = 0
    -- 该 gcid 在不同人名下各有活行（= 双记）
    AND c.google_campaign_id IN (
      SELECT google_campaign_id FROM campaigns
      WHERE is_deleted = 0 AND google_campaign_id IS NOT NULL
      GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id) > 1)
    -- 新主人名下、交接日之前
    AND s.date < DATE(CONVERT_TZ(m.created_at,'+00:00','+08:00'))
    -- 保险②：只处理「活登记行 = 最晚一手」的 MCC
    AND m.mcc_id IN (
      SELECT mcc_id FROM google_mcc_accounts
      GROUP BY mcc_id
      HAVING MAX(CASE WHEN is_deleted = 0 THEN created_at END) = MAX(created_at))
    -- 保险①：旧主人同一天也有行，钱才不会删没
    AND EXISTS (
      SELECT 1 FROM campaigns c2
      JOIN google_mcc_accounts m2 ON m2.id = c2.mcc_id AND m2.is_deleted = 1
      JOIN ads_daily_stats s2 ON s2.campaign_id = c2.id AND s2.is_deleted = 0
      WHERE c2.google_campaign_id = c.google_campaign_id
        AND c2.is_deleted = 0 AND c2.user_id <> c.user_id
        AND s2.date = s.date)"

echo "===== 1. 待删总量 ====="
Q "SELECT COUNT(*) AS rows_to_soft_delete,
          ROUND(SUM(s.cost),2) AS cost_removed_from_new_owner,
          COUNT(DISTINCT c.user_id) AS affected_users,
          COUNT(DISTINCT c.google_campaign_id) AS affected_gcids,
          MIN(s.date) AS d_min, MAX(s.date) AS d_max
   $TARGET;"

echo "===== 2. 按人：谁的报表数字会变、变多少 ====="
Q "SELECT u.username, u.display_name, COUNT(*) AS rows_del,
          ROUND(SUM(s.cost),2) AS cost_del, MIN(s.date) AS d_min, MAX(s.date) AS d_max
   $TARGET
   GROUP BY u.username, u.display_name ORDER BY cost_del DESC;" 2>/dev/null || \
Q "SELECT c.user_id, COUNT(*) AS rows_del, ROUND(SUM(s.cost),2) AS cost_del
   $TARGET
   GROUP BY c.user_id ORDER BY cost_del DESC;"

echo "===== 3. 按 MCC：每个账号切在哪一天 ====="
Q "SELECT m.mcc_id AS mcc_no,
          DATE(CONVERT_TZ(m.created_at,'+00:00','+08:00')) AS cutoff_cst,
          COUNT(*) AS rows_del, ROUND(SUM(s.cost),2) AS cost_del
   $TARGET
   GROUP BY m.mcc_id, m.created_at ORDER BY cost_del DESC;"

echo "===== 4. 安全闸：删完后是否还有(gcid,日)变成「没人记」 ====="
Q "SELECT COUNT(*) AS cells_left_with_nobody
   FROM (
     SELECT c.google_campaign_id AS g, s.date
     FROM campaigns c
     JOIN google_mcc_accounts m ON m.id = c.mcc_id
     JOIN ads_daily_stats s ON s.campaign_id = c.id AND s.is_deleted = 0
     WHERE c.is_deleted = 0 AND c.google_campaign_id IN (
       SELECT google_campaign_id FROM campaigns
       WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
       GROUP BY google_campaign_id HAVING COUNT(DISTINCT user_id)>1)
     GROUP BY c.google_campaign_id, s.date
     HAVING SUM(CASE WHEN s.id IN (SELECT s3.id $TARGET) THEN 0 ELSE 1 END) = 0
   ) t;"
echo "（必须是 0。非 0 说明保险①没兜住，立刻停手。）"

if [ "$APPLY" -eq 0 ]; then
  echo
  echo ">>> DRY RUN：未做任何修改。确认无误后加 --apply 重跑。"
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
SNAP="/home/ubuntu/d366-dup-rollback-$STAMP.sql"
echo "===== 5. 回滚快照 → $SNAP ====="
sudo mysql "$DB" -B -N -e "SELECT s.id $TARGET" | awk \
  '{printf "UPDATE ads_daily_stats SET is_deleted = 0 WHERE id = %s;\n", $1}' \
  | sudo tee "$SNAP" > /dev/null
echo "快照行数：$(sudo grep -c '^UPDATE' "$SNAP")"
sudo head -3 "$SNAP"

echo "===== 6. 执行（软删，单事务） ====="
sudo mysql "$DB" <<SQL
START TRANSACTION;
CREATE TEMPORARY TABLE d366_targets (id BIGINT PRIMARY KEY);
INSERT INTO d366_targets (id) SELECT s.id $TARGET;
SELECT COUNT(*) AS targets_locked FROM d366_targets;
UPDATE ads_daily_stats SET is_deleted = 1
 WHERE id IN (SELECT id FROM d366_targets);
SELECT ROW_COUNT() AS rows_soft_deleted;
COMMIT;
SQL

echo "===== 7. 修后复核：还有多少跨人双记花费 ====="
Q "SELECT COUNT(*) AS dup_groups_with_spend, ROUND(SUM(dup_cost),2) AS dup_cost_left
   FROM (
     SELECT c.google_campaign_id AS g, SUM(x.cost)-MAX(x.cost) AS dup_cost
     FROM campaigns c
     JOIN (SELECT campaign_id, SUM(cost) AS cost FROM ads_daily_stats
           WHERE is_deleted=0 GROUP BY campaign_id) x ON x.campaign_id = c.id
     WHERE c.is_deleted=0 AND c.google_campaign_id IS NOT NULL
     GROUP BY c.google_campaign_id
     HAVING COUNT(DISTINCT c.user_id)>1 AND SUM(x.cost)>0
   ) t;"

echo "===== 8. 修后复核：wj05 / wj07 那个 MCC ====="
Q "SELECT u.username, COUNT(*) AS rows_cnt, ROUND(SUM(s.cost),2) AS cost
   FROM ads_daily_stats s
   JOIN campaigns c ON c.id = s.campaign_id AND c.is_deleted = 0
   LEFT JOIN users u ON u.id = c.user_id
   WHERE s.is_deleted = 0
     AND c.google_campaign_id IN (SELECT google_campaign_id FROM campaigns
                                  WHERE user_id = 6 AND mcc_id = 200)
   GROUP BY u.username;"

echo
echo ">>> 回滚：sudo mysql $DB < $SNAP"
