SELECT a.id, a.user_id, u.username,
  LEFT(a.title, 60) as title,
  a.merchant_name, um.merchant_id as mid,
  a.status, ps.domain,
  a.created_at, a.is_deleted
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN user_merchants um ON a.user_merchant_id = um.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.publish_site_id = 1
  AND a.title IS NOT NULL
ORDER BY a.title, a.created_at;

SELECT a.user_id, u.username,
  COUNT(*) as total,
  SUM(CASE WHEN a.is_deleted = 0 THEN 1 ELSE 0 END) as active,
  SUM(CASE WHEN a.is_deleted = 1 THEN 1 ELSE 0 END) as deleted
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
WHERE a.publish_site_id = 1
GROUP BY a.user_id, u.username
ORDER BY a.user_id;

SELECT a.user_id, u.username,
  COUNT(*) as active_count
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
WHERE a.publish_site_id = 1 AND a.is_deleted = 0
GROUP BY a.user_id, u.username;
