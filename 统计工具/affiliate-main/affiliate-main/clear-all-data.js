// 清除数据库所有记录，保留表结构
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));

console.log('\n' + '='.repeat(80));
console.log('⚠️  警告：即将清除数据库所有记录！');
console.log('='.repeat(80) + '\n');

// 获取所有表
const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='table'
  AND name NOT LIKE 'sqlite_%'
`).all();

console.log(`数据库中共有 ${tables.length} 个表:\n`);

// 显示每个表的记录数
console.log('【清除前的数据统计】');
tables.forEach(table => {
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
  console.log(`  ${table.name}: ${count.count} 条记录`);
});

console.log('\n开始清除数据...\n');

// 禁用外键约束（清除数据时）
db.exec('PRAGMA foreign_keys = OFF');

let totalDeleted = 0;

// 清除每个表的数据
tables.forEach(table => {
  const tableName = table.name;

  try {
    const beforeCount = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get().count;

    if (beforeCount > 0) {
      // 删除所有记录
      db.prepare(`DELETE FROM ${tableName}`).run();

      // 重置自增ID
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(tableName);

      console.log(`✅ ${tableName}: 已清除 ${beforeCount} 条记录`);
      totalDeleted += beforeCount;
    } else {
      console.log(`⏭️  ${tableName}: 本来就没有数据`);
    }
  } catch (error) {
    console.error(`❌ ${tableName}: 清除失败 - ${error.message}`);
  }
});

// 重新启用外键约束
db.exec('PRAGMA foreign_keys = ON');

console.log('\n' + '='.repeat(80));
console.log(`✅ 清除完成！共删除 ${totalDeleted} 条记录`);
console.log('='.repeat(80) + '\n');

// 验证清除结果
console.log('【清除后的数据统计】');
tables.forEach(table => {
  const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
  console.log(`  ${table.name}: ${count.count} 条记录`);
});

console.log('\n💡 提示：表结构已保留，可以重新开始测试了！\n');

db.close();
