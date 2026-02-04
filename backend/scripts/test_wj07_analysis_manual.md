# 测试 wj07 用户的每日分析和 L7D 分析

## 方法 1: 使用 API 调用（推荐）

### 前置条件
1. 确保后端服务正在运行：`http://127.0.0.1:8000`
2. 确保 wj07 用户存在且有数据

### 步骤

#### 1. 登录获取 token

```bash
curl -X POST "http://127.0.0.1:8000/api/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=wj07&password=wj123456"
```

保存返回的 `access_token`

#### 2. 测试每日分析（过去7天）

为每一天生成每日分析：

```bash
# 今天
curl -X POST "http://127.0.0.1:8000/api/analysis/daily?target_date=2026-02-04" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 昨天
curl -X POST "http://127.0.0.1:8000/api/analysis/daily?target_date=2026-02-03" \
  -H "Authorization: Bearer YOUR_TOKEN"

# ... 继续到7天前
```

#### 3. 测试 L7D 分析

```bash
# 生成截止到昨天的 L7D 分析（过去7天）
curl -X POST "http://127.0.0.1:8000/api/l7d?end_date=2026-02-03" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## 方法 2: 使用测试脚本

在服务器上执行：

```bash
cd ~/Google-Data-Analysis/backend
chmod +x scripts/test_wj07_analysis_api.sh
./scripts/test_wj07_analysis_api.sh
```

## 方法 3: 通过 Python 脚本（需要虚拟环境）

```bash
cd ~/Google-Data-Analysis/backend
source venv/bin/activate
python scripts/test_wj07_analysis.py
```

## API 端点说明

### 每日分析
- **端点**: `POST /api/analysis/daily`
- **参数**: `target_date` (YYYY-MM-DD)
- **功能**: 生成指定日期的每日分析

### L7D 分析
- **端点**: `POST /api/l7d`
- **参数**: `end_date` (YYYY-MM-DD, 可选，默认为昨天)
- **功能**: 生成过去7天的 L7D 分析

## 预期结果

### 每日分析
- 为每一天生成一条分析记录
- 包含该日期的 Google Ads 数据和平台数据
- 计算每日指标（展示、点击、费用、佣金等）

### L7D 分析
- 生成一条汇总记录
- 包含过去7天的累计数据
- 计算 L7D 指标（L7D点击、L7D佣金、L7D花费、L7D出单天数等）

## 查看结果

分析结果存储在 `analysis_result` 表中，可以通过以下方式查看：

1. 通过前端界面查看
2. 通过 API 查询：`GET /api/analysis/results`
3. 直接查询数据库

