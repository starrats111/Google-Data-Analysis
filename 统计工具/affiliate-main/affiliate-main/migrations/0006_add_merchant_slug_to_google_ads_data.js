/**
 * 迁移: 为 google_ads_data 表添加 merchant_slug 字段
 * 目的: 支持通过 merchant_slug + affiliate_name 匹配广告数据与订单数据
 */

module.exports = {
  up: (db) => {
    console.log('⬆️  执行迁移: 添加 merchant_slug 到 google_ads_data 表');

    // 添加 merchant_slug 字段
    db.prepare(`
      ALTER TABLE google_ads_data
      ADD COLUMN merchant_slug TEXT
    `).run();

    // 创建索引以提升查询性能
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_google_ads_data_merchant_slug
      ON google_ads_data(merchant_slug)
    `).run();

    // 创建复合索引用于商家汇总匹配 (merchant_slug + affiliate_name)
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_google_ads_data_merchant_affiliate
      ON google_ads_data(merchant_slug, affiliate_name)
    `).run();

    console.log('✅ 迁移成功: merchant_slug 字段已添加到 google_ads_data 表');
  },

  down: (db) => {
    console.log('⬇️  回滚迁移: 移除 google_ads_data 表的 merchant_slug 字段');

    // SQLite 不支持 DROP COLUMN,需要重建表
    db.prepare(`
      CREATE TABLE google_ads_data_backup AS SELECT
        id, user_id, sheet_id, date, campaign_name, affiliate_name, merchant_id,
        campaign_budget, currency, impressions, clicks, cost,
        created_at, updated_at
      FROM google_ads_data
    `).run();

    db.prepare(`DROP TABLE google_ads_data`).run();
    db.prepare(`ALTER TABLE google_ads_data_backup RENAME TO google_ads_data`).run();

    // 重建索引
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_google_ads_data_user_id ON google_ads_data(user_id);
      CREATE INDEX IF NOT EXISTS idx_google_ads_data_date ON google_ads_data(date);
      CREATE INDEX IF NOT EXISTS idx_google_ads_data_affiliate ON google_ads_data(affiliate_name);
      CREATE INDEX IF NOT EXISTS idx_google_ads_data_merchant ON google_ads_data(merchant_id);
    `).run();

    console.log('✅ 回滚成功');
  }
};
