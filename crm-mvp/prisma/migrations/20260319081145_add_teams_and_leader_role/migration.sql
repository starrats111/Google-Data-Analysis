-- AlterTable
ALTER TABLE `users` ADD COLUMN `display_name` VARCHAR(50) NULL,
    ADD COLUMN `team_id` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `teams` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `team_code` VARCHAR(20) NOT NULL,
    `team_name` VARCHAR(50) NOT NULL,
    `leader_id` BIGINT UNSIGNED NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_team_code`(`team_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `idx_team_id` ON `users`(`team_id`);
