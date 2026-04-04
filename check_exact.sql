-- Replicate API logic exactly for wj07 (user_id=8), March 2026
-- Date range: 2026-03-01 00:00:00 CST to 2026-03-27 now CST

-- 1. Check campaigns that match the API query (must have mcc_id in user's MCCs)
SELECT c.id, c.google_campaign_id, c.customer_id, c.campaign_name, c.mcc_id,
  COALESCE(s.cost, 0) as cost
FROM campaigns c
LEFT JOIN (
  SELECT campaign_id, SUM(cost) as cost
  FROM ads_daily_stats
  WHERE is_deleted = 0
    AND date >= '2026-03-01'
    AND date < '2026-03-28'
  GROUP BY campaign_id
) s ON s.campaign_id = c.id
WHERE c.user_id = 8
  AND c.is_deleted = 0
  AND c.google_campaign_id IS NOT NULL
  AND c.mcc_id IN (SELECT id FROM google_mcc_accounts WHERE user_id = 8 AND is_deleted = 0)
ORDER BY COALESCE(s.cost, 0) DESC;

-- 2. Check if there are campaigns WITHOUT mcc_id
SELECT c.id, c.google_campaign_id, c.campaign_name, c.mcc_id,
  COALESCE(s.cost, 0) as cost
FROM campaigns c
LEFT JOIN (
  SELECT campaign_id, SUM(cost) as cost
  FROM ads_daily_stats
  WHERE is_deleted = 0
    AND date >= '2026-03-01'
    AND date < '2026-03-28'
  GROUP BY campaign_id
) s ON s.campaign_id = c.id
WHERE c.user_id = 8
  AND c.is_deleted = 0
  AND c.google_campaign_id IS NOT NULL
  AND (c.mcc_id IS NULL OR c.mcc_id NOT IN (SELECT id FROM google_mcc_accounts WHERE user_id = 8 AND is_deleted = 0));

-- 3. Check stats with date range CST vs UTC edge case
-- CST 2026-03-27 00:00 = UTC 2026-03-26 16:00
-- If dates are stored as DATE (not DATETIME), timezone shouldn't matter
SELECT s.date, s.cost, s.campaign_id, c.campaign_name
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-26'
  AND s.date <= '2026-03-27'
ORDER BY s.date DESC, s.cost DESC;

-- 4. Total ads_daily_stats cost by different date ranges
SELECT 'march 1-27' as period, SUM(s.cost) as total
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date < '2026-03-28'
  AND c.mcc_id IN (SELECT id FROM google_mcc_accounts WHERE user_id = 8 AND is_deleted = 0)
UNION ALL
SELECT 'march full' as period, SUM(s.cost) as total
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date < '2026-04-01'
  AND c.mcc_id IN (SELECT id FROM google_mcc_accounts WHERE user_id = 8 AND is_deleted = 0)
UNION ALL
SELECT 'no mcc filter' as period, SUM(s.cost) as total
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = 8 AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date < '2026-04-01';

-- 5. Check column type of date in ads_daily_stats
SHOW COLUMNS FROM ads_daily_stats LIKE 'date';
