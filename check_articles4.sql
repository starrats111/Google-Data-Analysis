SELECT 'duplicate articles on same site (same title)' as issue,
  COUNT(*) as duplicate_rows
FROM (
  SELECT a.id,
    ROW_NUMBER() OVER (PARTITION BY a.publish_site_id, a.title ORDER BY a.created_at ASC) as rn
  FROM articles a
  WHERE a.is_deleted = 0 AND a.title IS NOT NULL AND a.publish_site_id IS NOT NULL
) t
WHERE t.rn > 1;

SELECT a.publish_site_id, ps.domain,
  a.title,
  COUNT(*) as copies,
  GROUP_CONCAT(CONCAT(a.id, ':', u.username) ORDER BY a.created_at) as article_copies,
  MIN(a.created_at) as first_created,
  MAX(a.created_at) as last_created
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0 AND a.title IS NOT NULL AND a.publish_site_id IS NOT NULL
GROUP BY a.publish_site_id, ps.domain, a.title
HAVING COUNT(*) > 1
ORDER BY copies DESC, a.publish_site_id
LIMIT 30;

SELECT 'per-site cleanup summary' as info,
  ps.domain,
  COUNT(*) as total_articles,
  SUM(CASE WHEN dup.rn > 1 THEN 1 ELSE 0 END) as to_delete,
  SUM(CASE WHEN dup.rn = 1 THEN 1 ELSE 0 END) as to_keep
FROM (
  SELECT a.id, a.publish_site_id,
    ROW_NUMBER() OVER (PARTITION BY a.publish_site_id, a.title ORDER BY a.created_at ASC) as rn
  FROM articles a
  WHERE a.is_deleted = 0 AND a.title IS NOT NULL AND a.publish_site_id IS NOT NULL
) dup
JOIN articles a2 ON dup.id = a2.id
LEFT JOIN publish_sites ps ON a2.publish_site_id = ps.id
GROUP BY ps.domain, a2.publish_site_id
HAVING SUM(CASE WHEN dup.rn > 1 THEN 1 ELSE 0 END) > 0
ORDER BY to_delete DESC;
