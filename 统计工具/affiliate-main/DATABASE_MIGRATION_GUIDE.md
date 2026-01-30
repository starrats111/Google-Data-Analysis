# 数据库Migration管理指南

## 概述

本项目使用自定义的数据库migration系统来管理SQLite数据库的schema版本。这确保了数据库结构的变更可追踪、可回滚，避免了手动修改数据库的风险。

## 系统架构

```
cc05/
├── db.js                          # 数据库实例和初始化
├── migrate.js                     # Migration管理工具
├── backup-db.js                   # 数据库备份工具
├── migrations/                    # Migration脚本目录
│   ├── 0001_baseline_schema.js   # 基线schema
│   ├── 0002_add_user_phone.js    # 示例migration
│   └── ...
└── backups/                       # 数据库备份目录（自动创建）
    ├── data_backup_2025-10-13T10-30-00.db
    └── ...
```

## 核心概念

### Migration版本号
- 每个migration文件以4位数字开头，例如：`0001_baseline_schema.js`
- 版本号必须递增且唯一
- 文件名格式：`<version>_<description>.js`

### Migration文件结构
每个migration文件必须导出两个函数：

```javascript
// up() - 应用此migration（向上迁移）
function up(db) {
  db.exec(`
    ALTER TABLE users ADD COLUMN phone TEXT;
  `);
}

// down() - 回滚此migration（向下迁移）
function down(db) {
  // SQLite不支持DROP COLUMN，需要重建表
  db.exec(`
    -- 回滚逻辑
  `);
}

module.exports = { up, down };
```

## 使用指南

### 1. 查看当前状态

```bash
node migrate.js status
```

输出示例：
```
📊 数据库Migration状态

当前版本: 1
已应用的migrations: 1
总migrations: 1
待执行的migrations: 0

已应用的Migrations:
  ✅ [1] baseline_schema (2025-10-13 10:30:00)
```

### 2. 创建新的Migration

```bash
node migrate.js create add_user_phone
```

这会创建文件：`migrations/0002_add_user_phone.js`

编辑该文件，添加你的DDL语句：

```javascript
function up(db) {
  db.exec(`
    ALTER TABLE users ADD COLUMN phone TEXT;
  `);
  console.log('  ✅ 已添加 phone 字段');
}

function down(db) {
  // SQLite限制：不能直接DROP COLUMN
  // 需要创建新表、复制数据、删除旧表
  console.log('  ⚠️  SQLite不支持DROP COLUMN，需要手动处理');
}

module.exports = { up, down };
```

### 3. 执行Migration

```bash
node migrate.js up
```

或者简化命令：
```bash
node migrate.js migrate
```

输出示例：
```
📊 当前数据库版本: 1
🔄 发现 1 个待执行的migrations
📝 执行 Migration 2: add_user_phone
  ✅ 已添加 phone 字段
✅ Migration 2 执行成功
🎉 Migration完成！当前版本: 2
```

### 4. 回滚Migration

回滚到指定版本（例如回滚到版本1）：

```bash
node migrate.js rollback 1
```

输出示例：
```
🔙 回滚到版本 1
📝 回滚 Migration 2: add_user_phone
✅ Migration 2 回滚成功
🎉 回滚完成！当前版本: 1
```

## 数据库备份

### 创建备份

```bash
node backup-db.js backup
```

输出示例：
```
✅ 数据库备份成功！
📁 备份文件: data_backup_2025-10-13T10-30-00.db
📊 文件大小: 0.25 MB
📍 备份路径: C:\Users\...\backups\data_backup_2025-10-13T10-30-00.db
```

### 列出所有备份

```bash
node backup-db.js list
```

输出示例：
```
📦 找到 3 个备份文件:

1. data_backup_2025-10-13T10-30-00.db
   大小: 0.25 MB | 时间: 2025-10-13 10:30:00

2. data_backup_2025-10-12T15-20-00.db
   大小: 0.23 MB | 时间: 2025-10-12 15:20:00
```

### 恢复备份

```bash
node backup-db.js restore data_backup_2025-10-13T10-30-00.db
```

⚠️ **注意**：恢复前会自动备份当前数据库

## 最佳实践

### 1. Migration命名规范

✅ **好的命名：**
- `0002_add_user_phone.js`
- `0003_create_payment_table.js`
- `0004_add_index_on_orders.js`

❌ **不好的命名：**
- `0002_update.js`
- `0003_fix.js`
- `0004_temp.js`

### 2. Migration编写原则

#### ✅ DO（推荐做法）

1. **每个Migration只做一件事**
   ```javascript
   // 好：单一职责
   function up(db) {
     db.exec(`ALTER TABLE users ADD COLUMN phone TEXT;`);
   }
   ```

2. **使用事务确保原子性**
   ```javascript
   // migrate.js 已自动处理事务，无需手动包装
   ```

3. **添加适当的日志**
   ```javascript
   function up(db) {
     db.exec(`ALTER TABLE users ADD COLUMN phone TEXT;`);
     console.log('  ✅ 已添加 phone 字段');
   }
   ```

