-- Check if merchant_id 18689626 exists for ANY user
SELECT id, user_id, platform, merchant_id, merchant_name, status, is_deleted 
FROM user_merchants 
WHERE merchant_id = '18689626';

-- Also check nearby IDs
SELECT id, user_id, platform, merchant_id, merchant_name, status, is_deleted 
FROM user_merchants 
WHERE merchant_id IN ('18680626', '18689626', '18686626')
AND user_id = 8;

-- Check the novanest CG account - what was most recently synced
SELECT id, merchant_id, merchant_name, status, created_at, updated_at 
FROM user_merchants 
WHERE user_id=8 AND platform='CG' AND is_deleted=0
ORDER BY created_at DESC 
LIMIT 20;
