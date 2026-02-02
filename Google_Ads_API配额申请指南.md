# Google Ads API 配额申请指南

## 当前配额限制

根据日志显示，您的 Google Ads API 遇到了配额限制：
- **错误信息**: `429 Resource has been exhausted (e.g. check quota)`
- **等待时间**: 约 12.7 小时（45875 秒）
- **配额类型**: Explorer Access（探索者访问配额）
- **当前配额**: 每天最多 2,880 次操作（根据官方文档）

## 配额类型说明

根据官方文档，Google Ads API 有以下访问权限级别：

1. **Test Account Access（测试账号访问）**
   - 仅用于测试账号
   - 如果自动审核失败，会降级到此级别

2. **Explorer Access（探索者访问）** ⬅️ **您当前级别**
   - 每天最多 **2,880 次操作**
   - 可用于测试账号和生产账号
   - 功能受限（无法创建账号、用户管理等）
   - 适合开始使用 API 和构建基本自动化功能

3. **Basic Access（基本访问）**
   - 需要申请
   - 配额高于 Explorer
   - 可以使用更多功能

4. **Standard Access（标准访问）** ⬅️ **推荐申请**
   - 需要申请
   - 配额更高（或无限）
   - 可以使用所有 API 功能
   - 适合生产环境使用

## 申请步骤

### 方法 1: 通过 Google Ads API 中心申请 Standard Access（推荐）

根据官方文档，升级到 Standard Access 的步骤如下：

1. **访问 Google Ads API 中心**
   - 网址: https://ads.google.com/aw/apicenter
   - 或通过 Google Ads 经理账号 → API 中心

2. **验证登录状态**
   - 确保已登录 Google Ads 经理账号
   - 如果未登录，系统会提示登录

3. **申请 Standard Access**
   - 在 API 中心页面找到您的开发者令牌
   - 点击 "申请标准访问权限" 或 "Apply for Standard Access"
   - 填写申请表单

4. **填写申请信息**
   - 开发者令牌（22字符的字母数字字符串）
   - 业务使用场景说明
   - 预期 API 调用量
   - 业务规模和需求

### 方法 2: 通过 Google Ads 帮助中心

1. **访问帮助中心**
   - 网址: https://support.google.com/google-ads
   - 选择 "联系我们" 或 "Get Help"

2. **选择问题类型**
   - 选择 "API Access" 或 "开发者令牌"
   - 说明需要升级到 Standard Access

3. **提供必要信息**
   - 开发者令牌
   - MCC 账号信息
   - 业务使用说明

### 方法 3: 通过开发者论坛

1. **访问开发者论坛**
   - Google Ads API 论坛: https://groups.google.com/g/adwords-api
   - 发帖询问 Standard Access 申请流程

2. **获取官方指导**
   - 社区成员或 Google 员工会提供帮助
   - 可以获得最新的申请流程信息

## 申请时需要提供的信息

### 必需信息

1. **开发者令牌 (Developer Token)**
   - 您的 Google Ads API Developer Token
   - 格式: 22字符的字母数字字符串
   - 位置: Google Ads 经理账号 → API 中心页面
   - 如何查找: 登录 Google Ads 经理账号，访问 API 中心即可看到

2. **Google Ads 经理账号信息**
   - 确保已登录正确的经理账号
   - 验证账号状态是否正常

3. **MCC 账号信息**
   - MCC ID（例如: 397-599-6941）
   - MCC 名称
   - 关联的客户账号数量

4. **使用场景说明**
   - 说明您使用 API 的目的（例如：自动化广告数据同步）
   - 预期的请求频率
   - 业务规模（管理的广告系列数量、客户数量等）

5. **当前配额限制**
   - 当前配额类型: Explorer Access
   - 当前配额限制: 2,880 次/天
   - 配额使用情况: 经常在一天内耗尽

6. **申请内容**
   - 申请升级到 Standard Access
   - 说明为什么需要更高配额

### 问题 6 回答示例（公司业务模式和使用 Google Ads 的方式）

**示例 1: 数字营销代理公司**
```
我们是一家数字营销代理公司，为多个客户管理 Google Ads 广告活动。

业务模式：
- 我们管理多个客户的 Google Ads 账号，通过 MCC 账号统一管理
- 为客户提供广告投放、优化和数据分析服务
- 需要定期生成广告效果报告和数据分析

使用 Google Ads API 的方式：
- 使用 API 自动同步广告数据（广告系列、费用、点击、展示等）
- 将数据整合到我们的数据分析平台，为客户提供实时报告
- 自动化数据同步，减少手动操作，提高效率
- 支持多账号批量数据同步和分析

当前问题：
- 使用 Explorer Access（2,880 次/天），配额经常在一天内耗尽
- 无法完成所有客户账号的数据同步，影响业务运营
- 需要升级到 Standard Access 以支持业务增长
```

**示例 2: 广告数据分析平台**
```
我们开发了一个广告数据分析平台，帮助广告主管理和优化 Google Ads 广告活动。

业务模式：
- 提供 SaaS 服务，客户通过我们的平台管理他们的 Google Ads 账号
- 提供数据可视化、报告生成、自动化优化等功能
- 支持多账号、多平台的数据整合分析

使用 Google Ads API 的方式：
- 通过 API 同步客户的广告数据到我们的平台
- 提供实时数据监控和分析功能
- 自动化生成报告和优化建议
- 支持批量账号管理和数据同步

当前问题：
- Explorer Access 配额无法满足多客户、高频次的数据同步需求
- 需要 Standard Access 以支持生产环境的稳定运行
```

