-- R-07: 银行流水条目记录预填来源批次日（平台实际打款日），
-- 预填时排除已登记过的批次，避免同一批打款被重复预填
ALTER TABLE `bank_flow_entries`
  ADD COLUMN `source_date` DATE NULL AFTER `platform`;
