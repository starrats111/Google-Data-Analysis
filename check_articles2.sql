SELECT 'orphan articles (no merchant link)' as check_type,
  a.user_id, u.username, a.id as article_id,
  LEFT(a.title, 50) as title, a.status, a.publish_site_id, ps.domain,
  a.created_at
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0 AND a.user_merchant_id IS NULL
ORDER BY a.created_at DESC;

SELECT 'backfilled articles (created without user action)' as check_type,
  a.user_id, u.username, a.id as article_id,
  LEFT(a.title, 60) as title,
  a.merchant_name, um.merchant_id as mid,
  a.status, ps.domain,
  a.created_at,
  um.user_id as merchant_owner_id
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN user_merchants um ON a.user_merchant_id = um.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0
  AND a.status = 'published'
  AND a.published_at IS NULL
ORDER BY a.created_at DESC
LIMIT 30;

SELECT 'duplicate merchants across users' as check_type,
  um.merchant_id as mid, um.merchant_name,
  GROUP_CONCAT(DISTINCT CONCAT(um.user_id, ':', u.username)) as user_list,
  COUNT(DISTINCT um.user_id) as user_count
FROM user_merchants um
LEFT JOIN users u ON um.user_id = u.id
WHERE um.is_deleted = 0
GROUP BY um.merchant_id, um.merchant_name
HAVING COUNT(DISTINCT um.user_id) > 1
ORDER BY user_count DESC
LIMIT 20;

SELECT 'same site same merchant different users' as check_type,
  a.publish_site_id, ps.domain,
  um.merchant_id as mid, um.merchant_name,
  GROUP_CONCAT(DISTINCT CONCAT(a.user_id, ':', u.username)) as users_with_articles,
  COUNT(*) as total_articles
FROM articles a
LEFT JOIN user_merchants um ON a.user_merchant_id = um.id
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0
GROUP BY a.publish_site_id, ps.domain, um.merchant_id, um.merchant_name
HAVING COUNT(DISTINCT a.user_id) > 1
ORDER BY total_articles DESC
LIMIT 20;
