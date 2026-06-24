-- 团队隐私开关：组长控制本组成员能否查看其他组的投放情况
-- 0=关闭（默认，仅本组可见）；1=开启（本组成员可查看其他组投放情况）
ALTER TABLE `teams` ADD COLUMN `cross_team_visible` TINYINT NOT NULL DEFAULT 0;
