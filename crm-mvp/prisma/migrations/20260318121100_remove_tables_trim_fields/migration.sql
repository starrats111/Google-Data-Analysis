-- 功能筛检：删除 3 张冗余表 + 精简字段
-- 删除表：exchange_rates, ai_insights, crawl_tasks
-- 精简字段：ads_daily_stats, ad_creatives, articles

-- DropTable
DROP TABLE IF EXISTS `exchange_rates`;

-- DropTable
DROP TABLE IF EXISTS `ai_insights`;

-- DropTable
DROP TABLE IF EXISTS `crawl_tasks`;

-- AlterTable: ads_daily_stats — 删除 budget, roas, original_currency, exchange_rate
ALTER TABLE `ads_daily_stats`
    DROP COLUMN `budget`,
    DROP COLUMN `roas`,
    DROP COLUMN `original_currency`,
    DROP COLUMN `exchange_rate`;

-- AlterTable: ad_creatives — 删除 logo_url, selling_points
ALTER TABLE `ad_creatives`
    DROP COLUMN `logo_url`,
    DROP COLUMN `selling_points`;

-- AlterTable: articles — 删除 campaign_id, images
ALTER TABLE `articles`
    DROP COLUMN `campaign_id`,
    DROP COLUMN `images`;
