-- 用户自助调节「换链脚本轮询间隔(秒)」
-- NULL = 用默认 15；脚本启动经 /api/v1/suffix/script-config 读取该用户值，改后下轮自动生效（无需重发脚本）
ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `script_loop_interval_seconds` SMALLINT UNSIGNED NULL
  COMMENT '换链脚本轮询间隔(秒)，用户自助调节；NULL=默认15';
