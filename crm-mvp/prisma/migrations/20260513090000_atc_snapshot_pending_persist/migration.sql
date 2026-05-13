-- C-094.2 给 atc_advertiser_domain_snapshot 加两列：
--   qualifying_domain_count: C-094.1 已在写入时算好，但之前没落库；现在持久化方便排查 + 后续直接查询
--   ocr_pending: 本快照写入时是否还有 OCR 任务未完成；true 时 service 重读返回 classification=pending
-- 不破坏旧数据，新列默认 0；新写入会刷新这两个字段

ALTER TABLE `atc_advertiser_domain_snapshot`
  ADD COLUMN `qualifying_domain_count` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `unique_domain_count`,
  ADD COLUMN `ocr_pending` TINYINT NOT NULL DEFAULT 0 AFTER `domains_json`;
