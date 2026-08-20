-- D-256 (2026-08-20): v2.1 "valid peer" rule for advertiser classification.
-- Store the classification verdict (peer/brand_self/pending/unknown) on the snapshot row
-- so list APIs (e.g. discoverable advertisers) can filter at SQL level.
-- NULL = legacy snapshot written under the old qualifying-domain rule; service layer
-- treats those as stale (epoch gate) and refetches via the free direct ATC RPC.
ALTER TABLE `atc_advertiser_domain_snapshot`
  ADD COLUMN `classification` VARCHAR(16) NULL AFTER `sampled_ads_json`,
  ADD INDEX `idx_classification` (`classification`);
