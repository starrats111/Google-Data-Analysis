/**
 * 迁移: 为 orders 表添加 affiliate_name 字段
 * 目的: 支持通过 merchant_slug + affiliate_name 匹配订单与广告数据
 */

module.exports = {
  up: (db) => {
    console.log('⬆️  执行迁移: 添加 affiliate_name 到 orders 表');

    // 1. 添加 affiliate_name 字段
    db.prepare(`
      ALTER TABLE orders
      ADD COLUMN affiliate_name TEXT
    `).run();

    // 2. 创建索引以提升查询性能
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_orders_affiliate_name
      ON orders(affiliate_name)
    `).run();

    // 3. 创建复合索引用于商家汇总匹配 (merchant_slug + affiliate_name)
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_orders_merchant_affiliate
      ON orders(merchant_slug, affiliate_name)
    `).run();

    console.log('✅ 迁移成功: affiliate_name 字段已添加到 orders 表');
  },

  down: (db) => {
    console.log('⬇️  回滚迁移: 移除 orders 表的 affiliate_name 字段');

    // SQLite 不支持 DROP COLUMN,需要重建表
    db.prepare(`
      CREATE TABLE orders_backup AS SELECT
        id, user_id, platform_account_id, order_id, merchant_id,
        merchant_name, merchant_slug, order_amount, commission, status,
        order_date, confirm_date, raw_data, collected_at, created_at, updated_at
      FROM orders
    `).run();

    db.prepare(`DROP TABLE orders`).run();
    db.prepare(`ALTER TABLE orders_backup RENAME TO orders`).run();

    // 重建索引
    db.prepare(`
      CREATE UNIQUE INDEX idx_orders_platform_order
      ON orders(platform_account_id, order_id)
    `).run();

    console.log('✅ 回滚成功');
  }
};
