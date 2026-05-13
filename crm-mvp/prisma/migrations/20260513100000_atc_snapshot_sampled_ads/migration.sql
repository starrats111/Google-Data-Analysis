-- C-094.3 给 atc_advertiser_domain_snapshot 加 sampled_ads_json 列：
-- 存放本次 SerpApi 采样的 ad creatives（image + first_shown + last_shown）
-- 这样下次 cache 命中且 ocr_pending=1 时，可以直接复用采样列表重查 OCR cache 重算分类
-- 而不必再消耗一次 SerpApi quota

ALTER TABLE `atc_advertiser_domain_snapshot`
  ADD COLUMN `sampled_ads_json` JSON NULL AFTER `ocr_pending`;
