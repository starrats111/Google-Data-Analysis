#!/bin/bash
DB="mysql -u crm -pCrmPass2026! google-data-analysis"

echo "=== MCC CID 账户配置 ==="
$DB -e "
SELECT g.id AS mcc_db_id, g.mcc_id, g.mcc_name, g.user_id,
  (SELECT COUNT(*) FROM mcc_cid_accounts c WHERE c.mcc_account_id=g.id AND c.is_deleted=0) AS total_cids,
  (SELECT COUNT(*) FROM mcc_cid_accounts c WHERE c.mcc_account_id=g.id AND c.is_deleted=0 AND c.status='active') AS active_cids
FROM google_mcc_accounts g
WHERE g.is_deleted=0 AND g.user_id IN (SELECT id FROM users WHERE username LIKE 'wj%' AND username != 'wjzu')
ORDER BY g.user_id;
"

echo ""
echo "=== wj10 MCC 的 CID 详情 ==="
$DB -e "
SELECT c.mcc_account_id, c.customer_id, c.status, c.is_available
FROM mcc_cid_accounts c
WHERE c.mcc_account_id IN (6, 22) AND c.is_deleted=0
ORDER BY c.mcc_account_id, c.customer_id;
"
