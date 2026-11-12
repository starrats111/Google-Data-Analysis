#!/bin/bash
set -e
echo "=== Executing soft-delete ==="
sudo mysql google-data-analysis -e "
UPDATE affiliate_payments ap
JOIN (
  SELECT ap2.id,
    ROW_NUMBER() OVER (
      PARTITION BY ap2.user_id, ap2.platform, ap2.payment_no
      ORDER BY pc2.created_at ASC, pc2.id ASC
    ) AS rn,
    COUNT(*) OVER (PARTITION BY ap2.user_id, ap2.platform, ap2.payment_no) AS grp_size
  FROM affiliate_payments ap2
  JOIN platform_connections pc2 ON pc2.id = ap2.platform_connection_id
  WHERE ap2.is_deleted = 0
) x ON x.id = ap.id
SET ap.is_deleted = 1, ap.updated_at = NOW()
WHERE ap.is_deleted = 0 AND x.grp_size > 1 AND x.rn > 1;
"
echo "rows affected: $(sudo mysql google-data-analysis -N -e 'SELECT ROW_COUNT();' 2>/dev/null || true)"

echo ""
echo "=== Verify: no more duplicate-group rows remain live ==="
sudo mysql google-data-analysis -e "
SELECT user_id, platform, payment_no, COUNT(DISTINCT platform_connection_id) AS n_conns
FROM affiliate_payments
WHERE is_deleted=0
GROUP BY user_id, platform, payment_no
HAVING n_conns > 1;
"

echo ""
echo "=== wj04 (user 5) November report inputs after fix ==="
sudo mysql google-data-analysis -e "
SELECT platform_connection_id, payment_no, amount, status
FROM affiliate_payments
WHERE user_id=5 AND platform='PM' AND is_deleted=0
  AND request_date >= '2026-11-01' AND request_date < '2026-12-01'
ORDER BY platform_connection_id;
"
