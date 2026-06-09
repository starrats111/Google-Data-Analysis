-- LAND-01: 用户手动设定的落地页加锁，生成/提交时不再被 ccTLD 兜底 / C-016 本地化 / D-096 落地域校正 自动改写
ALTER TABLE `ad_creatives`
  ADD COLUMN `final_url_locked` TINYINT NOT NULL DEFAULT 0 COMMENT '1=用户手动设定落地页，自动改写跳过' AFTER `final_url`;
