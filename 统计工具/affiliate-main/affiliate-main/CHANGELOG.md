# 更新日志

## [1.3.1] - 2026-01-26

### 🐛 Bug 修复
- **提现管理数据显示问题**
  - 修复：数据采集时正确保存 settlement_date, paid_date 等字段
  - 修复：INSERT/UPDATE 语句参数匹配
  - 确认：数据库中已有正确的提现数据（总计 $4,906.38）
  - 状态：等待服务器重启以应用代码更改

### 📚 文档
- 新增 `WITHDRAWAL_LOGIC_FINAL_FIX.md` - 问题诊断和解决方案
- 更新 `QUICK_FIX_RAILWAY.md` - Railway 部署指南

---

## [1.3.0] - 2026-01-24

### ✨ 新增功能
- **提现管理系统**（PartnerMatic 平台）
  - 按账号分组显示提现数据
  - 可折叠的账号卡片设计
  - 三大汇总指标：可提现金额、提现中金额、已提现佣金
  - 灵活的日期筛选（最近7天、本月、上月、最近3个月、最近半年、全部）
  - 详细的提现记录表格
  - 数据导出功能

### 🔧 技术改进
- 集成 PartnerMatic Transaction V3 API
- 集成 PartnerMatic Payment Summary API
- 新增数据库表：`withdrawal_requests`, `withdrawal_history`
- 新增订单字段：`payment_id`, `settlement_id`, `settlement_date`, `paid_date`
- 创建自动同步脚本：`sync-all-pm-orders.js`

### 📚 文档
- `WITHDRAWAL_DEPLOYMENT.md` - 部署指南
- `WITHDRAWAL_MANAGEMENT_GUIDE.md` - 使用指南
- `TRANSACTION_V3_API_ANALYSIS.md` - API 文档
- `MULTI_PLATFORM_WITHDRAWAL_PLAN.md` - 多平台支持计划

### 🧹 项目清理
- 删除 50+ 个临时测试文件
- 删除过时的文档
- 优化项目结构

### ⚠️ 限制
- 提现管理目前仅支持 PartnerMatic 平台
- 其他平台（LinkHaitao、LinkBux、Rewardoo）待后续支持

---

## [1.2.0] - 之前版本

### 功能
- 多用户 SaaS 架构
- 超级管理员系统
- 平台账号管理
- 数据采集功能
- Google Ads 数据集成
- 邀请码系统
- 审计日志

---

**版本说明**：
- 主版本号：重大架构变更
- 次版本号：新功能添加
- 修订号：Bug 修复和小改进
