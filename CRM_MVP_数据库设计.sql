-- ============================================================
-- CRM SaaS MVP — MySQL 数据库设计（与 Prisma Schema 同步）
-- 最后更新：2026-03-20
-- 规则：无外键、软删除、含 created_at / updated_at
-- 字符集：utf8mb4  引擎：InnoDB
-- 共 29 张表
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------
-- 1. 团队/小组表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `teams`;
CREATE TABLE `teams` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `team_code`  VARCHAR(20)     NOT NULL COMMENT '团队代码（唯一）',
  `team_name`  VARCHAR(50)     NOT NULL COMMENT '团队名称',
  `leader_id`  BIGINT UNSIGNED DEFAULT NULL COMMENT '组长 users.id',
  `is_deleted` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_team_code` (`team_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团队/小组';

-- -----------------------------------------------------------
-- 2. 用户表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `username`       VARCHAR(64)     NOT NULL COMMENT '用户名（唯一）',
  `password_hash`  VARCHAR(255)    NOT NULL COMMENT '密码哈希',
  `plain_password` VARCHAR(128)    DEFAULT NULL COMMENT '明文密码（仅管理员可见）',
  `role`           VARCHAR(16)     NOT NULL DEFAULT 'user' COMMENT '角色：admin / user',
  `status`         VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT '状态：active / disabled',
  `team_id`        BIGINT UNSIGNED DEFAULT NULL COMMENT '所属团队 teams.id',
  `display_name`   VARCHAR(50)     DEFAULT NULL COMMENT '显示名称',
  `is_deleted`     TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`),
  KEY `idx_team_id` (`team_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- -----------------------------------------------------------
