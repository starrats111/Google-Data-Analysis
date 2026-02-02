# Google Ads API 申请表单问题 11-12 填写指南

## 问题 11：支持的广告系列类型

**问题：** "Which Google Ads campaign types does your tool support?"

### 系统分析

根据代码分析，您的系统：
- **只查询数据**，不创建或修改广告系列
- 使用 `GoogleAdsService.Search()` 查询所有类型的广告系列数据
- 查询字段包括：广告系列ID、名称、预算、费用、展示、点击等指标

### 推荐答案

**选项 1（推荐）：**
```
All campaign types (Search, Display, Shopping, Video, Performance Max, App, Discovery, Local, Smart)
```

**选项 2（更简洁）：**
```
All campaign types - our tool queries data from all campaign types for reporting and analysis purposes
```

**选项 3（详细说明）：**
```
Our tool supports data querying for all Google Ads campaign types including Search, Display, Shopping, Video, Performance Max, App, Discovery, Local, and Smart campaigns. We query campaign metrics (cost, impressions, clicks, CPC) regardless of campaign type for unified reporting and analysis.
```

### 为什么这样填写？

1. **系统不区分广告系列类型**
   - 查询语句使用 `FROM campaign`，不筛选特定类型
   - 系统需要获取所有类型的广告系列数据用于分析

2. **实际使用场景**
   - 系统同步所有广告系列的数据
   - 不关心广告系列的具体类型
   - 只关注数据指标（费用、展示、点击等）

---

## 问题 12：提供的功能

**问题：** "Which of the following Google Ads capabilities does your tool provide?"

### 系统功能分析

根据代码分析，您的系统：

✅ **Reporting（报告）** - **选择此项**
- 系统提供数据报告和分析功能
- 按日期、平台、商家聚合数据
- 生成汇总报告和明细报告
- 计算净利润、拒付率等指标

❌ **Account Creation（账号创建）** - **不选择**
- 系统不创建 Google Ads 账号
- 只查询现有账号的数据

❌ **Account Management（账号管理）** - **不选择**
- 系统不修改或管理账号设置
- 只读取账号信息（用于获取客户账号列表）

❌ **Campaign Creation（广告系列创建）** - **不选择**
- 系统不创建广告系列
- 只查询现有广告系列的数据

❌ **Campaign Management（广告系列管理）** - **不选择**
- 系统不修改广告系列设置
- 不暂停、启用或修改广告系列
- 只读取广告系列数据

❌ **Keyword Planning Services（关键词规划服务）** - **不选择**
- 系统不提供关键词规划功能
- 不查询关键词建议或规划数据

✅ **Other（其他）** - **建议选择此项并说明**
- 数据同步（Data Synchronization）
- 数据分析（Data Analysis）
- 多平台数据整合（Multi-platform Data Integration）

### 推荐选择

**勾选以下选项：**
- ✅ **Reporting（报告）**
- ✅ **Other（其他）** - 并在说明中填写：Data synchronization and analysis

### Other 选项的详细说明

如果表单允许填写 "Other" 的详细说明，可以填写：

```
Data Synchronization: Automatically sync Google Ads data (campaign metrics, costs, impressions, clicks) from multiple MCC accounts for unified reporting and analysis.

Data Analysis: Aggregate and analyze advertising data across multiple platforms (Google Ads + affiliate platforms) to calculate net profit, rejection rates, and other business metrics.
```

或者更简洁：

```
Data synchronization and analysis - Our tool automatically syncs Google Ads campaign data from multiple MCC accounts and provides unified reporting and analysis across Google Ads and affiliate platforms.
```

---

## 填写示例

### 问题 11 填写示例

```
All campaign types (Search, Display, Shopping, Video, Performance Max, App, Discovery, Local, Smart). Our tool queries campaign metrics from all campaign types for reporting and analysis purposes.
```

### 问题 12 选择

**勾选：**
- ☑ Reporting
- ☑ Other

**Other 说明：**
```
Data synchronization and analysis - Automatically sync Google Ads campaign data from multiple MCC accounts and provide unified reporting across Google Ads and affiliate platforms.
```

---

## 重要提示

1. **诚实填写**
   - 只选择系统实际提供的功能
   - 不要选择系统不提供的功能（如 Account Creation、Campaign Management）

2. **清晰说明**
   - 在 "Other" 中详细说明数据同步和分析功能
   - 强调系统是**只读**的，不进行任何创建或修改操作

3. **符合申请目的**
   - 申请 Standard Access 是为了提高数据查询配额
   - 系统只进行数据查询，不进行账号或广告系列管理
   - 这符合您的实际使用场景

---

## 总结

**问题 11：**
- 填写：支持所有广告系列类型（因为系统查询所有类型的数据）

**问题 12：**
- 勾选：Reporting、Other
- Other 说明：数据同步和分析功能

这样的填写方式：
- ✅ 准确反映系统的实际功能
- ✅ 符合 Google Ads API 使用政策
- ✅ 不会引起审核团队的疑问
- ✅ 支持您的 Standard Access 申请

