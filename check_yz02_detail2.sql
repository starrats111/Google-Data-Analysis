-- 查看商家134789的完整信息
SELECT id, merchant_name, merchant_url, tracking_link, 
       SUBSTRING(campaign_link, 1, 200) as campaign_link_preview,
       link_status, platform
FROM user_merchants WHERE id = 134789;

-- 查看ad_creative 181的完整信息
SELECT id, final_url, display_path1, display_path2, 
       JSON_LENGTH(headlines) as headline_count,
       JSON_LENGTH(descriptions) as desc_count,
       created_at, updated_at
FROM ad_creatives WHERE id = 181;

-- 查看关联的campaign
SELECT c.id, c.campaign_name, c.target_country, c.google_campaign_id,
       c.customer_id, c.status
FROM campaigns c
JOIN ad_groups ag ON ag.campaign_id = c.id
JOIN ad_creatives ac ON ac.ad_group_id = ag.id
WHERE ac.id = 181;
