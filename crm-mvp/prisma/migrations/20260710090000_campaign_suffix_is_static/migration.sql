-- 「静态后缀」系列标记（补货观测自动学习）。
-- 1=该商家落地页参数不随会话变化（无 per-click clickid/token），每次生成内容都与库存重复，
-- 库存天然无法超过「不同内容数」（通常为 1）。这是商家链接特性而非补货故障：
-- 补货侧已按 static_suffix 长冷却处理，此字段供前端库存列区分显示，不再按低水位误标红。
-- 补货产出新内容（商家换了带 token 的链接）时自动清 0。
ALTER TABLE `campaigns` ADD COLUMN `suffix_is_static` TINYINT NOT NULL DEFAULT 0;