4. **始终编写down()函数**
   ```javascript
   function down(db) {
     // 即使SQLite有限制，也要记录回滚逻辑
     console.log('  ⚠️  需要手动删除 phone 字段');
   }
   ```

#### ❌ DON'T（避免做法）

1. **不要在Migration中查询或修改数据**
   ```javascript
   // 坏：不要在migration中操作数据
   function up(db) {
     db.exec(`UPDATE users SET status = 'active'`);
   }
   ```

2. **不要在生产环境直接测试Migration**
   - 先在开发环境测试
   - 然后在staging环境验证
   - 最后才在生产环境执行

3. **不要跳过版本号**
   ```
   ❌ 0001 -> 0003 (跳过了0002)
   ✅ 0001 -> 0002 -> 0003
   ```

### 3. SQLite特殊限制

SQLite不支持以下DDL操作：
- `ALTER TABLE DROP COLUMN`
- `ALTER TABLE ALTER COLUMN`
- `ALTER TABLE RENAME COLUMN` (旧版本)

**解决方案：创建新表，复制数据，删除旧表**

示例：
```javascript
function up(db) {
  // 1. 创建新表
  db.exec(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL
      -- 移除了 old_column
    );
  `);

  // 2. 复制数据
  db.exec(`
    INSERT INTO users_new (id, email, username)
    SELECT id, email, username FROM users;
  `);

  // 3. 删除旧表
  db.exec(`DROP TABLE users;`);

  // 4. 重命名新表
  db.exec(`ALTER TABLE users_new RENAME TO users;`);

  // 5. 重建索引
  db.exec(`CREATE INDEX idx_users_email ON users(email);`);
}
```

### 4. 生产环境部署流程

#### 第一次部署（已有数据库）

```bash
# 1. 备份现有数据库
node backup-db.js backup

# 2. 标记当前版本为baseline（跳过0001）
# 手动在db_schema_versions表插入记录
node -e "const db = require('better-sqlite3')('data.db'); db.exec('CREATE TABLE IF NOT EXISTS db_schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE, name TEXT, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP, checksum TEXT)'); db.prepare('INSERT INTO db_schema_versions (version, name) VALUES (1, \"baseline_schema\")').run();"

# 3. 执行新的migrations
node migrate.js up

# 4. 验证
node migrate.js status
```

#### 日常部署

```bash
# 1. 拉取代码（包含新的migration文件）
git pull

# 2. 备份数据库
node backup-db.js backup

# 3. 执行migrations
node migrate.js up

# 4. 重启服务器
# (或者让server-v2.js自动执行migrations)
```

### 5. 环境隔离建议

建议为不同环境使用不同的数据库文件：

```javascript
// db.js
const env = process.env.NODE_ENV || 'development';
const dbFiles = {
  development: 'data.dev.db',
  test: 'data.test.db',
  production: 'data.db'
};

const DB_PATH = path.join(__dirname, dbFiles[env]);
```

## 故障排查

### 问题1：Migration执行失败

**症状：**
```
❌ Migration失败: SqliteError: ...
```

**解决方案：**
1. 检查migration文件的SQL语法
2. 恢复备份：`node backup-db.js restore <最近的备份>`
3. 修复migration文件后重新执行

### 问题2：版本不一致

**症状：**
```
⚠️  Migration文件与数据库记录不一致
```

**解决方案：**
```bash
# 查看当前状态
node migrate.js status

# 手动修复db_schema_versions表
node -e "const db = require('better-sqlite3')('data.db'); db.prepare('DELETE FROM db_schema_versions WHERE version = ?').run(X);"
```

### 问题3：循环依赖错误

**症状：**
```
Error: Cannot find module './migrate'
```

**解决方案：**
- 确保`db.js`使用延迟加载：`const { runPendingMigrations } = require('./migrate')`
- 确保`migrate.js`不依赖`db.js`

## 集成到启动流程

`server-v2.js` 已自动集成migration系统：

```javascript
const { db, initDatabase } = require('./db');

// 初始化数据库（自动执行migrations）
initDatabase();

// 启动服务器
app.listen(PORT, () => {
  console.log('🚀 服务器启动成功');
});
```

## 常用命令速查

```bash
# Migration管理
node migrate.js status                      # 查看状态
node migrate.js create <name>               # 创建migration
node migrate.js up                          # 执行所有待运行的migrations
node migrate.js rollback <version>          # 回滚到指定版本

# 数据库备份
node backup-db.js backup                    # 创建备份
node backup-db.js list                      # 列出备份
node backup-db.js restore <filename>        # 恢复备份
```

## 总结

✅ **规范化好处：**
1. **可追踪** - 每次schema变更都有记录
2. **可回滚** - 出问题可以快速恢复
3. **可协作** - 团队成员都用同样的流程
4. **可自动化** - 启动时自动执行migrations
5. **可审计** - 知道谁在什么时候改了什么

⚠️ **注意事项：**
1. 生产环境操作前务必备份
2. Migration文件一旦提交就不要修改
3. 测试environment先行，production最后
4. 保持migration小而专注
5. 定期清理旧备份文件

---

**维护者：** 系统管理员
**更新时间：** 2025-10-13
**版本：** 1.0