-- 3. AI 供应商表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ai_providers`;
CREATE TABLE `ai_providers` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `provider_name` VARCHAR(32)     NOT NULL COMMENT '供应商名称',
  `api_key`       TEXT            NOT NULL COMMENT 'API Key（加密存储）',
  `api_base_url`  VARCHAR(512)    DEFAULT NULL COMMENT '自定义 API 地址',
  `status`        VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT '状态：active / disabled',
  `is_deleted`    TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 供应商配置（总控制台管理）';

-- -----------------------------------------------------------
-- 4. AI 场景模型分配表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ai_model_configs`;
CREATE TABLE `ai_model_configs` (
  `id`          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT '主键',
  `scene`       VARCHAR(32)      NOT NULL COMMENT '场景：ad_copy / article / data_insight / translate',
  `provider_id` BIGINT UNSIGNED  NOT NULL COMMENT '关联 ai_providers.id',
  `model_name`  VARCHAR(64)      NOT NULL COMMENT '模型名称',
  `max_tokens`  INT UNSIGNED     DEFAULT 4096 COMMENT '最大输出 token',
  `temperature` DECIMAL(3,2)     DEFAULT 0.70 COMMENT '温度参数',
  `is_active`   TINYINT(1)       NOT NULL DEFAULT 1 COMMENT '是否为该场景生效模型',
  `priority`    TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '优先级（1=主模型，2+=备用）',
  `is_deleted`  TINYINT(1)       NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_scene_active` (`scene`, `is_active`, `priority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 场景模型分配（总控制台管理）';

-- -----------------------------------------------------------
-- 5. 系统配置表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `system_configs`;
CREATE TABLE `system_configs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `config_key`   VARCHAR(128)    NOT NULL COMMENT '配置键',
  `config_value` TEXT            DEFAULT NULL COMMENT '配置值',
  `description`  VARCHAR(255)    DEFAULT NULL COMMENT '说明',
  `is_deleted`   TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_config_key` (`config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统配置（AI/SemRush/SSH/后端等键值对）';

-- -----------------------------------------------------------
-- 6. 联盟平台连接表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `platform_connections`;
CREATE TABLE `platform_connections` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`         BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `platform`        VARCHAR(8)      NOT NULL COMMENT '平台代码：CG / PM / LH / RW / LB / BSH / CF',
  `account_name`    VARCHAR(32)     NOT NULL DEFAULT '' COMMENT '账号名称（如 RW1, RW2）',
  `api_key`         TEXT            DEFAULT NULL COMMENT 'API 密钥（加密存储）',
  `publish_site_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '绑定的发布站点 publish_sites.id',
  `status`          VARCHAR(16)     NOT NULL DEFAULT 'connected' COMMENT '连接状态',
  `last_synced_at`  DATETIME        DEFAULT NULL COMMENT '最后同步时间',
  `is_deleted`      TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_platform` (`user_id`, `platform`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='联盟平台 API 连接配置';

-- -----------------------------------------------------------
-- 7. 商家库表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `user_merchants`;
CREATE TABLE `user_merchants` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`                BIGINT UNSIGNED NOT NULL COMMENT '所属用户（数据隔离）',
  `platform`               VARCHAR(8)      NOT NULL COMMENT '来源平台代码',
  `merchant_id`            VARCHAR(64)     NOT NULL COMMENT '平台商家 ID',
  `merchant_name`          VARCHAR(255)    NOT NULL COMMENT '商家名称',
  `merchant_url`           VARCHAR(512)    DEFAULT NULL COMMENT '商家网址',
  `category`               VARCHAR(128)    DEFAULT NULL COMMENT '品类',
  `commission_rate`        VARCHAR(64)     DEFAULT NULL COMMENT '佣金率',
  `cookie_duration`        INT UNSIGNED    DEFAULT NULL COMMENT 'Cookie 有效期（天）',
  `supported_regions`      JSON            DEFAULT NULL COMMENT '支持地区列表',
  `status`                 VARCHAR(16)     NOT NULL DEFAULT 'available' COMMENT '状态：available / claimed',
  `claimed_at`             DATETIME        DEFAULT NULL COMMENT '领取时间',
  `target_country`         VARCHAR(8)      DEFAULT NULL COMMENT '目标国家',
  `holiday_name`           VARCHAR(128)    DEFAULT NULL COMMENT '关联节日',
  `tracking_link`          VARCHAR(1024)   DEFAULT NULL COMMENT '联盟追踪链接',
  `campaign_link`          TEXT            DEFAULT NULL COMMENT '联盟平台推广链接',
  `violation_status`       VARCHAR(20)     NOT NULL DEFAULT 'normal' COMMENT 'normal / violated',
  `violation_time`         DATETIME        DEFAULT NULL COMMENT '违规时间',
  `recommendation_status`  VARCHAR(20)     NOT NULL DEFAULT 'normal' COMMENT 'normal / recommended',
  `recommendation_time`    DATETIME        DEFAULT NULL COMMENT '推荐时间',
  `policy_status`          VARCHAR(16)     NOT NULL DEFAULT 'pending' COMMENT 'pending / clean / restricted / prohibited',
  `policy_category_code`   VARCHAR(32)     DEFAULT NULL COMMENT '匹配到的政策类别代码',
  `platform_connection_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联到具体平台账号',
  `is_deleted`             TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_status` (`user_id`, `status`),
  KEY `idx_user_platform` (`user_id`, `platform`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户商家库（每人独立，数据隔离）';

-- -----------------------------------------------------------
-- 8. 商家违规记录表（从 Google Sheets 同步）
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `merchant_violations`;
CREATE TABLE `merchant_violations` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `merchant_name`    VARCHAR(255)    NOT NULL COMMENT '商家名称',
  `platform`         VARCHAR(32)     NOT NULL DEFAULT '' COMMENT '平台',
  `merchant_domain`  VARCHAR(255)    DEFAULT NULL COMMENT '商家域名',
  `violation_reason` TEXT            DEFAULT NULL COMMENT '违规原因',
  `violation_time`   DATETIME        DEFAULT NULL COMMENT '违规时间',
  `source`           VARCHAR(100)    DEFAULT NULL COMMENT '名单来源',
  `upload_batch`     VARCHAR(64)     NOT NULL COMMENT '上传批次号',
  `is_deleted`       TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vio_name` (`merchant_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商家违规记录（Google Sheets 同步）';

-- -----------------------------------------------------------
-- 9. 推荐商家记录表（从 Google Sheets 同步）
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `merchant_recommendations`;
CREATE TABLE `merchant_recommendations` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `merchant_name`   VARCHAR(255)    NOT NULL COMMENT '商家名称',
  `roi_reference`   VARCHAR(64)     DEFAULT NULL COMMENT 'ROI 参考值',
  `commission_info` VARCHAR(64)     DEFAULT NULL COMMENT '佣金率',
  `settlement_info` VARCHAR(64)     DEFAULT NULL COMMENT '结算率',
  `remark`          TEXT            DEFAULT NULL COMMENT '备注',
  `share_time`      VARCHAR(32)     DEFAULT NULL COMMENT '分享时间',
  `upload_batch`    VARCHAR(64)     NOT NULL COMMENT '上传批次号',
  `is_deleted`      TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_rec_name` (`merchant_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='推荐商家记录（Google Sheets 同步）';

-- -----------------------------------------------------------
-- 10. 共享表格配置
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `sheet_configs`;
CREATE TABLE `sheet_configs` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `config_type`    VARCHAR(32)     NOT NULL COMMENT '类型：violation / recommendation / merchant_sheet',
  `sheet_url`      TEXT            NOT NULL COMMENT 'Google Sheets URL',
  `last_synced_at` DATETIME        DEFAULT NULL COMMENT '最后同步时间',
  `updated_by`     BIGINT UNSIGNED DEFAULT NULL COMMENT '更新人 users.id',
  `is_deleted`     TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_config_type` (`config_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='共享表格配置（Google Sheets 链接）';

-- -----------------------------------------------------------
-- 11. 广告默认设置表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ad_default_settings`;
CREATE TABLE `ad_default_settings` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`          BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `bidding_strategy` VARCHAR(32)     NOT NULL DEFAULT 'MAXIMIZE_CLICKS' COMMENT '出价策略',
  `ecpc_enabled`     TINYINT(1)      NOT NULL DEFAULT 1 COMMENT 'eCPC 开关',
  `max_cpc`          DECIMAL(10,2)   NOT NULL DEFAULT 0.30 COMMENT '默认最高 CPC（USD）',
  `daily_budget`     DECIMAL(10,2)   NOT NULL DEFAULT 2.00 COMMENT '默认日预算（USD）',
  `network_search`   TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '搜索网络',
  `network_partners` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '搜索合作伙伴',
  `network_display`  TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '展示网络',
  `naming_rule`      VARCHAR(20)     NOT NULL DEFAULT 'global' COMMENT '命名规则：global / per_platform',
  `naming_prefix`    VARCHAR(10)     NOT NULL DEFAULT 'wj' COMMENT '全局序号前缀',
  `eu_political_ad`  TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '0=不含EU政治广告 1=含',
  `is_deleted`       TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='广告投放默认设置';

-- -----------------------------------------------------------
-- 12. 节日日历表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `holiday_calendar`;
CREATE TABLE `holiday_calendar` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `country_code`     VARCHAR(8)      NOT NULL COMMENT '国家代码',
  `holiday_name`     VARCHAR(128)    NOT NULL COMMENT '节日名称',
  `holiday_date`     DATE            NOT NULL COMMENT '节日日期',
  `holiday_type`     VARCHAR(16)     NOT NULL DEFAULT 'commercial' COMMENT 'public / commercial / religious',
  `related_holidays` JSON            DEFAULT NULL COMMENT '关联的其他国家同类节日',
  `is_deleted`       TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_country_date` (`country_code`, `holiday_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='各国节日日历';

-- -----------------------------------------------------------
-- 13. 广告系列表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `campaigns`;
CREATE TABLE `campaigns` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`             BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `user_merchant_id`    BIGINT UNSIGNED NOT NULL COMMENT '关联 user_merchants.id',
  `google_campaign_id`  VARCHAR(64)     DEFAULT NULL COMMENT 'Google Ads 广告系列 ID',
  `mcc_id`              BIGINT UNSIGNED DEFAULT NULL COMMENT '关联 google_mcc_accounts.id',
  `customer_id`         VARCHAR(32)     DEFAULT NULL COMMENT 'Google Ads CID（子账户）',
  `campaign_name`       VARCHAR(255)    DEFAULT NULL COMMENT '广告系列名称',
  `daily_budget`        DECIMAL(10,2)   NOT NULL DEFAULT 2.00 COMMENT '每日预算（USD）',
  `bidding_strategy`    VARCHAR(32)     NOT NULL DEFAULT 'MAXIMIZE_CLICKS' COMMENT '出价策略',
  `max_cpc_limit`       DECIMAL(10,2)   DEFAULT NULL COMMENT '最高 CPC（USD）',
  `target_country`      VARCHAR(8)      NOT NULL COMMENT '目标国家',
  `geo_target`          VARCHAR(16)     DEFAULT NULL COMMENT '地理定位代码',
  `language_id`         VARCHAR(16)     DEFAULT NULL COMMENT '语言代码',
  `network_search`      TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '搜索网络',
  `network_partners`    TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '搜索合作伙伴',
  `network_display`     TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '展示网络',
  `status`              VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT '本地状态：active / paused / removed',
  `google_status`       VARCHAR(16)     NOT NULL DEFAULT 'ENABLED' COMMENT 'Google Ads 侧状态：ENABLED / PAUSED / REMOVED',
  `last_google_sync_at` DATETIME        DEFAULT NULL COMMENT '最后 Google 同步时间',
  `is_deleted`          TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_user_merchant` (`user_merchant_id`),
  KEY `idx_google_campaign` (`google_campaign_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Google Ads 广告系列';

-- -----------------------------------------------------------
-- 14. 广告组表（Google Ads 必需层级）
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ad_groups`;
CREATE TABLE `ad_groups` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `campaign_id`        BIGINT UNSIGNED NOT NULL COMMENT '关联 campaigns.id',
  `google_ad_group_id` VARCHAR(64)     DEFAULT NULL COMMENT 'Google Ads 广告组 ID',
  `ad_group_name`      VARCHAR(255)    DEFAULT NULL COMMENT '广告组名称',
  `keyword_match_type` VARCHAR(16)     NOT NULL DEFAULT 'PHRASE' COMMENT '默认匹配：PHRASE / BROAD / EXACT',
  `is_deleted`         TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_campaign` (`campaign_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='广告组（Google Ads Campaign→AdGroup→Ad 必需中间层）';

-- -----------------------------------------------------------
-- 15. 关键词表（来源：SemRush 竞品分析）
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `keywords`;
CREATE TABLE `keywords` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `ad_group_id`          BIGINT UNSIGNED NOT NULL COMMENT '关联 ad_groups.id',
  `keyword_text`         VARCHAR(255)    NOT NULL COMMENT '关键词文本',
  `match_type`           VARCHAR(16)     NOT NULL DEFAULT 'PHRASE' COMMENT '匹配类型',
  `is_negative`          TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '是否为否定关键词',
  `avg_monthly_searches` INT UNSIGNED    DEFAULT NULL COMMENT '月均搜索量',
  `competition`          VARCHAR(16)     DEFAULT NULL COMMENT '竞争程度：LOW / MEDIUM / HIGH',
  `suggested_bid`        DECIMAL(10,2)   DEFAULT NULL COMMENT '建议出价（USD）',
  `is_deleted`           TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ad_group` (`ad_group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='广告关键词（数据来源：SemRush 竞品分析）';

-- -----------------------------------------------------------
-- 16. 广告素材表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ad_creatives`;
CREATE TABLE `ad_creatives` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `ad_group_id`     BIGINT UNSIGNED NOT NULL COMMENT '关联 ad_groups.id',
  `final_url`       VARCHAR(1024)   NOT NULL COMMENT '着陆页 URL',
  `display_path1`   VARCHAR(15)     DEFAULT NULL COMMENT '显示路径 1',
  `display_path2`   VARCHAR(15)     DEFAULT NULL COMMENT '显示路径 2',
  `headlines`       JSON            NOT NULL COMMENT '标题列表 ≤15条（SemRush + AI）',
  `descriptions`    JSON            NOT NULL COMMENT '描述列表 ≤4条（SemRush + AI）',
  `headlines_zh`    JSON            DEFAULT NULL COMMENT '标题中文参考翻译',
  `descriptions_zh` JSON           DEFAULT NULL COMMENT '描述中文参考翻译',
  `sitelinks`       JSON            DEFAULT NULL COMMENT '站点链接',
  `callouts`        JSON            DEFAULT NULL COMMENT '宣传信息',
  `image_urls`      JSON            DEFAULT NULL COMMENT '图片素材 URL 列表',
  `logo_url`        VARCHAR(1024)   DEFAULT NULL COMMENT '商家 Logo URL',
  `selling_points`  JSON            DEFAULT NULL COMMENT '商家卖点',
  `is_deleted`      TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ad_group` (`ad_group_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='广告素材（RSA 自适应搜索广告）';

-- -----------------------------------------------------------
-- 17. 站点表（全局资源，管理员统一管理）
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `publish_sites`;
CREATE TABLE `publish_sites` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `site_name`            VARCHAR(128)    NOT NULL COMMENT '站点名称',
  `domain`               VARCHAR(200)    NOT NULL COMMENT '域名',
  `site_path`            VARCHAR(300)    DEFAULT NULL COMMENT '宝塔远程路径（自动生成）',
  `site_type`            VARCHAR(30)     DEFAULT NULL COMMENT '架构类型（自动检测）',
  `data_js_path`         VARCHAR(200)    DEFAULT 'js/articles-index.js' COMMENT '文章数据文件路径',
  `article_var_name`     VARCHAR(100)    DEFAULT NULL COMMENT '文章变量名',
  `article_html_pattern` VARCHAR(100)    DEFAULT NULL COMMENT '文章 HTML 模板',
  `deploy_type`          VARCHAR(32)     NOT NULL DEFAULT 'bt_ssh' COMMENT '部署方式：bt_ssh',
  `deploy_config`        JSON            DEFAULT NULL COMMENT '部署配置',
  `status`               VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT '状态：active / inactive',
  `verified`             TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '是否已验证',
  `is_deleted`           TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_domain` (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='发布站点（全局资源，管理员统一管理）';

-- -----------------------------------------------------------
-- 18. 站点迁移任务表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `site_migrations`;
CREATE TABLE `site_migrations` (
  `id`            BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT '主键',
  `site_id`       BIGINT UNSIGNED  DEFAULT NULL COMMENT '关联 publish_sites.id',
  `domain`        VARCHAR(200)     NOT NULL COMMENT '域名',
  `source_type`   VARCHAR(16)      NOT NULL COMMENT '来源：github / cloudflare',
  `source_ref`    VARCHAR(512)     DEFAULT NULL COMMENT '源 URL',
  `status`        VARCHAR(16)      NOT NULL DEFAULT 'pending' COMMENT 'pending / cloning / dns / ssl / verifying / done / failed',
  `progress`      TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '进度 0-100',
  `step_detail`   TEXT             DEFAULT NULL COMMENT '当前步骤详情',
  `error_message` TEXT             DEFAULT NULL COMMENT '错误信息',
  `started_at`    DATETIME         DEFAULT NULL,
  `finished_at`   DATETIME         DEFAULT NULL,
  `created_by`    BIGINT UNSIGNED  NOT NULL COMMENT '管理员 user_id',
  `is_deleted`    TINYINT(1)       NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_migration_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='站点迁移任务（异步进度追踪）';

-- -----------------------------------------------------------
-- 19. 文章表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `articles`;
CREATE TABLE `articles` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`          BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `user_merchant_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联 user_merchants.id',
  `publish_site_id`  BIGINT UNSIGNED DEFAULT NULL COMMENT '关联 publish_sites.id',
  `title`            VARCHAR(512)    DEFAULT NULL COMMENT '文章标题（AI 生成）',
  `slug`             VARCHAR(512)    DEFAULT NULL COMMENT 'URL 友好路径',
  `content`          LONGTEXT        DEFAULT NULL COMMENT '文章正文（HTML）',
  `excerpt`          TEXT            DEFAULT NULL COMMENT '文章摘要',
  `language`         VARCHAR(8)      NOT NULL DEFAULT 'en' COMMENT '文章语言',
  `keywords`         JSON            DEFAULT NULL COMMENT 'SEO 关键词',
  `images`           JSON            DEFAULT NULL COMMENT '文章配图 URL 列表',
  `status`           VARCHAR(16)     NOT NULL DEFAULT 'generating' COMMENT 'generating / preview / published / failed',
  `published_at`     DATETIME        DEFAULT NULL COMMENT '发布时间',
  `published_url`    VARCHAR(1024)   DEFAULT NULL COMMENT '发布后的外部 URL',
  `merchant_name`    VARCHAR(255)    DEFAULT NULL COMMENT '商家名称',
  `tracking_link`    VARCHAR(1024)   DEFAULT NULL COMMENT '追踪链接',
  `meta_title`       VARCHAR(512)    DEFAULT NULL COMMENT 'SEO 标题',
  `meta_description` TEXT            DEFAULT NULL COMMENT 'SEO 描述',
  `is_deleted`       TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_user_merchant` (`user_merchant_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 生成文章';

-- -----------------------------------------------------------
-- 20. 广告每日数据表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ads_daily_stats`;
CREATE TABLE `ads_daily_stats` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`             BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `user_merchant_id`    BIGINT UNSIGNED NOT NULL COMMENT '关联 user_merchants.id',
  `campaign_id`         BIGINT UNSIGNED NOT NULL COMMENT '关联 campaigns.id',
  `date`                DATE            NOT NULL COMMENT '数据日期',
  `budget`              DECIMAL(12,2)   DEFAULT NULL COMMENT '当日预算（USD）',
  `cost`                DECIMAL(12,2)   DEFAULT 0.00 COMMENT '实际花费（USD）',
  `clicks`              INT UNSIGNED    DEFAULT 0 COMMENT '点击数',
  `impressions`         INT UNSIGNED    DEFAULT 0 COMMENT '展示数',
  `cpc`                 DECIMAL(10,4)   DEFAULT NULL COMMENT '单次点击费用（USD）',
  `conversions`         INT UNSIGNED    DEFAULT 0 COMMENT '转化数',
  `commission`          DECIMAL(12,2)   DEFAULT 0.00 COMMENT '佣金（USD）',
  `rejected_commission` DECIMAL(12,2)   DEFAULT 0.00 COMMENT '拒付佣金（USD）',
  `roi`                 DECIMAL(10,4)   DEFAULT NULL COMMENT '投资回报率',
  `orders`              INT UNSIGNED    DEFAULT 0 COMMENT '订单数',
  `data_source`         VARCHAR(8)      DEFAULT 'sheet' COMMENT '数据来源：sheet / api',
  `is_deleted`          TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_campaign_date` (`campaign_id`, `date`),
  KEY `idx_user_date` (`user_id`, `date`),
  KEY `idx_merchant_date` (`user_merchant_id`, `date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='广告每日数据（统一 USD）';

-- -----------------------------------------------------------
-- 21. Google Ads MCC 账户表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `google_mcc_accounts`;
CREATE TABLE `google_mcc_accounts` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`              BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `mcc_id`               VARCHAR(32)     NOT NULL COMMENT 'MCC 账户 ID',
  `mcc_name`             VARCHAR(128)    DEFAULT NULL COMMENT 'MCC 名称',
  `currency`             VARCHAR(8)      NOT NULL DEFAULT 'USD' COMMENT '货币：USD / CNY',
  `service_account_json` TEXT            DEFAULT NULL COMMENT '服务账号凭证 JSON（加密存储）',
  `sheet_url`            VARCHAR(1024)   DEFAULT NULL COMMENT 'MCC 脚本导出的 Google Sheet URL',
  `developer_token`      VARCHAR(128)    DEFAULT NULL COMMENT 'Google Ads API Developer Token',
  `is_active`            TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '是否启用',
  `is_deleted`           TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Google Ads MCC 账户';

-- -----------------------------------------------------------
-- 22. MCC 子账户（CID）列表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `mcc_cid_accounts`;
CREATE TABLE `mcc_cid_accounts` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `mcc_account_id` BIGINT UNSIGNED NOT NULL COMMENT '关联 google_mcc_accounts.id',
  `customer_id`    VARCHAR(32)     NOT NULL COMMENT 'Google Ads CID',
  `customer_name`  VARCHAR(255)    DEFAULT NULL COMMENT 'CID 账户名称',
  `is_available`   VARCHAR(1)      NOT NULL DEFAULT 'Y' COMMENT 'Y=可用 N=已被广告系列占用',
  `status`         VARCHAR(16)     NOT NULL DEFAULT 'active' COMMENT 'active / suspended / cancelled',
  `last_synced_at` DATETIME        DEFAULT NULL COMMENT '最后同步时间',
  `is_deleted`     TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_mcc_cid` (`mcc_account_id`, `customer_id`),
  KEY `idx_mcc_available` (`mcc_account_id`, `is_available`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='MCC 子账户（CID）列表';

-- -----------------------------------------------------------
-- 23. 联盟交易明细表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `affiliate_transactions`;
CREATE TABLE `affiliate_transactions` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`                BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `user_merchant_id`       BIGINT UNSIGNED NOT NULL COMMENT '关联 user_merchants.id',
  `campaign_id`            BIGINT UNSIGNED DEFAULT NULL COMMENT '关联 campaigns.id',
  `platform_connection_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '关联平台账号',
  `platform`               VARCHAR(8)      NOT NULL COMMENT '平台代码',
  `merchant_id`            VARCHAR(64)     NOT NULL COMMENT '平台商家 ID',
  `merchant_name`          VARCHAR(255)    NOT NULL COMMENT '商家名称',
  `transaction_id`         VARCHAR(128)    NOT NULL COMMENT '交易 ID',
  `transaction_time`       DATETIME        NOT NULL COMMENT '交易时间',
  `order_amount`           DECIMAL(12,2)   DEFAULT 0.00 COMMENT '订单金额',
  `commission_amount`      DECIMAL(12,2)   DEFAULT 0.00 COMMENT '佣金金额',
  `currency`               VARCHAR(8)      NOT NULL DEFAULT 'USD' COMMENT '货币',
  `status`                 VARCHAR(16)     NOT NULL DEFAULT 'pending' COMMENT 'pending / approved / rejected',
  `raw_status`             VARCHAR(32)     DEFAULT NULL COMMENT '平台原始状态',
  `is_deleted`             TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_platform_txn` (`platform`, `transaction_id`),
  KEY `idx_user_merchant_id` (`user_id`, `merchant_id`),
  KEY `idx_user_txn_time` (`user_id`, `transaction_time`),
  KEY `idx_user_status` (`user_id`, `status`),
  KEY `idx_platform_conn` (`platform_connection_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='联盟交易明细（支撑结算查询）';

-- -----------------------------------------------------------
-- 24. 消息通知表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `notifications`;
CREATE TABLE `notifications` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`    BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `type`       VARCHAR(32)     NOT NULL DEFAULT 'system' COMMENT 'system / merchant / article / ad / alert',
  `title`      VARCHAR(255)    NOT NULL COMMENT '通知标题',
  `content`    TEXT            DEFAULT NULL COMMENT '通知内容',
  `is_read`    TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '是否已读',
  `is_deleted` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_read` (`user_id`, `is_read`, `is_deleted`),
  KEY `idx_user_created` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='消息通知';

-- -----------------------------------------------------------
-- 25. 通知偏好设置表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `notification_preferences`;
CREATE TABLE `notification_preferences` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`         BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `notify_system`   TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '系统通知',
  `notify_merchant` TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '商家通知',
  `notify_article`  TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '文章通知',
  `notify_ad`       TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '广告通知',
  `notify_alert`    TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '预警通知',
  `is_deleted`      TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知偏好设置';

-- （prompt_preferences 表已删除 — AI 风格偏好 MVP 阶段使用默认值）

-- -----------------------------------------------------------
-- 26. AI 洞察报告表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ai_insights`;
CREATE TABLE `ai_insights` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`          BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
  `insight_date`     DATE            NOT NULL COMMENT '洞察日期',
  `insight_type`     VARCHAR(16)     NOT NULL DEFAULT 'daily' COMMENT '类型：daily / weekly / monthly',
  `content`          LONGTEXT        NOT NULL COMMENT 'AI 分析内容（Markdown）',
  `metrics_snapshot` JSON            DEFAULT NULL COMMENT '生成时的关键指标快照',
  `is_deleted`       TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_date_type` (`user_id`, `insight_date`, `insight_type`),
  KEY `idx_user_insight_date` (`user_id`, `insight_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI 洞察报告（每日/每周/每月）';

-- -----------------------------------------------------------
-- 27. 操作日志表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `operation_logs`;
CREATE TABLE `operation_logs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id`     BIGINT UNSIGNED NOT NULL COMMENT '操作人',
  `username`    VARCHAR(64)     NOT NULL COMMENT '操作人用户名',
  `action`      VARCHAR(64)     NOT NULL COMMENT '动作：login / create_user / claim_merchant 等',
  `target_type` VARCHAR(32)     DEFAULT NULL COMMENT '目标类型：user / merchant / article 等',
  `target_id`   VARCHAR(64)     DEFAULT NULL COMMENT '目标 ID',
  `detail`      TEXT            DEFAULT NULL COMMENT '操作详情 JSON',
  `ip_address`  VARCHAR(45)     DEFAULT NULL COMMENT 'IP 地址',
  `user_agent`  VARCHAR(512)    DEFAULT NULL COMMENT 'User-Agent',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_created` (`user_id`, `created_at`),
  KEY `idx_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志（审计追踪）';

-- -----------------------------------------------------------
-- 28. Google Ads 政策限制类别表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `ad_policy_categories`;
CREATE TABLE `ad_policy_categories` (
  `id`                 BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT '主键',
  `category_code`      VARCHAR(32)      NOT NULL COMMENT '类别代码（如 alcohol / gambling）',
  `category_name`      VARCHAR(64)      NOT NULL COMMENT '中文名',
  `category_name_en`   VARCHAR(64)      NOT NULL COMMENT '英文名',
  `restriction_level`  VARCHAR(16)      NOT NULL COMMENT 'restricted / prohibited',
  `description`        TEXT             DEFAULT NULL COMMENT '政策说明',
  `allowed_regions`    JSON             DEFAULT NULL COMMENT '允许投放的国家代码',
  `blocked_regions`    JSON             DEFAULT NULL COMMENT '禁止的国家代码',
  `age_targeting`      VARCHAR(16)      DEFAULT NULL COMMENT '年龄定位："18+" / "21+"',
  `requires_cert`      TINYINT(1)       NOT NULL DEFAULT 0 COMMENT '是否需要 Google 认证',
  `ad_copy_rules`      JSON             DEFAULT NULL COMMENT '文案生成约束（给 AI 的规则）',
  `landing_page_rules` JSON             DEFAULT NULL COMMENT '着陆页要求',
  `match_keywords`     JSON             DEFAULT NULL COMMENT '自动匹配关键词列表',
  `match_domains`      JSON             DEFAULT NULL COMMENT '自动匹配域名列表',
  `sort_order`         SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '排序',
  `is_deleted`         TINYINT(1)       NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`         DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_category_code` (`category_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Google Ads 政策限制类别';

-- -----------------------------------------------------------
-- 29. 商家政策审核记录表
-- -----------------------------------------------------------
DROP TABLE IF EXISTS `merchant_policy_reviews`;
CREATE TABLE `merchant_policy_reviews` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
  `merchant_name`      VARCHAR(255)    NOT NULL COMMENT '商家名称',
  `merchant_domain`    VARCHAR(255)    DEFAULT NULL COMMENT '商家域名',
  `platform`           VARCHAR(8)      DEFAULT NULL COMMENT '平台代码',
  `policy_category_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '匹配到的政策类别 id',
  `policy_status`      VARCHAR(16)     NOT NULL DEFAULT 'clean' COMMENT 'clean / restricted / prohibited',
  `matched_rule`       VARCHAR(128)    DEFAULT NULL COMMENT '匹配到的关键词/规则',
  `review_method`      VARCHAR(16)     NOT NULL DEFAULT 'auto' COMMENT 'auto / manual',
  `reviewed_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '审核时间',
  `notes`              TEXT            DEFAULT NULL COMMENT '备注',
  `is_deleted`         TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '软删除',
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_merchant_platform` (`merchant_name`, `platform`),
  KEY `idx_policy_status` (`policy_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商家政策审核记录（自动检测 + 人工审核）';

SET FOREIGN_KEY_CHECKS = 1;
