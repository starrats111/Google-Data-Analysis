#!/bin/bash
set -e
echo "=== DRY RUN: rows that WOULD be soft-deleted (duplicate payment_no, same user+platform, not the canonical earliest-created connection) ==="
sudo mysql google-data-analysis -e "
SELECT ap.id AS payment_row_id, ap.user_id, ap.platform, ap.platform_connection_id, pc.account_name, ap.payment_no, ap.amount, ap.status, ap.request_date, pc.created_at AS conn_created_at
FROM affiliate_payments ap
JOIN platform_connections pc ON pc.id = ap.platform_connection_id
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
WHERE ap.is_deleted = 0 AND x.grp_size > 1 AND x.rn > 1
ORDER BY ap.user_id, ap.payment_no, ap.platform_connection_id;
"

echo ""
echo "=== Summary: count + total amount to be soft-deleted, per user ==="
sudo mysql google-data-analysis -e "
SELECT ap.user_id, COUNT(*) AS n_rows_to_delete, SUM(CAST(ap.amount AS DECIMAL(14,2))) AS total_amount_removed
FROM affiliate_payments ap
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
WHERE ap.is_deleted = 0 AND x.grp_size > 1 AND x.rn > 1
GROUP BY ap.user_id;
"
