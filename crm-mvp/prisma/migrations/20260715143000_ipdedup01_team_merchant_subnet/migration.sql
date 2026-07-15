-- F-IPDEDUP-01：同 IP/同 /24 段多订单去重升级 —— 去重范围从「(user_id, campaign_id) 单系列」
-- 升级为「跨用户、不跨组」：按 (team_id, platform, merchant_id) 聚合，且同时按精确 IP 与 /24 子网段判定。
-- 背景：刷点击经 rotating 住宅代理注册 clickid → 烘进 suffix → lease 上真实广告 → 真人下单按该
--       clickid 归因，故商家侧订单来源 IP = 我方代理出口 IP。诊断：同日复用 66% 跨 campaign、58% 跨 user；
--       /24 段复用率(4.83%) 是精确 IP(1.56%) 的 3 倍。旧行新列留 NULL，24h 去重窗口过后自然淘汰，向后兼容。
ALTER TABLE `proxy_exit_ip_usage`
  ADD COLUMN `team_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `platform` VARCHAR(8) NULL,
  ADD COLUMN `merchant_id` VARCHAR(64) NULL,
  ADD COLUMN `exit_subnet` VARCHAR(64) NULL;

CREATE INDEX `idx_team_merchant_used` ON `proxy_exit_ip_usage` (`team_id`, `platform`, `merchant_id`, `used_at`);
