// 数据库Migration管理工具
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 使用与 db.js 相同的路径逻辑
const DB_PATH = process.env.NODE_ENV === 'production' 
  ? path.join('/app/data', 'data.db')  // Railway Volume 路径
  : path.join(__dirname, 'data.db');   // 本地开发路径

// 初始化migration系统
function initMigrationSystem(db) {
  // 创建schema版本追踪表
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_schema_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER UNIQUE NOT NULL,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      checksum TEXT
    )
  `);

  console.log('✅ Migration系统已初始化');
}

// 获取当前数据库版本
function getCurrentVersion(db) {
  const result = db.prepare(`
    SELECT MAX(version) as current_version
    FROM db_schema_versions
  `).get();

  return result.current_version || 0;
}

// 获取所有migration文件
function getMigrationFiles() {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir);
    return [];
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  return files.map(file => {
    const match = file.match(/^(\d{4})_(.+)\.js$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}`);
    }

    return {
      version: parseInt(match[1]),
      name: match[2],
      filename: file,
      path: path.join(migrationsDir, file)
    };
  });
}

// 执行单个migration
function runMigration(db, migration) {
  console.log(`📝 执行 Migration ${migration.version}: ${migration.name}`);

  const migrationModule = require(migration.path);

  // 开启事务
  const transaction = db.transaction(() => {
    // 执行up函数
    if (typeof migrationModule.up !== 'function') {
      throw new Error(`Migration ${migration.filename} 缺少 up() 函数`);
    }

    migrationModule.up(db);

    // 记录版本
    db.prepare(`
      INSERT INTO db_schema_versions (version, name, checksum)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, generateChecksum(migration));
  });

  transaction();
  console.log(`✅ Migration ${migration.version} 执行成功`);
}

// 执行所有待运行的migrations（可传入已有db实例）
function runPendingMigrations(existingDb = null) {
  const shouldCloseDb = !existingDb;
  const db = existingDb || new Database(DB_PATH);

  try {
    // 初始化migration系统
    initMigrationSystem(db);

    const currentVersion = getCurrentVersion(db);
    const migrations = getMigrationFiles();

    console.log(`📊 当前数据库版本: ${currentVersion}`);

    const pendingMigrations = migrations.filter(m => m.version > currentVersion);

    if (pendingMigrations.length === 0) {
      console.log('✅ 数据库已是最新版本，无需执行migration');
      return currentVersion;
    }

    console.log(`🔄 发现 ${pendingMigrations.length} 个待执行的migrations`);

    pendingMigrations.forEach(migration => {
      runMigration(db, migration);
    });

    const newVersion = getCurrentVersion(db);
    console.log(`🎉 Migration完成！当前版本: ${newVersion}`);

    return newVersion;

  } catch (error) {
    console.error('❌ Migration失败:', error);
    throw error;
  } finally {
    if (shouldCloseDb) {
      db.close();
    }
  }
}

// 回滚到指定版本
function rollbackToVersion(targetVersion) {
  const db = new Database(DB_PATH);

  try {
    const currentVersion = getCurrentVersion(db);

    if (targetVersion >= currentVersion) {
      console.log('⚠️  目标版本大于或等于当前版本，无需回滚');
      return;
    }

    const migrations = getMigrationFiles()
      .filter(m => m.version > targetVersion && m.version <= currentVersion)
      .reverse(); // 倒序执行

    console.log(`🔙 回滚到版本 ${targetVersion}`);

    migrations.forEach(migration => {
      console.log(`📝 回滚 Migration ${migration.version}: ${migration.name}`);

      const migrationModule = require(migration.path);

      if (typeof migrationModule.down !== 'function') {
        throw new Error(`Migration ${migration.filename} 缺少 down() 函数`);
      }

      const transaction = db.transaction(() => {
        migrationModule.down(db);

        db.prepare(`
          DELETE FROM db_schema_versions WHERE version = ?
        `).run(migration.version);
      });

      transaction();
      console.log(`✅ Migration ${migration.version} 回滚成功`);
    });

    console.log(`\n🎉 回滚完成！当前版本: ${getCurrentVersion(db)}`);

  } catch (error) {
    console.error('❌ 回滚失败:', error);
    throw error;
  } finally {
    db.close();
  }
}

// 生成migration文件的checksum
function generateChecksum(migration) {
  const crypto = require('crypto');
  const content = fs.readFileSync(migration.path, 'utf8');
  return crypto.createHash('md5').update(content).digest('hex');
}

// 显示当前状态
function showStatus() {
  const db = new Database(DB_PATH);

  try {
    initMigrationSystem(db);

    const currentVersion = getCurrentVersion(db);
    const appliedMigrations = db.prepare(`
      SELECT version, name, applied_at
      FROM db_schema_versions
      ORDER BY version
    `).all();

    const allMigrations = getMigrationFiles();

    console.log('\n📊 数据库Migration状态\n');
    console.log(`当前版本: ${currentVersion}`);
    console.log(`已应用的migrations: ${appliedMigrations.length}`);
    console.log(`总migrations: ${allMigrations.length}`);
    console.log(`待执行的migrations: ${allMigrations.length - appliedMigrations.length}\n`);

    if (appliedMigrations.length > 0) {
      console.log('已应用的Migrations:');
      appliedMigrations.forEach(m => {
        console.log(`  ✅ [${m.version}] ${m.name} (${m.applied_at})`);
      });
    }

    const pendingMigrations = allMigrations.filter(
      m => !appliedMigrations.find(am => am.version === m.version)
    );

    if (pendingMigrations.length > 0) {
      console.log('\n待执行的Migrations:');
      pendingMigrations.forEach(m => {
        console.log(`  ⏳ [${m.version}] ${m.name}`);
      });
    }

  } finally {
    db.close();
  }
}

// 创建新的migration文件
function createMigration(name) {
  if (!name) {
    console.error('❌ 请提供migration名称');
    console.log('用法: node migrate.js create <migration_name>');
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  try {
    initMigrationSystem(db);
    const currentVersion = getCurrentVersion(db);
    const newVersion = currentVersion + 1;

    const paddedVersion = String(newVersion).padStart(4, '0');
    const filename = `${paddedVersion}_${name}.js`;
    const filepath = path.join(__dirname, 'migrations', filename);

    const template = `// Migration ${newVersion}: ${name}

/**
 * 向上迁移 - 应用此migration
 */
function up(db) {
  // 在这里编写你的DDL语句
  // 例如：
  // db.exec(\`
  //   ALTER TABLE users ADD COLUMN phone TEXT;
  // \`);

  console.log('  执行 ${name}...');
}

/**
 * 向下迁移 - 回滚此migration
 */
function down(db) {
  // 在这里编写回滚逻辑
  // 例如：
  // db.exec(\`
  //   ALTER TABLE users DROP COLUMN phone;
  // \`);

  console.log('  回滚 ${name}...');
}

module.exports = { up, down };
`;

    fs.writeFileSync(filepath, template);
    console.log(`✅ 已创建 migration 文件: ${filename}`);
    console.log(`📝 请编辑文件: ${filepath}`);

  } finally {
    db.close();
  }
}

// 命令行接口
if (require.main === module) {
  const command = process.argv[2];

  switch (command) {
    case 'up':
    case 'migrate':
      runPendingMigrations();
      break;

    case 'status':
      showStatus();
      break;

    case 'create':
      createMigration(process.argv[3]);
      break;

    case 'rollback':
      const targetVersion = parseInt(process.argv[3]) || 0;
      rollbackToVersion(targetVersion);
      break;

    default:
      console.log(`
数据库Migration管理工具

用法:
  node migrate.js up              - 执行所有待运行的migrations
  node migrate.js status          - 查看当前migration状态
  node migrate.js create <name>   - 创建新的migration文件
  node migrate.js rollback <ver>  - 回滚到指定版本

示例:
  node migrate.js create add_user_phone
  node migrate.js up
  node migrate.js status
  node migrate.js rollback 5
      `);
  }
}

module.exports = {
  runPendingMigrations,
  getCurrentVersion,
  showStatus
};
