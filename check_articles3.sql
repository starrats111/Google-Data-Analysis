SELECT id, username, role FROM users ORDER BY id;

SELECT a.user_id, u.username,
  COUNT(*) as total,
  SUM(CASE WHEN a.user_merchant_id IS NOT NULL AND um.user_id IS NOT NULL AND a.user_id = um.user_id THEN 1 ELSE 0 END) as own_merchant,
  SUM(CASE WHEN a.user_merchant_id IS NOT NULL AND um.user_id IS NOT NULL AND a.user_id != um.user_id THEN 1 ELSE 0 END) as other_merchant,
  SUM(CASE WHEN a.user_merchant_id IS NULL THEN 1 ELSE 0 END) as no_merchant
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN user_merchants um ON a.user_merchant_id = um.id
WHERE a.is_deleted = 0
GROUP BY a.user_id, u.username
ORDER BY a.user_id;

SELECT a.publish_site_id, ps.domain,
  COUNT(*) as total_articles,
  COUNT(DISTINCT a.user_id) as user_count,
  GROUP_CONCAT(DISTINCT u.username ORDER BY u.username) as users
FROM articles a
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
LEFT JOIN users u ON a.user_id = u.id
WHERE a.is_deleted = 0
GROUP BY a.publish_site_id, ps.domain
ORDER BY user_count DESC, total_articles DESC;

SELECT a.id, a.user_id, u.username,
  LEFT(a.title, 50) as title,
  a.merchant_name,
  um.merchant_id as mid,
  a.status, ps.domain,
  a.created_at
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN user_merchants um ON a.user_merchant_id = um.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0
  AND a.publish_site_id = 1
ORDER BY a.title, a.user_id
LIMIT 40;
