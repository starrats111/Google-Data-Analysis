-- D-273.4 竞品创意文案识图：图片级文案缓存 + 独立 AI 场景
--
-- 为什么不复用 ad_image_ocr_cache：该表的 status='success' 在 atc-service 与 active-domains
-- 路由里被当作「域名已识别」的语义读取，往里塞文案会污染既有判定。独立表零回归。
--
-- 缓存粒度 = image_url（跨用户跨域名全局共享），同一张广告归档图永不重复识别。

CREATE TABLE `ad_creative_copy_cache` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `image_url` VARCHAR(768) NOT NULL,
  -- success=识出文案；empty=识图成功但图内无可用文案；shopping=商品网格购物广告（无标题描述结构）；failed=识别失败
  `status` VARCHAR(20) NOT NULL DEFAULT 'success',
  `headlines` JSON NULL,
  `descriptions` JSON NULL,
  -- 模型在图上读到的网址，用于与 SerpApi 的 target_domain 核对，检测批量识图串位
  `seen_url` VARCHAR(255) NULL,
  `model_used` VARCHAR(64) NULL,
  `last_error` VARCHAR(512) NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_copy_image_url` (`image_url`),
  INDEX `idx_copy_status` (`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 独立 AI 场景，便于日后单独换模型而不影响域名识别（domain_ocr）。
-- 用 SELECT 从 domain_ocr 复制 provider/model，避免在迁移里硬编码凭证归属；
-- max_tokens 放大到 8000（20 张一批实测输出约 1700 tokens，留足余量），temperature=0 求稳定。
INSERT INTO `ai_model_configs` (`scene`, `provider_id`, `model_name`, `max_tokens`, `temperature`, `is_active`, `priority`, `is_deleted`)
SELECT 'creative_copy_ocr', `provider_id`, `model_name`, 8000, 0.00, 1, 1, 0
  FROM `ai_model_configs`
 WHERE `scene` = 'domain_ocr' AND `is_active` = 1 AND `is_deleted` = 0
 ORDER BY `priority` ASC
 LIMIT 1;
