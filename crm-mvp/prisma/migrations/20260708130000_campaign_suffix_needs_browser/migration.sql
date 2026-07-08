-- 「必须无头浏览器才能跟链」系列标记（生成成功时按 usedBrowser 自动学习）。
-- 1=纯 HTTP 跟不到、每条后缀都要跑整页浏览器（流量为纯 HTTP 的几十倍），
-- 补货侧对此类系列用更低目标库存/更低水位/更长冷却，压低 kookeey 代理流量消耗。
ALTER TABLE `campaigns` ADD COLUMN `suffix_needs_browser` TINYINT NOT NULL DEFAULT 0;
