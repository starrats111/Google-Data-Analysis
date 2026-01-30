// 测试同步 API 的日期范围问题

const endDate = new Date();
const startDate = new Date();
startDate.setFullYear(endDate.getFullYear() - 1);

console.log('当前日期:', endDate.toISOString().split('T')[0]);
console.log('开始日期 (1年前):', startDate.toISOString().split('T')[0]);
console.log();

// 检查数据库中订单的日期范围
const Database = require('better-sqlite3');
const db = new Database('./data.db');

const dateRange = db.prepare(`
  SELECT 
    MIN(order_date) as min_date,
    MAX(order_date) as max_date,
    COUNT(*) as total
  FROM orders
  WHERE platform_account_id IN (2, 5, 13)
    AND status = 'Approved'
`).get();

console.log('数据库中订单日期范围:');
console.log('  最早:', dateRange.min_date);
console.log('  最晚:', dateRange.max_date);
console.log('  总数:', dateRange.total);
console.log();

// 检查有 settlement_date 的订单
const settlementRange = db.prepare(`
  SELECT 
    MIN(settlement_date) as min_date,
    MAX(settlement_date) as max_date,
    COUNT(*) as total
  FROM orders
  WHERE platform_account_id IN (2, 5, 13)
    AND status = 'Approved'
    AND settlement_date IS NOT NULL
`).get();

console.log('有 settlement_date 的订单:');
console.log('  最早:', settlementRange.min_date);
console.log('  最晚:', settlementRange.max_date);
console.log('  总数:', settlementRange.total);
console.log();

// 检查是否在同步日期范围内
const inRange = db.prepare(`
  SELECT COUNT(*) as count
  FROM orders
  WHERE platform_account_id IN (2, 5, 13)
    AND status = 'Approved'
    AND order_date >= ?
    AND order_date <= ?
`).get(startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]);

console.log(`在同步日期范围内的订单: ${inRange.count}`);

db.close();
