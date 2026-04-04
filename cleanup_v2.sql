SELECT '=== Phase 1: Restore wrongly deleted CG owner articles ===' as step;

UPDATE articles a
JOIN (
  SELECT DISTINCT a1.id
  FROM articles a1
  INNER JOIN articles a2
    ON a1.publish_site_id = a2.publish_site_id
    AND a1.title = a2.title
    AND a2.id != a1.id
  WHERE a1.is_deleted = 1
    AND a1.title IS NOT NULL
    AND a1.publish_site_id IS NOT NULL
    AND a1.status IN ('published', 'preview')
    AND (
      (a1.publish_site_id = 1 AND a1.user_id = 3) OR
      (a1.publish_site_id = 2 AND a1.user_id = 8) OR
      (a1.publish_site_id = 4 AND a1.user_id = 11) OR
      (a1.publish_site_id = 5 AND a1.user_id = 7) OR
      (a1.publish_site_id = 7 AND a1.user_id = 18) OR
      (a1.publish_site_id = 11 AND a1.user_id = 10) OR
      (a1.publish_site_id = 12 AND a1.user_id = 6) OR
      (a1.publish_site_id = 14 AND a1.user_id = 5) OR
      (a1.publish_site_id = 15 AND a1.user_id = 7) OR
      (a1.publish_site_id = 16 AND a1.user_id = 2) OR
      (a1.publish_site_id = 18 AND a1.user_id = 6) OR
      (a1.publish_site_id = 19 AND a1.user_id = 3) OR
      (a1.publish_site_id = 20 AND a1.user_id = 2)
    )
) t ON a.id = t.id
SET a.is_deleted = 0;

SELECT ROW_COUNT() as restored_rows;

SELECT '=== Phase 2: Delete non-owner duplicates (keep CG owner copy) ===' as step;

UPDATE articles
JOIN (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY publish_site_id, title
      ORDER BY
        CASE
          WHEN publish_site_id = 1 AND user_id = 3 THEN 0
          WHEN publish_site_id = 2 AND user_id = 8 THEN 0
          WHEN publish_site_id = 4 AND user_id = 11 THEN 0
          WHEN publish_site_id = 5 AND user_id = 7 THEN 0
          WHEN publish_site_id = 7 AND user_id = 18 THEN 0
          WHEN publish_site_id = 11 AND user_id = 10 THEN 0
          WHEN publish_site_id = 12 AND user_id = 6 THEN 0
          WHEN publish_site_id = 14 AND user_id = 5 THEN 0
          WHEN publish_site_id = 15 AND user_id = 7 THEN 0
          WHEN publish_site_id = 16 AND user_id = 2 THEN 0
          WHEN publish_site_id = 18 AND user_id = 6 THEN 0
          WHEN publish_site_id = 19 AND user_id = 3 THEN 0
          WHEN publish_site_id = 20 AND user_id = 2 THEN 0
          ELSE 1
        END,
        CASE WHEN status = 'published' THEN 0 ELSE 1 END,
        created_at ASC
    ) as rn
  FROM articles
  WHERE is_deleted = 0 AND title IS NOT NULL AND publish_site_id IS NOT NULL
) ranked ON articles.id = ranked.id
SET articles.is_deleted = 1
WHERE ranked.rn > 1;

SELECT ROW_COUNT() as deleted_duplicates;

SELECT '=== Phase 3: Verify result ===' as step;

SELECT a.user_id, u.username, ps.domain,
  COUNT(*) as active_articles
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.is_deleted = 0
GROUP BY a.user_id, u.username, ps.domain
ORDER BY ps.domain, a.user_id;

SELECT a.publish_site_id, ps.domain, a.title,
  COUNT(*) as copies,
  GROUP_CONCAT(CONCAT(u.username, '(', CASE WHEN a.is_deleted=0 THEN 'active' ELSE 'del' END, ')') ORDER BY a.created_at) as detail
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN publish_sites ps ON a.publish_site_id = ps.id
WHERE a.title IS NOT NULL AND a.publish_site_id IS NOT NULL
GROUP BY a.publish_site_id, ps.domain, a.title
HAVING SUM(CASE WHEN a.is_deleted = 0 THEN 1 ELSE 0 END) > 1
LIMIT 20;
