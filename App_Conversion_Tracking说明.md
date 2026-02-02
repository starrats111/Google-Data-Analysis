# App Conversion Tracking 和 Remarketing API 说明

## 问题 10 的含义

**问题：** "Do you plan to use your token for App Conversion Tracking and Remarketing API?"

这个问题询问您是否计划使用 Google Ads API 的以下两个特殊功能：

### 1. App Conversion Tracking（应用转化跟踪）

**用途：**
- 跟踪移动应用（iOS/Android）中的用户行为
- 记录应用内的转化事件（如下载、安装、购买、注册等）
- 将应用内转化数据回传到 Google Ads，用于优化广告投放

**使用场景：**
- 您有移动应用（App）
- 需要在 Google Ads 中跟踪应用内的转化
- 使用 Google Ads API 上传或管理应用转化数据

**API 功能：**
- `ConversionUploadService` - 上传转化数据
- `OfflineConversionUploadService` - 上传离线转化数据
- `ConversionActionService` - 管理转化操作

### 2. Remarketing API（再营销 API）

**用途：**
- 创建和管理再营销列表（Remarketing Lists）
- 管理用户列表（User Lists）
- 将网站访问者或应用用户添加到再营销列表

**使用场景：**
- 需要动态创建和管理再营销受众
- 通过 API 自动添加用户到再营销列表
- 管理复杂的再营销策略

**API 功能：**
- `UserListService` - 管理用户列表
- `RemarketingActionService` - 管理再营销操作

---

## 您的系统分析

### 您的系统实际使用的 Google Ads API 功能

根据代码分析，您的系统主要使用：

1. **GoogleAdsService** - 查询广告系列数据
   - 查询广告系列（campaign）
   - 查询广告指标（metrics：费用、展示、点击、CPC等）
   - 查询广告系列预算（campaign_budget）

2. **CustomerService** - 获取客户账号列表
   - 获取 MCC 下的所有客户账号
   - 用于遍历和管理多个客户账号

### 您的系统未使用的功能

❌ **App Conversion Tracking**
- 您的系统是 Web 应用，不是移动应用
- 不涉及应用内转化跟踪
- 不上传应用转化数据

❌ **Remarketing API**
- 不创建或管理再营销列表
- 不管理用户列表
- 只进行数据查询和分析，不进行受众管理

---

## 推荐答案

### ✅ 应该选择：**No**

**理由：**

1. **您的系统用途**
   - 主要用于数据同步和分析
   - 查询广告系列和指标数据
   - 不涉及应用转化跟踪
   - 不涉及再营销列表管理

2. **功能范围**
   - 您的系统是一个数据分析平台
   - 只读取数据，不创建或管理转化跟踪
   - 不涉及移动应用转化跟踪

3. **申请目的**
   - 申请 Standard Access 是为了提高数据查询配额
   - 不是为了使用 App Conversion Tracking 或 Remarketing API

---

## 如果选择 Yes 会怎样？

如果您选择 "Yes"（即使实际上不使用这些功能）：

1. **可能的影响**
   - Google 可能会询问您如何使用这些功能
   - 需要提供额外的说明和文档
   - 审核可能会更复杂

2. **建议**
   - 如果确实不使用这些功能，选择 "No" 更简单直接
   - 避免不必要的审核问题
   - 申请流程更顺畅

---

## 总结

**问题 10 的答案：** **No**

**原因：**
- 您的系统不涉及移动应用转化跟踪
- 您的系统不涉及再营销列表管理
- 您的系统只用于数据查询和分析
- 选择 "No" 更符合实际情况，申请流程更顺畅

---

## 参考信息

如果您将来需要使用这些功能，可以：
1. 先获得 Standard Access
2. 后续需要时再单独申请这些功能的访问权限
3. 或者通过 Google Ads 界面直接使用这些功能（不需要 API）

