SELECT a.user_id, u.username, COUNT(*) as article_count,
  SUM(CASE WHEN a.status='published' THEN 1 ELSE 0 END) as published_count
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
WHERE a.is_deleted = 0
GROUP BY a.user_id, u.username
ORDER BY article_count DESC;

SELECT a.user_id, u.username,
  a.publish_site_id, ps.site_name, ps.domain,
  COUNT(*) as cnt
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0
GROUP BY a.user_id, u.username, a.publish_site_id, ps.site_name, ps.domain
ORDER BY a.publish_site_id, cnt DESC;

SELECT a.user_id, u.username, a.id as article_id,
  LEFT(a.title, 50) as title,
  a.merchant_name, um.merchant_id as mid,
  a.status, a.publish_site_id, ps.domain,
  a.created_at
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN user_merchants um ON a.user_merchant_id = um.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0
  AND a.user_merchant_id IS NOT NULL
  AND a.user_id != um.user_id
ORDER BY a.created_at DESC
LIMIT 50;
