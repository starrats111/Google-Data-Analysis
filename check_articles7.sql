SELECT a.id, a.user_id, u.username,
  LEFT(a.title, 60) as title,
  a.merchant_name, um.merchant_id as mid,
  a.status, a.created_at
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN user_merchants um ON a.user_merchant_id = um.id
WHERE a.publish_site_id = 1 AND a.is_deleted = 0
ORDER BY a.user_id, a.created_at;
