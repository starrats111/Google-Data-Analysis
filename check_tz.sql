-- Check timezone offset issue
-- parseCSTDateStart("2026-03-01") = UTC 2026-02-28T16:00:00Z
-- If Prisma sends to MySQL as DATE: 2026-02-28 (UTC date part)
-- Then query is: date >= '2026-02-28' instead of date >= '2026-03-01'

-- 1. Feb 28 data for wj07
SELECT c.campaign_name, s.date, s.cost
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date = '2026-02-28'
ORDER BY s.cost DESC;

-- 2. Feb 28 total
SELECT 'Feb28' as day, SUM(s.cost) as total
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0 AND s.date = '2026-02-28';

-- 3. Mar 27 total
SELECT 'Mar27' as day, SUM(s.cost) as total
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0 AND s.date = '2026-03-27';

-- 4. Compare: DB Mar1-27 vs DB Feb28-Mar26 (simulating the timezone-shifted range)
SELECT 'Mar1-Mar27 (correct)' as range_desc, SUM(s.cost) as total
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date <= '2026-03-27'
UNION ALL
SELECT 'Feb28-Mar26 (shifted)' as range_desc, SUM(s.cost) as total
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-02-28' AND s.date < '2026-03-27';
