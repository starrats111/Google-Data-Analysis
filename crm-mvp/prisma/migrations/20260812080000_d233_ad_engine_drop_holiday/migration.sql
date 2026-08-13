-- D-233：kyads 上广告能力并入 CRM
--   1) ad_default_settings 新增 ad_engine（上广告引擎选择，存员工级默认值）
--   2) 节日营销整体下线：删 holiday_calendar 表、删 user_merchants.holiday_name

-- AlterTable
ALTER TABLE `ad_default_settings`
    ADD COLUMN `ad_engine` VARCHAR(32) NOT NULL DEFAULT 'evidence';

-- AlterTable
ALTER TABLE `user_merchants` DROP COLUMN `holiday_name`;

-- DropTable
DROP TABLE `holiday_calendar`;