**示例 3: 内部广告管理系统**
```
我们是一家电商公司，使用 Google Ads 推广我们的产品。

业务模式：
- 我们有自己的产品和品牌
- 使用 Google Ads 进行产品推广和品牌营销
- 管理多个广告账号和大量广告系列

使用 Google Ads API 的方式：
- 开发内部广告管理系统，统一管理所有广告活动
- 自动化数据同步，减少手动操作
- 整合广告数据与销售数据，进行效果分析
- 自动化报告生成，提高团队工作效率

当前问题：
- 需要同步大量广告系列数据，Explorer Access 配额不足
- 需要 Standard Access 以支持内部系统的稳定运行
```

## 配额类型升级

### Explorer Access → Standard Access（推荐）

根据官方文档，升级步骤：

1. **访问 API 中心**
   - 网址: https://ads.google.com/aw/apicenter
   - 或通过 Google Ads 经理账号导航到 API 中心

2. **验证登录**
   - 确保已登录 Google Ads 经理账号
   - 系统会自动验证您的登录状态

3. **提交申请**
   - 在 API 中心找到您的开发者令牌
   - 点击 "申请标准访问权限" 按钮
   - 填写详细的申请表单

4. **等待审核**
   - 审核时间: 通常 1-2 周
   - 审核期间: 可以继续使用 Explorer Access（2,880 次/天）

### Explorer Access → Basic Access

- 如果只需要中等配额，可以申请 Basic Access
- 申请流程类似 Standard Access
- 配额介于 Explorer 和 Standard 之间

### 注意事项

- **开发者令牌是前提条件**: 必须先有开发者令牌才能申请升级
- **一个令牌对应一个访问级别**: 每个开发者令牌都有独立的访问级别
- **审核是必需的**: 所有升级申请都需要 Google 审核批准

## 临时解决方案

在等待配额增加期间，您可以：

1. **错峰同步**
   - 将同步任务分散到不同时间段
   - 避免在配额重置时间（通常是每小时或每天）集中请求

2. **减少同步频率**
   - 只同步必要的数据
   - 减少重复同步相同日期

3. **分批处理**
   - 将大量账号分批同步
   - 在批次之间添加延迟

4. **使用缓存**
   - 缓存已同步的数据
   - 避免重复请求相同数据

## 检查配额状态

### 通过 API 检查

```python
from google.ads.googleads.client import GoogleAdsClient

client = GoogleAdsClient.load_from_dict({
    "developer_token": "YOUR_DEVELOPER_TOKEN",
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "refresh_token": "YOUR_REFRESH_TOKEN",
    "use_proto_plus": True
})

# 查询配额信息（如果 API 支持）
# 注意：Google Ads API 可能不直接提供配额查询接口
```

### 通过 Google Cloud Console

1. 访问: https://console.cloud.google.com/
2. 选择项目
3. 导航到 "API 和服务" → "配额"
4. 搜索 "Google Ads API"
5. 查看配额限制和使用情况

## 联系信息

### Google Ads API 支持
- **支持页面**: https://developers.google.com/google-ads/api/support
- **帮助中心**: https://support.google.com/google-ads
- **开发者论坛**: https://groups.google.com/g/adwords-api
- **文档**: https://developers.google.com/google-ads/api/docs

### 紧急情况
- 如果配额问题严重影响业务，可以通过 Google Ads 账号内的 "联系我们" 功能
- 选择 "API 访问问题" 作为问题类型

## 重要注意事项

### 申请前必读

1. **API 联系邮箱** ⚠️ 关键
   - 必须使用基于角色的邮箱（如 info@company.com）
   - 避免使用个人邮箱
   - 邮箱必须保持最新，否则可能被降级或终止令牌
   - 确保邮箱活跃，能及时回复审核团队的邮件

2. **公司类型** ⚠️ 关键
   - 必须准确描述您将如何使用 Google Ads API
   - 如果公司类型不正确，申请流程会延迟
   - 在 API Center 的 Developer Details 中检查并更新

3. **设计文档** ⚠️ 必需
   - 必须提供详细的设计文档
   - 格式: .pdf, .doc, 或 .rtf
   - 如果设计文档未准备好，申请会被拒绝
   - 可以参考示例设计文档

4. **审核时间**
   - 标准审核: 通常 3 个工作日
   - 复杂审核: 可能需要更长时间
   - Google 保留优先审核的权利（系统稳定性优先）

5. **申请成功率**
   - 提供详细的业务说明可以提高成功率
   - 说明实际业务需求，而非技术需求
   - 确保所有信息准确无误
   - 设计文档必须完整详细

6. **配额限制**
   - 即使获得 Standard Access，仍可能有速率限制
   - 建议实现请求限流和重试机制
   - 监控配额使用情况，避免再次耗尽

## 系统改进建议

在等待配额增加期间，我们已经实现了以下改进：

1. ✅ **自动重试机制**: 遇到配额错误时自动重试（指数退避）
2. ✅ **请求延迟**: 在请求之间添加延迟，避免触发速率限制
3. ✅ **错误处理**: 跳过未启用的客户账号，继续处理其他账号
4. ✅ **友好提示**: 显示准确的等待时间

这些改进可以帮助您更好地管理配额使用，减少配额耗尽的情况。

