UPDATE articles
JOIN (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY publish_site_id, title ORDER BY created_at ASC) as rn
  FROM articles
  WHERE is_deleted = 0 AND title IS NOT NULL AND publish_site_id IS NOT NULL
) dup ON articles.id = dup.id
SET articles.is_deleted = 1
WHERE dup.rn > 1;

SELECT ROW_COUNT() as cleaned_rows;

SELECT a.user_id, u.username, COUNT(*) as remaining_articles
FROM articles a
LEFT JOIN users u ON a.user_id = u.id
WHERE a.is_deleted = 0
GROUP BY a.user_id, u.username
ORDER BY a.user_id;
