#!/usr/bin/env node

const Database = require('better-sqlite3');
const fs = require('fs');

console.log('🔍 部署前验证检查\n');
console.log('='.repeat(60));

let allChecks = true;

// 1. 检查数据库
console.log('\n1️⃣  检查数据库...');
try {
  const db = new Database('./data.db');
  
  // 检查表结构
  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name IN ('orders', 'withdrawal_requests', 'withdrawal_history')
  `).all();
  
  if (tables.length === 3) {
    console.log('   ✅ 数据库表结构正确');
  } else {
    console.log('   ❌ 缺少必要的表');
    allChecks = false;
  }
  
  // 检查 orders 表字段
  const columns = db.prepare(`PRAGMA table_info(orders)`).all();
  const requiredColumns = ['settlement_id', 'settlement_date', 'paid_date', 'payment_id'];
  const hasAllColumns = requiredColumns.every(col => 
    columns.some(c => c.name === col)
  );
  
  if (hasAllColumns) {
    console.log('   ✅ orders 表字段完整');
  } else {
    console.log('   ❌ orders 表缺少必要字段');
    allChecks = false;
  }
  
  // 检查数据
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'Approved' AND settlement_date IS NOT NULL AND paid_date IS NULL THEN commission ELSE 0 END) as available
    FROM orders
    WHERE platform_account_id IN (2, 5, 13)
  `).get();
  
  console.log(`   ✅ 订单数据: ${stats.total} 条`);
  console.log(`   ✅ 可提现金额: $${stats.available.toFixed(2)}`);
  
  if (stats.available > 0) {
    console.log('   ✅ 数据正常');
  } else {
    console.log('   ⚠️  可提现金额为 0');
  }
  
  db.close();
} catch (error) {
  console.log('   ❌ 数据库检查失败:', error.message);
  allChecks = false;
}

// 2. 检查代码文件
console.log('\n2️⃣  检查代码文件...');
try {
  const serverCode = fs.readFileSync('./server-v2.js', 'utf8');
  
  // 检查关键代码
  const checks = [
    { name: 'INSERT 语句包含 settlement 字段', pattern: /settlement_id, settlement_date, paid_date, payment_id/ },
    { name: 'UPDATE 语句包含 settlement 字段', pattern: /settlement_id = \?, settlement_date = \?, paid_date = \?, payment_id = \?/ },
    { name: '提现汇总 API', pattern: /\/api\/super-admin\/withdrawal\/summary/ },
    { name: '提现历史 API', pattern: /\/api\/super-admin\/withdrawal\/payment-history/ },
    { name: '同步订单 API', pattern: /\/api\/super-admin\/withdrawal\/sync-pm-orders/ }
  ];
  
  checks.forEach(check => {
    if (check.pattern.test(serverCode)) {
      console.log(`   ✅ ${check.name}`);
    } else {
      console.log(`   ❌ ${check.name}`);
      allChecks = false;
    }
  });
} catch (error) {
  console.log('   ❌ 代码检查失败:', error.message);
  allChecks = false;
}

// 3. 检查前端文件
console.log('\n3️⃣  检查前端文件...');
try {
  const files = [
    'public/admin.html',
    'public/admin-withdrawal.js',
    'public/admin.css'
  ];
  
  files.forEach(file => {
    if (fs.existsSync(file)) {
      console.log(`   ✅ ${file}`);
    } else {
      console.log(`   ❌ ${file} 不存在`);
      allChecks = false;
    }
  });
  
  // 检查 admin.html 是否包含提现管理部分
  const adminHtml = fs.readFileSync('public/admin.html', 'utf8');
  if (adminHtml.includes('page-withdrawal-management') || adminHtml.includes('提现管理')) {
    console.log('   ✅ admin.html 包含提现管理部分');
  } else {
    console.log('   ❌ admin.html 缺少提现管理部分');
    allChecks = false;
  }
} catch (error) {
  console.log('   ❌ 前端文件检查失败:', error.message);
  allChecks = false;
}

// 4. 检查迁移文件
console.log('\n4️⃣  检查数据库迁移...');
try {
  if (fs.existsSync('migrations/0013_create_withdrawal_management.js')) {
    console.log('   ✅ 迁移文件存在');
  } else {
    console.log('   ❌ 迁移文件不存在');
    allChecks = false;
  }
} catch (error) {
  console.log('   ❌ 迁移检查失败:', error.message);
  allChecks = false;
}

// 总结
console.log('\n' + '='.repeat(60));
if (allChecks) {
  console.log('\n✅ 所有检查通过！准备部署。\n');
  console.log('📋 部署步骤:');
  console.log('   1. git add .');
  console.log('   2. git commit -m "fix: 修复提现管理数据显示"');
  console.log('   3. git push');
  console.log('\n或者运行: bash deploy-fix.sh\n');
  process.exit(0);
} else {
  console.log('\n❌ 发现问题，请先修复后再部署。\n');
  process.exit(1);
}
