#!/bin/bash
# D-365 探查3：用正确表名 ad_creation_drafts 重查竞品引擎产出
# 只读。
Q() { sudo mysql google-data-analysis -t -e "$1"; }

echo "===== A. ad_creation_drafts 总览 ====="
Q "SELECT COUNT(*) AS 草稿总数,
          SUM(status='draft_ready') AS 已就绪,
          SUM(campaign_id IS NOT NULL) AS 已关联系列,
          MIN(created_at) AS 最早, MAX(created_at) AS 最晚
   FROM ad_creation_drafts WHERE is_deleted = 0;"

echo "===== B. 按状态与人分布 ====="
Q "SELECT u.username, d.status, COUNT(*) AS 条数, MAX(d.created_at) AS 最近
   FROM ad_creation_drafts d LEFT JOIN users u ON u.id = d.user_id
   WHERE d.is_deleted = 0
   GROUP BY u.username, d.status ORDER BY 最近 DESC LIMIT 20;"

echo "===== C. 竞品引擎真正发出去的系列：后缀现状（核心） ====="
Q "SELECT c.google_status,
          COUNT(*) AS 条数,
          SUM(c.final_url_suffix IS NULL OR TRIM(c.final_url_suffix)='') AS 库里无后缀,
          SUM(c.final_url_suffix IS NOT NULL AND TRIM(c.final_url_suffix)<>'') AS 库里有后缀,
          SUM(c.suffix_last_apply_at IS NULL) AS 从未换链
   FROM ad_creation_drafts d
   JOIN campaigns c ON c.id = d.campaign_id AND c.is_deleted = 0
   WHERE d.is_deleted = 0 AND c.google_campaign_id IS NOT NULL
   GROUP BY c.google_status ORDER BY 条数 DESC;"

echo "===== D. 竞品引擎系列逐条（含未提交的，看全貌） ====="
Q "SELECT d.id AS draft_id, d.status AS draft_status, u.username,
          c.id AS campaign_id, c.google_campaign_id, c.google_status,
          LEFT(c.campaign_name,38) AS campaign_name,
          c.suffix_last_apply_at,
          IFNULL(LEFT(c.final_url_suffix,46),'(空)') AS suffix_db
   FROM ad_creation_drafts d
   LEFT JOIN campaigns c ON c.id = d.campaign_id AND c.is_deleted = 0
   LEFT JOIN users u ON u.id = d.user_id
   WHERE d.is_deleted = 0
   ORDER BY d.created_at DESC LIMIT 30;"

echo "===== E. 待补 15 条里，哪些是竞品引擎来的 ====="
Q "SELECT c.id, u.username,
          CASE WHEN d.id IS NULL THEN 'evidence' ELSE 'rival_intel' END AS 引擎,
          LEFT(c.campaign_name,40) AS campaign_name
   FROM campaigns c
   JOIN users u ON u.id = c.user_id
   LEFT JOIN ad_creation_drafts d ON d.campaign_id = c.id AND d.is_deleted = 0
   WHERE c.is_deleted = 0
     AND c.google_campaign_id IS NOT NULL
     AND c.google_status = 'ENABLED'
     AND c.suffix_last_apply_at IS NULL
     AND c.final_url_suffix IS NOT NULL AND TRIM(c.final_url_suffix) <> ''
   ORDER BY 引擎, u.username, c.id;"

echo "===== F. 反向核对：竞品引擎系列中「Google 上该有后缀却没有」的真实敞口 ====="
echo "（库里有后缀 + 从未换链 + 已提交 ⇒ Google 上是空的）"
Q "SELECT c.google_status, COUNT(*) AS 条数,
          GROUP_CONCAT(c.id ORDER BY c.id SEPARATOR ',') AS campaign_ids
   FROM ad_creation_drafts d
   JOIN campaigns c ON c.id = d.campaign_id AND c.is_deleted = 0
   WHERE d.is_deleted = 0
     AND c.google_campaign_id IS NOT NULL
     AND c.suffix_last_apply_at IS NULL
     AND c.final_url_suffix IS NOT NULL AND TRIM(c.final_url_suffix) <> ''
   GROUP BY c.google_status;"
