-- Token 冷却状态落库：重启后回灌内存 cooldownUntil，不再对已限流/耗尽的 token 撞墙
ALTER TABLE `team_developer_tokens`
  ADD COLUMN `cooldown_until` DATETIME(0) NULL;
