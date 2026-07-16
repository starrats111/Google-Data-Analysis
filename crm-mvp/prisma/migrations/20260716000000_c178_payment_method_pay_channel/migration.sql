-- C-178: 收款方式拆分「打款方式」字段
-- payee_name 原为「名字(银行)」组合文本（半角/全角括号混用），
-- 拆为 payee_name=纯名字 + pay_channel=打款方式（括号内容）。

ALTER TABLE `payment_methods`
  ADD COLUMN `pay_channel` VARCHAR(64) NOT NULL DEFAULT '' AFTER `payee_name`;

-- 存量数据：半角括号「龚建成(农业)」
UPDATE `payment_methods`
SET `pay_channel` = TRIM(TRAILING ')' FROM SUBSTRING_INDEX(`payee_name`, '(', -1)),
    `payee_name`  = TRIM(SUBSTRING_INDEX(`payee_name`, '(', 1))
WHERE `payee_name` LIKE '%(%)';

-- 存量数据：全角括号「张文俊（工商）」
UPDATE `payment_methods`
SET `pay_channel` = TRIM(TRAILING '）' FROM SUBSTRING_INDEX(`payee_name`, '（', -1)),
    `payee_name`  = TRIM(SUBSTRING_INDEX(`payee_name`, '（', 1))
WHERE `payee_name` LIKE '%（%）';
