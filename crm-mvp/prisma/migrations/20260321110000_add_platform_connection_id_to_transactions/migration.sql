-- AlterTable: add platform_connection_id to affiliate_transactions
ALTER TABLE `affiliate_transactions` ADD COLUMN `platform_connection_id` BIGINT UNSIGNED NULL;

-- CreateIndex
CREATE INDEX `idx_platform_conn` ON `affiliate_transactions`(`platform_connection_id`);
