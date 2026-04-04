-- 1. wj07 的本月花费总计
SELECT 'wj07 March cost' as label, 
  SUM(s.cost) as total_cost
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
JOIN users u ON c.user_id = u.id
WHERE u.username = 'wj07' AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date < '2026-04-01';

-- 2. wj07 按 campaign 的花费明细
SELECT c.google_campaign_id, c.campaign_name, c.customer_id,
  SUM(s.cost) as total_cost, SUM(s.clicks) as clicks, SUM(s.impressions) as impr
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
JOIN users u ON c.user_id = u.id
WHERE u.username = 'wj07' AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date < '2026-04-01'
GROUP BY c.id
HAVING total_cost > 0
ORDER BY total_cost DESC;

-- 3. 检查是否还有重复
SELECT user_id, google_campaign_id, COUNT(*) as cnt
FROM campaigns
WHERE is_deleted = 0 AND google_campaign_id IS NOT NULL
GROUP BY user_id, google_campaign_id
HAVING cnt > 1;

-- 4. 所有用户的本月花费汇总
SELECT u.username, SUM(s.cost) as total_cost
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
JOIN users u ON c.user_id = u.id
WHERE c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date < '2026-04-01'
GROUP BY u.username
ORDER BY total_cost DESC;
