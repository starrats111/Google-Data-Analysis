# API功能实现说明

## 已完成的功能

### 1. MCC账号管理
- **后端API**: `/api/mcc/*`
- **前端页面**: `MccAccounts.jsx`
- **功能**:
  - 添加、编辑、删除MCC账号
  - 配置Google Ads API凭证
  - 手动触发数据同步

### 2. 平台数据查看
- **后端API**: `/api/platform-data`
- **前端页面**: `PlatformData.jsx`
- **功能**:
  - 按平台、账号、日期筛选查看佣金和订单数据
  - 数据汇总统计
  - 导出数据

### 3. Google Ads数据查看
- **后端API**: `/api/google-ads-data`
- **前端页面**: `GoogleAdsData.jsx`
- **功能**:
  - 按MCC、平台、日期筛选查看广告数据
  - 查看广告系列明细
  - 数据汇总统计

### 4. MCC数据聚合
- **后端API**: `/api/mcc/aggregate`
- **前端页面**: `MccDataAggregate.jsx`
- **功能**:
  - 将所有MCC的Google Ads数据按平台和账号聚合
  - 查看聚合后的数据明细

### 5. 基于API的自动分析
- **后端API**: 
  - `/api/analysis/api/daily` - 从API数据生成每日分析
  - `/api/analysis/api/l7d` - 从API数据生成L7D分析
- **前端功能**: 在分析页面添加"从API数据生成分析"按钮
- **功能**:
  - 自动从平台数据和Google Ads数据生成分析结果
  - 保存分析结果到数据库

### 6. 定时任务
- **平台数据同步**: 每天4点和16点自动同步
- **Google Ads数据同步**: 每天早上8点自动同步
- **每日分析**: 每天早上8:05自动执行

## 数据库迁移

### 1. 创建新表
```bash
cd backend
python scripts/create_api_tables.py
```

### 2. 添加analysis_type列
```bash
python scripts/add_analysis_type_column.py
```

## 使用流程

### 1. 配置MCC账号
1. 进入"MCC账号"页面
2. 点击"添加MCC账号"
3. 填写MCC信息（ID、名称、邮箱）
4. （可选）配置Google Ads API凭证

### 2. 同步数据
- **自动同步**: 系统会在指定时间自动同步
- **手动同步**: 
  - 平台数据：在"联盟账号"页面点击"同步数据"
  - Google Ads数据：在"MCC账号"页面点击"同步数据"

### 3. 查看数据
- **平台数据**: 进入"平台数据"页面查看
- **Google Ads数据**: 进入"Google Ads数据"页面查看
- **MCC聚合数据**: 进入"MCC数据聚合"页面查看

### 4. 生成分析
- **每日分析**: 在"每日分析"页面点击"从API数据生成每日分析"
- **L7D分析**: 在"L7D分析"页面点击"从API数据生成L7D分析"

## 待完善的功能

### 1. Google Ads API实际集成
- 当前`google_ads_api_sync.py`中的`_fetch_google_ads_data`方法只是框架
- 需要安装`google-ads-api`库并实现实际的API调用

### 2. 广告系列匹配规则管理
- 当前`CampaignMatcher`使用简单的正则匹配
- 可以添加前端页面让用户自定义匹配规则

### 3. 数据同步错误处理
- 添加更详细的错误日志
- 添加失败重试机制
- 添加通知功能（邮件/短信）

### 4. 性能优化
- 大数据量时的分页查询
- 数据同步的并发处理
- 缓存机制

## 注意事项

1. **定时任务**: 确保服务器时间正确，定时任务才能准确执行
2. **API凭证**: Google Ads API需要有效的OAuth凭证才能正常工作
3. **数据权限**: 员工只能查看和操作自己的数据，经理可以查看所有数据
4. **数据同步频率**: 平台数据每天同步2次（4点和16点），因为佣金可能会延迟更新


