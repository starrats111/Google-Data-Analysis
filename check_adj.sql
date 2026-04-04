-- 1. wj07 的 MCC 误差费用
SELECT a.*, m.mcc_name, m.mcc_id as mcc_code
FROM mcc_cost_adjustments a
LEFT JOIN google_mcc_accounts m ON a.mcc_account_id = m.id
WHERE a.user_id = (SELECT id FROM users WHERE username = 'wj07')
  AND a.is_deleted = 0;

-- 2. wj07 所有 MCC 账号
SELECT id, mcc_id, mcc_name, currency FROM google_mcc_accounts
WHERE user_id = (SELECT id FROM users WHERE username = 'wj07') AND is_deleted = 0;

-- 3. wj07 活跃 campaign 数量（含 mcc_id 关联）
SELECT c.mcc_id, m.mcc_name, m.currency, COUNT(*) as cnt, SUM(s.total_cost) as cost
FROM campaigns c
LEFT JOIN google_mcc_accounts m ON c.mcc_id = m.id
LEFT JOIN (
  SELECT campaign_id, SUM(cost) as total_cost
  FROM ads_daily_stats
  WHERE is_deleted = 0 AND date >= '2026-03-01' AND date < '2026-04-01'
  GROUP BY campaign_id
) s ON s.campaign_id = c.id
WHERE c.user_id = (SELECT id FROM users WHERE username = 'wj07')
  AND c.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
GROUP BY c.mcc_id;

-- 4. 检查 costDiff 可能来源 - 前端的 costDiff 字段
SELECT SUM(s.cost) as db_total_cost
FROM ads_daily_stats s
JOIN campaigns c ON s.campaign_id = c.id
WHERE c.user_id = (SELECT id FROM users WHERE username = 'wj07')
  AND c.is_deleted = 0 AND s.is_deleted = 0
  AND s.date >= '2026-03-01' AND s.date < '2026-03-28';
