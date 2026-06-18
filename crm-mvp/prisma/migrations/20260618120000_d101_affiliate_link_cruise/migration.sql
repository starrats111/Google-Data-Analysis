-- D-101 追踪链接 + 上级联盟自动巡航（主 CRM 自建，替代 hermes-crm/门户那套）
-- 1) user_merchants 增巡航结果字段
-- 2) 新建 parent_networks（上级联盟识别库）+ platform_blacklist（各平台禁跑上级联盟）
-- 3) 用权威联盟跳板域名清单做默认种子（平台黑名单留空，由后台维护）

-- ───────── 1. user_merchants 巡航字段 ─────────
ALTER TABLE `user_merchants`
  ADD COLUMN `parent_network` VARCHAR(64) NULL,
  ADD COLUMN `parent_blacklisted` TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN `tracking_status` VARCHAR(20) NOT NULL DEFAULT 'unchecked',
  ADD COLUMN `resolved_final_url` VARCHAR(1024) NULL,
  ADD COLUMN `resolve_chain` JSON NULL,
  ADD COLUMN `parent_checked_at` DATETIME(0) NULL,
  ADD COLUMN `parent_check_reason` VARCHAR(255) NULL;

-- ───────── 2. parent_networks ─────────
CREATE TABLE `parent_networks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `label` VARCHAR(64) NOT NULL,
  `display_name` VARCHAR(128) NULL,
  `match_keywords` JSON NOT NULL,
  `note` VARCHAR(255) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_parent_label` (`label`),
  KEY `idx_parent_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ───────── 3. platform_blacklist ─────────
CREATE TABLE `platform_blacklist` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `platform` VARCHAR(16) NOT NULL,
  `parent_label` VARCHAR(64) NOT NULL,
  `note` VARCHAR(255) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_platform_parent` (`platform`, `parent_label`),
  KEY `idx_bl_platform` (`platform`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ───────── 4. 上级联盟默认种子（权威跳板域名，来自 link-resolver TRACKER_HOST_PATTERNS）─────────
INSERT IGNORE INTO `parent_networks` (`label`, `display_name`, `match_keywords`, `note`) VALUES
  ('awin',              'Awin',                  '["awin","awin1.com","zenaps.com","dwin1.com"]', '内置种子'),
  ('impact',            'Impact',                '["impact","impactradius","pxf.io","sjv.io","ojrq.net"]', '内置种子'),
  ('partnerize',        'Partnerize',            '["partnerize","prf.hn","performancehorizon"]', '内置种子'),
  ('commissionjunction','CJ (Commission Junction)','["commissionjunction","commission junction","anrdoezrs.net","dpbolvw.net","jdoqocy.com","kqzyfj.com","tkqlhce.com","qksrv.net","emjcd.com"]', '内置种子'),
  ('rakuten',           'Rakuten Advertising',   '["rakuten","linksynergy.com","linkshare","rakutenadvertising"]', '内置种子'),
  ('flexoffers',        'FlexOffers',            '["flexoffers","flexlinkspro.com","flexoffers.com"]', '内置种子'),
  ('shareasale',        'ShareASale',            '["shareasale","shareasale.com","shrsl.com"]', '内置种子'),
  ('pepperjam',         'Pepperjam / Ascend',    '["pepperjam","pntra.com","pntrac.com","pntrs.com"]', '内置种子'),
  ('tradedoubler',      'TradeDoubler',          '["tradedoubler","tradedoubler.com"]', '内置种子'),
  ('tradetracker',      'TradeTracker',          '["tradetracker","tradetracker.com","tradetracker.net"]', '内置种子'),
  ('webgains',          'Webgains',              '["webgains","webgains.com"]', '内置种子'),
  ('everflow',          'Everflow',              '["everflow","everflow.io"]', '内置种子'),
  ('sovrn',             'Sovrn / VigLink',       '["sovrn","viglink","viglink.com","redirectingat.com"]', '内置种子'),
  ('linkhaitao',        'LinkHaitao',            '["linkhaitao","linkhaitao.com","linkhaitao.cn","lhdeal"]', '内置种子'),
  ('skimlinks',         'Skimlinks',             '["skimlinks","skimresources.com","go.skimresources.com"]', '内置种子'),
  ('admitad',           'Admitad',               '["admitad","admitad.com"]', '内置种子'),
  ('clickbank',         'ClickBank',             '["clickbank","clickbank.net","hop.clickbank.net"]', '内置种子'),
  ('partnerstack',      'PartnerStack',          '["partnerstack","prtnr.link"]', '内置种子');
