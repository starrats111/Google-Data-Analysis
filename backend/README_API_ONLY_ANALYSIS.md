# 纯API分析功能说明

## 概述

新的分析功能完全基于API数据，**已去除所有手动上传功能**。系统直接从数据库中的Google Ads API数据和平台数据生成分析结果，输出格式符合表6模板要求。

## 主要变更

### 1. 废弃的功能
- ❌ `/api/analysis/process` - 手动上传文件分析（已废弃，返回410错误）
- ❌ 所有文件上传相关的分析逻辑

### 2. 新的API端点

#### 生成分析结果
```
POST /api/analysis/generate
```

**参数：**
- `begin_date` (必需): 开始日期 YYYY-MM-DD
- `end_date` (必需): 结束日期 YYYY-MM-DD
- `account_id` (可选): 账号ID
- `platform_id` (可选): 平台ID
- `analysis_type` (可选): 分析类型，'daily' 或 'l7d'（默认：'l7d'）

**响应格式：**
```json
{
  "success": true,
  "begin_date": "2026-01-28",
  "end_date": "2026-02-04",
  "analysis_type": "l7d",
  "total_records": 10,
  "data": [
    {
      "日期": "2026-01-28~2026-02-04",
      "广告系列名": "xxx",
      "MID": "xxx",
      "平台": "xxx",
      "账号": "xxx",
      "预算": 100.00,
      "费用": 50.00,
      "展示": 1000,
      "点击": 100,
      "CPC": 0.5000,
      "最高CPC": 0.6000,
      "IS Budget丢失": 5.00,
      "IS Rank丢失": 2.00,
      "谷歌状态": "已启用",
      "订单数": 10,
      "佣金": 30.00,
      "出单天数": 5,
      "保守佣金": 21.60,
      "保守EPC": 0.2160,
      "保守ROI": -56.80,
      "L7D点击": 100,
      "L7D佣金": 30.00,
      "L7D花费": 50.00,
      "L7D出单天数": 5,
      "当前Max CPC": 0.6000,
      "操作指令": "数据正常，保持现状",
      "异常类型": null
    }
  ]
}
```

### 3. 保留的API端点

#### 每日分析（从API数据）
```
POST /api/analysis/daily?target_date=YYYY-MM-DD
```

#### L7D分析（从API数据）
```
POST /api/analysis/l7d?end_date=YYYY-MM-DD
```

## 输出格式说明

分析结果完全符合**表6模板**格式，包含以下字段：

### 基础信息
- 日期
- 广告系列名
- MID（商家ID）
- 平台
- 账号

### Google Ads指标
- 预算
- 费用
- 展示
- 点击
- CPC
- 最高CPC
- IS Budget丢失
- IS Rank丢失
- 谷歌状态

### 平台数据指标
- 订单数
- 佣金
- 出单天数

### 计算指标
- 保守佣金（佣金 × 0.72）
- 保守EPC（保守佣金 / 点击）
- 保守ROI（(保守佣金 - 费用) / 费用 × 100%）

### L7D指标（仅L7D分析时）
- L7D点击
- L7D佣金
- L7D花费
- L7D出单天数

### 其他
- 当前Max CPC
- 操作指令（自动生成）
- 异常类型

## 使用示例

### 生成L7D分析（过去7天）

```bash
curl -X POST "http://127.0.0.1:8000/api/analysis/generate?begin_date=2026-01-28&end_date=2026-02-04&analysis_type=l7d" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 生成每日分析（单天）

```bash
curl -X POST "http://127.0.0.1:8000/api/analysis/generate?begin_date=2026-02-04&end_date=2026-02-04&analysis_type=daily" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 按账号筛选

```bash
curl -X POST "http://127.0.0.1:8000/api/analysis/generate?begin_date=2026-01-28&end_date=2026-02-04&account_id=1" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 按平台筛选

```bash
curl -X POST "http://127.0.0.1:8000/api/analysis/generate?begin_date=2026-01-28&end_date=2026-02-04&platform_id=1" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## 数据来源

分析数据完全来自：
1. **Google Ads API数据** (`google_ads_api_data` 表)
   - 通过MCC账号同步获取
   - 包含：费用、展示、点击、CPC、预算等

2. **平台数据** (`platform_data` 表)
   - 通过平台账号同步获取
   - 包含：订单数、佣金等

## 数据匹配逻辑

1. 通过 `extracted_platform_code` 匹配平台
2. 通过 `extracted_account_code`（商家ID）匹配账号
3. 按广告系列分组聚合数据
4. 按日期范围匹配平台数据

## 注意事项

1. **数据同步**：确保Google Ads数据和平台数据已同步到数据库
2. **账号配置**：确保联盟账号已正确配置平台代码和账号代码
3. **日期范围**：建议使用合理的日期范围（如过去7天）
4. **权限**：员工只能分析自己的数据

## 导出功能

生成的分析结果可以通过导出功能导出为Excel格式（使用表6模板）：

```
GET /api/export/analysis?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
```

导出文件将使用表6模板的格式和样式。

