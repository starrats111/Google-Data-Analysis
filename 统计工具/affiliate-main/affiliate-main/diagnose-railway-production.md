# Railway 生产环境诊断

## 🔍 问题分析

从截图看到：
- 生产环境有 **7 个 PM 账号**
- 所有账号的"可提现"都显示 **$0.00**
- 本地数据库只有 3 个账号，且有正确的数据

**结论**: 生产环境和本地环境的数据库不同步！

## 📊 生产环境账号列表

从截图识别的账号：
1. 修文君 (pm1)
2. buckynick (PM2)
3. variety (PM1)
4. truvo (PM2)
5. yubin weng (PM1) ⭐
6. godfrey (PM1)
7. living001 (PM1) ⭐

⭐ 标记的账号在本地数据库中有数据

## ❓ 为什么显示 $0.00？

可能的原因：

### 1. 订单没有 settlement_date
生产环境的订单可能是用旧代码采集的，没有保存 settlement_date 字段。

**检查方法**（在 Railway 上运行）：
```bash
railway run node debug-production-issue.js
```

### 2. 代码没有部署
新的代码可能还没有推送到 Railway。

**解决方法**：
```bash
git push
```

### 3. 需要重新采集数据
即使代码已部署，旧的订单数据也不会自动更新。

**解决方法**：
- 方法 A: 在管理后台点击"数据采集"，重新采集所有账号的数据
- 方法 B: 点击"同步数据"按钮，更新 settlement 字段

## ✅ 推荐解决方案

### 步骤 1: 确认代码已部署
```bash
# 检查 git 状态
git status

# 如果有未提交的更改
git add .
git commit -m "fix: 修复提现管理数据显示"
git push

# 等待 Railway 部署完成（1-2分钟）
```

### 步骤 2: 在 Railway 上检查数据
```bash
# 连接到 Railway
railway link

# 检查数据库状态
railway run node debug-production-issue.js
```

### 步骤 3: 根据检查结果采取行动

#### 情况 A: 订单有数据但没有 settlement_date
**原因**: 订单是用旧代码采集的

**解决**: 点击"同步数据"按钮，或者重新采集数据

#### 情况 B: 订单本身就没有数据
**原因**: 这些账号还没有采集过数据

**解决**: 在管理后台点击"数据采集"

#### 情况 C: 代码还是旧的
**原因**: 部署失败或代码没有推送

**解决**: 重新推送代码

## 🚀 快速修复（推荐）

### 方法 1: 使用同步功能（最快）
1. 确保代码已推送到 Railway
2. 等待部署完成
3. 登录管理后台
4. 点击"提现管理"
5. 点击"🔄 同步数据"按钮
6. 等待同步完成（2-5分钟）

### 方法 2: 重新采集数据（最彻底）
1. 登录管理后台
2. 点击"数据采集"
3. 选择所有 PM 账号
4. 点击"开始采集"
5. 等待采集完成

### 方法 3: 使用 Railway CLI（最直接）
```bash
# 安装 Railway CLI
npm install -g @railway/cli

# 登录
railway login

# 链接项目
railway link

# 运行同步脚本
railway run node sync-all-pm-orders.js
```

## 📝 验证步骤

同步/采集完成后：

1. 刷新浏览器（Ctrl+Shift+R）
2. 查看"可提现金额"
3. 应该看到非零的金额

如果还是 $0.00：

```bash
# 在 Railway 上检查
railway run node check-all-pm-accounts.js
```

## ⚠️ 重要提示

1. **本地数据库 ≠ 生产数据库**
   - 本地测试通过不代表生产环境正常
   - 需要在 Railway 上单独检查和修复

2. **旧订单不会自动更新**
   - 即使部署了新代码
   - 需要重新采集或同步

3. **同步 vs 采集**
   - 同步：只更新 settlement 字段（快）
   - 采集：重新获取所有订单数据（慢但彻底）

## 🆘 如果还是不行

提供以下信息：

1. Railway 部署日志
2. `railway run node debug-production-issue.js` 的输出
3. `railway run node check-all-pm-accounts.js` 的输出
4. 浏览器控制台的错误信息（F12）

---

**创建时间**: 2026-01-26
**适用环境**: Railway 生产环境

