-- D-168：联盟连接账号位次（07 规则：同用户同平台第 1 个账号=1、第 2 个=2；
-- 删除释放位次，新账号补最小空缺）。系列名平台段序号（LH2）据此映射到具体连接。
ALTER TABLE `platform_connections` ADD COLUMN `account_index` INT UNSIGNED NULL;

-- 存量回填：存活连接按 (user_id, platform) 内 created_at, id 升序编 1..n；已删连接不占位。
UPDATE `platform_connections` pc
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, platform ORDER BY created_at, id) AS rn
  FROM `platform_connections`
  WHERE is_deleted = 0
) t ON t.id = pc.id
SET pc.account_index = t.rn;
