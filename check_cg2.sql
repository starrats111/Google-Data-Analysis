-- Search for merchant_id starting with 18689
SELECT id, platform, merchant_id, merchant_name, status, is_deleted 
FROM user_merchants 
WHERE user_id=8 AND merchant_id LIKE '18689%';

-- Also check all CG merchants for this user with their actual IDs from CollabGlow screenshot
-- Shark Gaming Systems DK, 1st Phorm, Kindred Bravely, DE.Mammotion, Dr. Will Cole
SELECT id, platform, merchant_id, merchant_name, status, is_deleted 
FROM user_merchants 
WHERE user_id=8 AND platform='CG' 
AND (merchant_name LIKE '%Shark Gaming%' 
  OR merchant_name LIKE '%1st Phorm%' 
  OR merchant_name LIKE '%Kindred Bravely%' 
  OR merchant_name LIKE '%Mammotion%' 
  OR merchant_name LIKE '%Will Cole%');

-- Check novanest CG connection details
SELECT id, platform, account_name, LEFT(api_key, 30) as api_key_prefix, is_deleted, created_at 
FROM platform_connections 
WHERE user_id=8 AND platform='CG';

-- Count all users CG merchants
SELECT user_id, COUNT(*) as cg_count, 
  SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) as available_count,
  SUM(CASE WHEN status='claimed' THEN 1 ELSE 0 END) as claimed_count
FROM user_merchants 
WHERE platform='CG' AND is_deleted=0
GROUP BY user_id;
