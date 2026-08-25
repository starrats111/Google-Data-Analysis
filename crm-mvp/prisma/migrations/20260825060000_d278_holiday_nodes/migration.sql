-- D-278：海外节点推荐投放
-- ① merchant_recommendations 加 node_code（source='node' 的节点清单行专用）
ALTER TABLE `merchant_recommendations`
  ADD COLUMN `node_code` VARCHAR(32) NULL;

CREATE INDEX `idx_rec_node_code` ON `merchant_recommendations`(`node_code`);

-- ② 节点日历表
CREATE TABLE `holiday_nodes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(32) NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `node_date` DATE NOT NULL,
  `countries` VARCHAR(255) NULL,
  `lead_days` INT UNSIGNED NOT NULL DEFAULT 30,
  `categories` JSON NULL,
  `description` VARCHAR(512) NULL,
  `enabled` TINYINT NOT NULL DEFAULT 1,
  `notified_at` DATETIME(0) NULL,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  UNIQUE INDEX `uk_node_code`(`code`),
  INDEX `idx_node_enabled_date`(`enabled`, `node_date`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ③ 预置常见海外节点（07 第 2 问拍板：一次性预置，哪怕暂时没有推荐清单）
--    日期为 2026-2027 届真实日历日，节点过后管理员在管理页改下一届日期即可
INSERT INTO `holiday_nodes` (`code`, `name`, `node_date`, `countries`, `lead_days`, `description`) VALUES
  ('halloween',      '万圣节',           '2026-10-31', 'US,GB,CA',          30, '服饰道具/派对用品/糖果礼品旺季'),
  ('thanksgiving',   '感恩节',           '2026-11-26', 'US',                30, '美国家庭消费旺季，黑五前哨'),
  ('black_friday',   '黑色星期五',       '2026-11-27', NULL,                30, '全年最大促销节点，欧美全线电商参与'),
  ('cyber_monday',   '网络星期一',       '2026-11-30', NULL,                30, '黑五后的线上促销高峰，电子/软件类突出'),
  ('christmas',      '圣诞节',           '2026-12-25', NULL,                30, '礼品/玩具/家居/服饰全品类旺季'),
  ('boxing_day',     '节礼日',           '2026-12-26', 'GB,CA,AU',          21, '英联邦国家年末清仓促销'),
  ('new_year',       '新年',             '2027-01-01', NULL,                21, '健身/软件订阅/自我提升类新年决心消费'),
  ('valentines_day', '情人节',           '2027-02-14', NULL,                30, '珠宝/鲜花/礼品/美妆旺季'),
  ('easter',         '复活节',           '2027-03-28', 'US,GB,DE,FR,IT,ES,AU', 21, '春季礼品/糖果/家庭消费'),
  ('mothers_day',    '母亲节（美加澳）', '2027-05-09', 'US,CA,AU',          30, '鲜花/珠宝/美妆/礼品旺季'),
  ('fathers_day',    '父亲节（美英加）', '2027-06-20', 'US,GB,CA',          21, '工具/电子/户外/服饰类礼品'),
  ('back_to_school', '返校季',           '2027-08-01', 'US,GB,CA',          30, '文具/电脑/服饰/宿舍用品，持续到 9 月初');
