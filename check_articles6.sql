SELECT pc.user_id, u.username, pc.platform, pc.publish_site_id, ps.site_name, ps.domain
FROM platform_connections pc
LEFT JOIN users u ON pc.user_id = u.id
LEFT JOIN publish_sites ps ON pc.publish_site_id = ps.id
WHERE pc.is_deleted = 0 AND pc.publish_site_id IS NOT NULL
ORDER BY pc.publish_site_id, pc.user_id;

SELECT id, site_name, domain, status, verified FROM publish_sites WHERE is_deleted = 0 ORDER BY id;
