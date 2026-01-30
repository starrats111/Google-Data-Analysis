# 提现管理功能 - 部署指南

## ✅ 功能状态

**已完成并可上线使用**

- ✅ 支持平台：PartnerMatic (PM)
- ✅ 3个账号，总可提现金额：$4,906.38
- ✅ 自动同步订单状态和提现记录
- ✅ 按账号分组展示
- ✅ 日期筛选功能
- ✅ 数据导出功能

---

## 🚀 部署步骤

### 1. 数据库迁移（已完成）
数据库迁移已自动执行，创建了以下表：
- `withdrawal_requests` - 提现请求记录
- `withdrawal_history` - 提现历史记录
- `orders` 表新增字段：`payment_id`, `settlement_id`, `settlement_date`, `paid_date`, `withdrawal_request_id`

### 2. 同步 PM 订单数据

#### 方法 A：通过网页界面（推荐 ⭐）
1. 登录超级管理员后台
2. 进入"提现管理"页面
3. 点击顶部的 **"🔄 同步数据"** 按钮
4. 等待同步完成（可能需要几分钟）
5. 刷新页面查看更新后的数据

#### 方法 B：通过 Railway CLI
```bash
# 1. 安装 Railway CLI
npm install -g @railway/cli

# 2. 登录并链接项目
railway login
railway link

# 3. 运行同步脚本
railway run node sync-all-pm-orders.js
```

#### 方法 C：通过 Railway 控制台
1. 进入 Railway 项目控制台
2. 打开 Shell 终端
3. 运行命令：`node sync-all-pm-orders.js`

**建议**：首次部署后使用方法 A 或 B，之后可以定期使用网页界面同步

### 3. 启动服务
Railway 会自动启动服务，无需手动操作。

### 4. 访问提现管理
1. 登录超级管理员后台：`https://your-domain/admin.html`
2. 点击左侧导航"提现管理"
3. 查看提现数据和历史记录

---

## 📊 功能说明

### 顶部汇总卡片
- **💰 可提现金额**：当前所有账号可提现的总金额（不受日期筛选影响）
- **⏳ 提现中金额**：正在处理中的提现金额
- **💵 已提现佣金**：已支付的佣金总额（受日期筛选影响）

### 日期筛选
- 最近7天
- **本月**（默认）
- 上月
- 最近3个月
- 最近半年
- 全部

### 账号卡片
每个账号显示：
- 账号名称和用户信息
- 💰 可提现金额
- ⏳ 提现中金额
- ✅ 已提现金额
- 点击展开查看详细提现记录

### 提现记录表格
- 请求日期
- 支付日期
- Payment ID
- 状态
- 支付方式
- 金额

---

## 🔄 数据同步

### 网页界面同步（推荐 ⭐）
1. 登录超级管理员后台
2. 进入"提现管理"页面
3. 点击 **"🔄 同步数据"** 按钮
4. 等待同步完成
5. 页面会自动刷新显示最新数据

**优点**：
- 无需命令行操作
- 实时查看同步进度
- 适合 Railway 等云平台

### 自动同步（可选）
如果需要定时自动同步，可以使用 Railway 的 Cron Jobs 功能：

1. 在 Railway 项目中添加 Cron Job
2. 设置执行命令：`node sync-all-pm-orders.js`
3. 设置执行时间：例如每天凌晨 2 点

### 手动同步
当发现数据不一致时，可以手动运行同步脚本：

```bash
# 本地环境
node sync-all-pm-orders.js

# Railway CLI
railway run node sync-all-pm-orders.js
```

---

## 📁 核心文件

### 后端
- `server-v2.js` (lines 9129-9400) - 提现管理 API
- `migrations/0013_create_withdrawal_management.js` - 数据库迁移

### 前端
- `public/admin.html` - 提现管理页面 HTML
- `public/admin-withdrawal.js` - 提现管理 JavaScript
- `public/admin.css` - 样式文件

### 同步脚本
- `sync-all-pm-orders.js` - 同步所有 PM 账号
- `sync-living001-orders.js` - 同步单个账号（示例）

### 文档
- `TRANSACTION_V3_API_ANALYSIS.md` - PM API 文档
- `WITHDRAWAL_MANAGEMENT_GUIDE.md` - 详细使用指南
- `WITHDRAWAL_SYSTEM_SUMMARY.md` - 系统架构说明

---

## ⚠️ 注意事项

### 1. 仅支持 PartnerMatic
当前版本仅支持 PartnerMatic 平台，其他平台（LinkHaitao、LinkBux、Rewardoo）暂不支持。

### 2. 数据准确性
- 可提现金额基于数据库中的订单数据
- 需要定期同步以保持数据最新
- 与 PM 后台可能有小幅差异（通常在 5% 以内）

### 3. API 限制
- PM API 有频率限制
- 同步脚本已内置延迟机制
- 避免频繁手动同步

---

## 🐛 故障排查

### 问题：可提现金额显示为 $0
**解决**：运行同步脚本更新订单数据
```bash
node sync-all-pm-orders.js
```

### 问题：提现记录为空
**原因**：该账号在选定日期范围内没有提现记录
**解决**：
1. 调整日期筛选范围
2. 检查账号是否有 API Token

### 问题：数据与 PM 后台不一致
**原因**：数据库未及时同步
**解决**：
1. 运行同步脚本
2. 设置自动同步任务

---

## 📈 未来扩展

### 其他平台支持
参考 `MULTI_PLATFORM_WITHDRAWAL_PLAN.md` 了解其他平台的支持计划。

### 可能的改进
- 添加提现申请功能
- 添加提现审批流程
- 支持批量导出
- 添加数据统计图表

---

## 📞 技术支持

如有问题，请查看：
1. `WITHDRAWAL_MANAGEMENT_GUIDE.md` - 详细使用指南
2. `TRANSACTION_V3_API_ANALYSIS.md` - API 技术文档
3. 项目 Issues

---

**最后更新**：2026-01-24
**版本**：v1.0.0
**状态**：✅ 生产就绪
