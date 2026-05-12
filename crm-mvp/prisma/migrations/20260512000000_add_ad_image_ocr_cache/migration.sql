-- C-088: OCR 投放域名提取缓存表
-- 维度：(image_url)，跨用户/跨商家全局共享，避免重复 OCR

CREATE TABLE `ad_image_ocr_cache` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `image_url`         VARCHAR(768) NOT NULL,
  -- status 取值：pending / processing / success / failed / permanent_failure（应用层枚举）
  `status`            VARCHAR(20) NOT NULL DEFAULT 'pending',
  `extracted_domain`  VARCHAR(255) NULL,
  `raw_output`        VARCHAR(512) NULL,
  `tries`             INT UNSIGNED NOT NULL DEFAULT 0,
  `last_error`        VARCHAR(512) NULL,
  `model_used`        VARCHAR(64) NULL,
  `prompt_tokens`     INT UNSIGNED NULL,
  `completion_tokens` INT UNSIGNED NULL,
  `lock_at`           DATETIME NULL,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_image_url` (`image_url`),
  KEY `idx_status_lock` (`status`, `lock_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- C-088 seed: 注册 OCR 场景模型（动态查 provider_id 避免硬编码 id 跨环境失效）
INSERT IGNORE INTO `ai_model_configs` (`scene`, `provider_id`, `model_name`, `max_tokens`, `temperature`, `is_active`, `priority`)
SELECT 'domain_ocr', `id`, '[按次]gpt-4o', 64, 0.00, 1, 1
FROM `ai_providers`
WHERE `provider_name` = '大肘子' AND `is_deleted` = 0
LIMIT 1;

-- C-088 seed: 全局开关 + 配置参数
INSERT IGNORE INTO `system_configs` (`config_key`, `config_value`, `description`) VALUES
  ('ocr_domain_extract_enabled', '1',   'C-088: OCR 投放域名提取总开关 (1=启用, 0=禁用)'),
  ('ocr_max_tries',              '3',   'C-088: 单条 image_url 最多重试次数'),
  ('ocr_worker_batch_size',      '5',   'C-088: cron 每次拉取的 pending 数'),
  ('ocr_worker_concurrent',      '3',   'C-088: worker 并发数（不超过 batch_size）'),
  ('ocr_processing_timeout_sec', '120', 'C-088: processing 状态超过该秒数视为僵尸，重置为 pending');
