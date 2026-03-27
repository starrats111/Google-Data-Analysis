-- 修复重复 campaign 记录导致花费重复计算的问题
-- 1. 找到重复的 campaign（同 user_id + google_campaign_id，保留有 customer_id 的 / id 最大的）
-- 2. 将重复记录的 ads_daily_stats 迁移到主记录（仅迁移主记录没有的日期数据）
-- 3. 软删除重复的 campaign 记录

-- Step 1: 将重复 campaign 的 stats 中，主记录缺失的日期数据迁移过去
UPDATE ads_daily_stats s
JOIN (
  SELECT s2.id as stats_id, keeper.id as keeper_campaign_id
  FROM campaigns dupe
  JOIN campaigns keeper ON keeper.user_id = dupe.user_id
    AND keeper.google_campaign_id = dupe.google_campaign_id
    AND keeper.is_deleted = 0
    AND keeper.id != dupe.id
    AND (
      (keeper.customer_id IS NOT NULL AND keeper.customer_id != '' AND (dupe.customer_id IS NULL OR dupe.customer_id = ''))
      OR (keeper.id > dupe.id AND (keeper.customer_id IS NOT NULL AND keeper.customer_id != '') = (dupe.customer_id IS NOT NULL AND dupe.customer_id != ''))
    )
  JOIN ads_daily_stats s2 ON s2.campaign_id = dupe.id
  LEFT JOIN ads_daily_stats s_existing ON s_existing.campaign_id = keeper.id AND s_existing.date = s2.date
  WHERE dupe.is_deleted = 0
    AND dupe.google_campaign_id IS NOT NULL
    AND s_existing.id IS NULL
) migrate ON s.id = migrate.stats_id
SET s.campaign_id = migrate.keeper_campaign_id;

-- Step 2: 软删除多余的 ads_daily_stats（主记录已有该日期数据的）
UPDATE ads_daily_stats s
JOIN (
  SELECT s2.id as stats_id
  FROM campaigns dupe
  JOIN campaigns keeper ON keeper.user_id = dupe.user_id
    AND keeper.google_campaign_id = dupe.google_campaign_id
    AND keeper.is_deleted = 0
    AND keeper.id != dupe.id
    AND (
      (keeper.customer_id IS NOT NULL AND keeper.customer_id != '' AND (dupe.customer_id IS NULL OR dupe.customer_id = ''))
      OR (keeper.id > dupe.id AND (keeper.customer_id IS NOT NULL AND keeper.customer_id != '') = (dupe.customer_id IS NOT NULL AND dupe.customer_id != ''))
    )
  JOIN ads_daily_stats s2 ON s2.campaign_id = dupe.id
  WHERE dupe.is_deleted = 0
    AND dupe.google_campaign_id IS NOT NULL
) leftover ON s.id = leftover.stats_id
SET s.is_deleted = 1;

-- Step 3: 软删除重复的 campaign 记录
UPDATE campaigns dupe
JOIN campaigns keeper ON keeper.user_id = dupe.user_id
  AND keeper.google_campaign_id = dupe.google_campaign_id
  AND keeper.is_deleted = 0
  AND keeper.id != dupe.id
  AND (
    (keeper.customer_id IS NOT NULL AND keeper.customer_id != '' AND (dupe.customer_id IS NULL OR dupe.customer_id = ''))
    OR (keeper.id > dupe.id AND (keeper.customer_id IS NOT NULL AND keeper.customer_id != '') = (dupe.customer_id IS NOT NULL AND dupe.customer_id != ''))
  )
SET dupe.is_deleted = 1
WHERE dupe.is_deleted = 0
  AND dupe.google_campaign_id IS NOT NULL;

-- Step 4: 补充主记录缺失的 customer_id（从已软删除的重复记录获取）
UPDATE campaigns c
JOIN (
  SELECT c2.google_campaign_id, c2.user_id, MAX(d.customer_id) as cid
  FROM campaigns d
  WHERE d.is_deleted = 1 AND d.customer_id IS NOT NULL AND d.customer_id != ''
    AND d.google_campaign_id IS NOT NULL
  GROUP BY d.google_campaign_id, d.user_id
) src ON c.google_campaign_id = src.google_campaign_id AND c.user_id = src.user_id
SET c.customer_id = src.cid
WHERE c.is_deleted = 0 AND (c.customer_id IS NULL OR c.customer_id = '');
