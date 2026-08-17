-- D-245 修正：存量回填口径从 last_google_sync_at 改为「最后消费日 + 1 天」
-- 背景：last_google_sync_at 是同步任务最后触碰的时间，与真实暂停时间无关，
--       导致 13619 条回填行挤在少数几个同步日上（偏差 >14 天的占 5034 条）。
-- 口径：
--   1) 有消费历史的：paused_at = 最后消费日(CST)次日零点（存 UTC = 最后消费日 16:00），
--      即「停止消费的那一刻」当近似暂停时间；上限不超过当前时间（避免出现未来日期）。
--      复盘窗口因此自然覆盖该系列真实投放的最后 7 天。
--   2) 从未有过消费的：清空 paused_at / pause_source，移出复盘列表（窗口全 0，无可复盘）。
-- 仅影响 pause_source='backfill' 的行；上线后新产生的精确暂停记录不受影响。
UPDATE campaigns c
LEFT JOIN (
  SELECT campaign_id, MAX(CASE WHEN cost > 0 THEN date END) AS last_spend
  FROM ads_daily_stats
  WHERE is_deleted = 0
  GROUP BY campaign_id
) ls ON ls.campaign_id = c.id
SET c.paused_at = IF(
      ls.last_spend IS NULL,
      NULL,
      LEAST(TIMESTAMP(ls.last_spend) + INTERVAL 16 HOUR, UTC_TIMESTAMP())
    ),
    c.pause_source = IF(ls.last_spend IS NULL, NULL, 'backfill')
WHERE c.pause_source = 'backfill';
