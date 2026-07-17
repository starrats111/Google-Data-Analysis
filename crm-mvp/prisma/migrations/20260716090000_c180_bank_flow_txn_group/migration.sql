-- C-180: 同一笔银行到账（如 BSH+CG 一起提现）按平台拆分成多条流水，
-- 拆分出的条目共享 txn_group 组号，导出「账户交易明细清单」时合并回一笔与真实银行对账。
-- 旧数据/单平台条目保持 NULL，行为完全不变。
ALTER TABLE `bank_flow_entries`
  ADD COLUMN `txn_group` VARCHAR(32) NULL AFTER `platform`;
