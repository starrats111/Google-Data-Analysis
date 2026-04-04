SELECT u.username, um.id, um.merchant_name, um.merchant_url, um.tracking_link, um.platform, um.link_status
FROM user_merchants um JOIN users u ON um.user_id = u.id
WHERE u.username = 'yz02' AND um.merchant_name LIKE '%Rakuten%' AND um.is_deleted=0
LIMIT 5;

SELECT ac.id, ac.final_url, LENGTH(ac.final_url) as url_len
FROM ad_creatives ac
JOIN ad_groups ag ON ac.ad_group_id = ag.id
JOIN campaigns c ON ag.campaign_id = c.id
JOIN user_merchants um ON c.user_merchant_id = um.id
JOIN users u ON c.user_id = u.id
WHERE u.username = 'yz02' AND um.merchant_name LIKE '%Rakuten%'
AND ac.is_deleted=0 LIMIT 5;
