UPDATE campaigns c
JOIN (
  SELECT d.google_campaign_id, d.user_id, MAX(d.customer_id) as cid
  FROM campaigns d
  WHERE d.is_deleted = 1 AND d.customer_id IS NOT NULL AND d.customer_id != ''
    AND d.google_campaign_id IS NOT NULL
  GROUP BY d.google_campaign_id, d.user_id
) src ON c.google_campaign_id = src.google_campaign_id AND c.user_id = src.user_id
SET c.customer_id = src.cid
WHERE c.is_deleted = 0 AND (c.customer_id IS NULL OR c.customer_id = '');
