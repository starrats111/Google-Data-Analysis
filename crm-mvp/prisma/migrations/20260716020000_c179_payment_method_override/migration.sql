-- C-179: 打款记录逐笔修正打款方式
-- NULL = 跟随账号实时绑定；有值 = 该笔按此收款方式展示/对账（治月中换绑串改历史笔）

ALTER TABLE `affiliate_payments`
  ADD COLUMN `payment_method_id_override` BIGINT UNSIGNED NULL AFTER `payment_type`;
