-- D-273 proxy alert toggle: per-provider mute switch for traffic/availability alerts
ALTER TABLE `kyads_proxies` ADD COLUMN `alert_enabled` TINYINT NOT NULL DEFAULT 1 AFTER `usage_scene`;
