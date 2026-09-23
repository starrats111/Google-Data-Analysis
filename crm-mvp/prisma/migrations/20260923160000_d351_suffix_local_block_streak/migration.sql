-- D-351 连续「本机资源开不出浏览器」轮次
-- local_resource（内存反压 low_memory / 抢不到 puppeteer 槽位）按 D-231 不得累加死链计数，
-- 但也因此没有任何计数能让 force 路径停下来：库存恒 0 → lease NO_STOCK → force 穿透冷却 →
-- 内存仍不够 → 循环。达阈值后由 evaluateCooldownGate 挡住 force（人工入口仍可穿透）。
ALTER TABLE `campaigns`
  ADD COLUMN `suffix_local_block_streak` INT UNSIGNED NOT NULL DEFAULT 0
  AFTER `suffix_cooldown_until`;
