-- Check specific merchant IDs from CollabGlow screenshot
SELECT id, platform, merchant_id, merchant_name, status, is_deleted 
FROM user_merchants 
WHERE user_id=8 AND merchant_id IN ('18689626','18646404','8002522','18646405','13647384');

-- Check CG merchant count and sample
SELECT COUNT(*) as cg_total FROM user_merchants WHERE user_id=8 AND platform='CG' AND is_deleted=0;

-- Sample CG merchants
SELECT id, merchant_id, merchant_name, status, is_deleted 
FROM user_merchants 
WHERE user_id=8 AND platform='CG' AND is_deleted=0 
LIMIT 10;

-- Check if the "选取商家" search uses merchant_id or merchant_name
SELECT id, merchant_id, merchant_name, status
FROM user_merchants
WHERE user_id=8 AND platform='CG' AND is_deleted=0 AND status='available'
AND (merchant_id LIKE '%18689%' OR merchant_name LIKE '%18689%')
LIMIT 10;
