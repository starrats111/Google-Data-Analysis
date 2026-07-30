-- D-201 治「广告系列静默死」：把 alive_no_tracking 的连续轮次计数落库。
--
-- 病灶（214-LB2-jwpei-US-0724-286135 实测连续 5 天、约 130 次/天全部白跑且零告警）：
--   1) handleProbeFailure 的 alive_no_tracking 分支调用 setFailCooldown(campaign, 0, ...)，
--      把疑似死链计数**重置为 0**（设计意图：落到官网根域名说明链接活着，换出口重试即可）。
--      于是「永久拿不到追踪参数」的系列永远升不到 invalid_link，只在 30 分钟活链冷却里无限重试。
--   2) 现有 6 类告警没有一类覆盖这种失败，该系列 5 天只有一条 7-28 的旧 link_forbidden。
--
-- 本字段独立于 suffix_fail_count：后者语义是「连域名都不匹配的硬失败」，判定为活链时**必须**清零，
-- 不能拿它兼职计数，否则会破坏 D-177 的三态分类。达阈值后升级长冷却并报 no_tracking_stuck。
ALTER TABLE `campaigns`
  ADD COLUMN `suffix_no_tracking_streak` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `suffix_fail_count`;
