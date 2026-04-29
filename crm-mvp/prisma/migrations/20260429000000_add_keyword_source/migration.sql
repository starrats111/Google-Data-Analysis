-- C-057: 关键词来源字段
-- 为 keywords 表添加 source 字段，记录关键词来源（semrush_paid / ai_generated / NULL=旧数据）
ALTER TABLE `keywords`
  ADD COLUMN `source` VARCHAR(32) NULL AFTER `suggested_bid`;
