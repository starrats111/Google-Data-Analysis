# 超级管理员功能使用指南

## 📋 功能概述

超级管理员功能已成功实现并部署，提供以下核心能力：

### ✨ 主要功能

1. **仪表板** - 全平台数据概览
2. **用户管理** - 查看和管理所有用户
3. **平台统计** - 详细的平台运营数据
4. **审计日志** - 完整的操作记录追踪

---

## 🔐 超级管理员账号

### 测试账号

已创建的测试超级管理员账号：

```
📧 邮箱: admin@test.com
👤 用户名: SuperAdmin
🔑 密码: admin123456
👑 角色: 超级管理员
```

### 登录方式

1. 访问：`http://localhost:3000`
2. 使用上述凭证登录
3. 系统会自动识别超管角色并跳转到 `/admin.html`

---

## 🎯 功能详解

### 1. 仪表板 (Dashboard)

**功能**：
- 显示平台核心指标
  - 总用户数
  - 总订单数
  - 总佣金
  - 整体ROI
- 平台账号分布统计

**访问路径**：登录后默认页面

---

### 2. 用户管理 (Users)

**功能**：
- 查看所有用户列表
- 搜索用户（用户名/邮箱）
- 查看用户详情
  - 基本信息
  - 平台账号
  - 订单数据
  - 广告数据
  - 商家汇总

**操作**：
- 在用户列表点击"查看"按钮进入详情页
- 详情页提供多个Tab切换不同数据视图
- 支持分页浏览

---

### 3. 平台统计 (Platform Stats)

**功能**：
- 用户统计（总数、活跃、新增）
- 订单统计（数量、金额、佣金）
- 广告统计（花费、展示、点击）
- ROI分析（整体收益、利润）

**操作**：
- 可选择日期范围筛选
- 点击"刷新"按钮更新数据

---

### 4. 审计日志 (Audit Logs)

**功能**：
- 记录所有超管操作
- 包含：
  - 操作时间
  - 操作者
  - 操作类型
  - 目标用户
  - IP地址
  - 执行耗时

**操作**：
- 可按操作类型筛选
- 可按日期范围筛选
- 支持分页查看

---

## 🛠️ 创建新的超级管理员

### 方式一：使用交互式脚本（推荐）

```bash
node scripts/create-super-admin.js
```

脚本会引导你：
1. 输入邮箱
2. 输入用户名
3. 设置密码（至少8位，包含字母和数字）
4. 确认创建

### 方式二：直接数据库操作

```sql
-- 注意：密码需要先通过bcryptjs加密
INSERT INTO users (username, email, password_hash, role, is_active, created_at)
VALUES ('AdminName', 'admin@example.com', '加密后的密码', 'super_admin', 1, datetime('now'));
```

### 限制

- 最多可创建 **3个** 超级管理员账号
- 超管账号只能通过脚本或数据库创建
- 无法通过注册接口创建超管

---

## 🔒 安全特性

### 1. 权限控制

- **后端验证**：所有超管API都需要验证 `role === 'super_admin'`
- **前端验证**：登录时根据角色自动跳转
- **Token验证**：JWT Token包含用户角色信息

### 2. 审计日志

- **自动记录**：所有超管操作自动记录到 `audit_logs` 表
- **不可篡改**：日志一旦写入无法修改或删除
- **详细信息**：包含操作者、时间、IP、耗时等

### 3. 数据隔离

- 超管**只能查看**，不能修改用户数据
- 普通用户只能查看自己的数据
- 超管和普通用户完全隔离

---

## 📊 数据库变更

### 新增表

#### 1. `audit_logs` - 审计日志表

```sql
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  target_username TEXT,
  request_path TEXT,
  request_method TEXT,
  ip_address TEXT,
  details TEXT,
  execution_time INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id)
);
```

### 修改表

#### 1. `users` 表新增字段

```sql
ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';
```

**可选值**：
- `user` - 普通用户（默认）
- `super_admin` - 超级管理员

---

## 🌐 API接口

### 超级管理员专用API

所有API都需要：
- Authorization Header: `Bearer <token>`
- 用户角色必须为 `super_admin`

#### 用户管理

```
GET  /api/super-admin/users                  - 获取用户列表
GET  /api/super-admin/users/:id              - 获取用户详情
GET  /api/super-admin/users/:id/accounts     - 获取用户平台账号
GET  /api/super-admin/users/:id/orders       - 获取用户订单
GET  /api/super-admin/users/:id/ads-data     - 获取用户广告数据
GET  /api/super-admin/users/:id/summary      - 获取用户商家汇总
```

#### 平台统计

```
GET  /api/super-admin/platform-stats         - 获取平台统计
GET  /api/super-admin/platform-summary       - 获取平台商家汇总
```

#### 审计日志

```
GET  /api/super-admin/audit-logs             - 获取审计日志
```

---

## 📁 新增文件

```
public/
  ├── admin.html          # 超管前端页面
  ├── admin.css           # 超管页面样式
  └── admin.js            # 超管页面逻辑

scripts/
  └── create-super-admin.js  # 创建超管脚本

migrations/
  ├── 0007_add_user_role.js      # 添加role字段
  └── 0008_create_audit_logs.js  # 创建审计日志表
```

---

## 🚀 部署检查清单

- [x] 数据库迁移已执行
- [x] 超管账号已创建
- [x] 后端API已部署
- [x] 前端页面已部署
- [x] 权限验证正常
- [x] 审计日志正常记录

---

## ⚠️ 重要提示

### 安全建议

1. **修改默认密码**：首次登录后立即修改测试账号密码
2. **保管好凭证**：超管账号不要与他人共享
3. **定期检查日志**：定期查看审计日志，发现异常操作
4. **生产环境**：
   - 删除测试账号
   - 使用强密码创建新的超管账号
   - 考虑启用双因素认证（未来版本）

### 功能限制

1. **只读权限**：超管只能查看数据，不能修改用户数据
2. **账号限制**：最多3个超管账号
3. **数据隔离**：超管和普通用户功能完全独立

---

## 🐛 故障排查

### 问题1：无法登录超管账号

**检查**：
1. 邮箱密码是否正确
2. 数据库中用户的 `role` 字段是否为 `super_admin`
3. Token是否过期

**解决**：
```sql
-- 检查用户角色
SELECT id, email, username, role FROM users WHERE email = 'admin@test.com';

-- 如果role不对，更新为super_admin
UPDATE users SET role = 'super_admin' WHERE email = 'admin@test.com';
```

### 问题2：API返回403权限不足

**检查**：
1. Token是否包含role信息
2. 后端中间件是否正确验证role

**解决**：
- 重新登录获取新Token
- 确认 `server-v2.js` 中 `requireSuperAdmin` 中间件已正确配置

### 问题3：审计日志未记录

**检查**：
1. `audit_logs` 表是否存在
2. 审计日志中间件是否正确绑定

**解决**：
```sql
-- 检查表是否存在
SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs';

-- 如果不存在，运行迁移
node migrate.js up
```

---

## 📞 技术支持

如有问题，请检查：

1. **控制台日志**：查看浏览器控制台和服务器日志
2. **数据库状态**：确认迁移已成功执行
3. **API响应**：使用浏览器开发者工具查看API响应

---

## 🎉 总结

超级管理员功能现已完全集成到系统中，提供了：

✅ 完整的用户管理能力  
✅ 全面的平台数据统计  
✅ 详细的操作审计日志  
✅ 安全的权限控制机制  
✅ 友好的用户界面  

**系统已准备就绪，可以开始使用！** 🚀

