-- C-061: 广告系列最终到达网址后缀
-- 为 campaigns 表添加 final_url_suffix 字段，存储 UTM 等追踪参数后缀
ALTER TABLE `campaigns`
  ADD COLUMN `final_url_suffix` VARCHAR(500) NULL COMMENT '最终到达网址后缀（附加到落地页 URL 末尾的 UTM 参数等）' AFTER `suffix_click_checkpoint_at`;
