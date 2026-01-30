# Google Ads API 配置指南

本指南将帮助你获取Google Ads API所需的所有配置信息。

## 前置要求

1. Google账号（用于访问Google Ads）
2. Google Ads账号（MCC账号或普通账号）
3. Google Cloud账号（用于创建API项目）

---

## 第一步：创建Google Cloud项目

### 1.1 访问Google Cloud Console

1. 访问：https://console.cloud.google.com/
2. 使用你的Google账号登录

### 1.2 创建新项目

1. 点击页面顶部的项目选择器
2. 点击"新建项目"
3. 输入项目名称（例如：`Google Ads Analysis`）
4. 点击"创建"
5. 等待项目创建完成（通常几秒钟）

### 1.3 启用Google Ads API

1. 在项目选择器中选择刚创建的项目
2. 访问：https://console.cloud.google.com/apis/library/googleads.googleapis.com
3. 点击"启用"按钮
4. 等待API启用完成

---

## 第二步：创建OAuth 2.0凭证

### 2.1 配置OAuth同意屏幕

1. 访问：https://console.cloud.google.com/apis/credentials/consent
2. 选择"外部"（如果只是自己使用，可以选择"内部"）
3. 点击"创建"
4. 填写应用信息：
   - **应用名称**：Google Ads Analysis（或你喜欢的名称）
   - **用户支持电子邮件**：你的邮箱
   - **开发者联系信息**：你的邮箱
5. 点击"保存并继续"
6. 在"作用域"页面，点击"保存并继续"（暂时不需要添加作用域）
7. 在"测试用户"页面（如果是外部应用），点击"添加用户"，添加你的Google账号邮箱
8. 点击"保存并继续"
9. 在"摘要"页面，点击"返回到信息中心"

### 2.2 创建OAuth客户端ID

1. 访问：https://console.cloud.google.com/apis/credentials
2. 点击"创建凭证" → "OAuth客户端ID"
3. 如果提示配置OAuth同意屏幕，按照上面的步骤完成
4. 选择应用类型：**"桌面应用"** 或 **"Web应用"**
   - 如果是桌面应用，名称可以填写：`Google Ads API Client`
   - 如果是Web应用，需要添加授权重定向URI（例如：`http://localhost:8000/oauth/callback`）
5. 点击"创建"
6. **重要**：复制并保存以下信息：
   - **客户端ID**（Client ID）
   - **客户端密钥**（Client Secret）

---

## 第三步：获取开发者令牌（Developer Token）

### 3.1 访问Google Ads账号

1. 访问：https://ads.google.com/
2. 使用你的Google Ads账号登录

### 3.2 申请开发者令牌

1. 点击右上角的工具图标（🔧）
2. 在"设置"下，点击"API中心"
3. 如果还没有开发者令牌，点击"申请开发者令牌"
4. 填写申请表单：
   - **应用名称**：Google Ads Analysis
   - **应用类型**：选择"其他"或"数据分析工具"
   - **应用用途**：描述你的应用用途（例如：用于分析广告数据，生成报告）
   - **联系信息**：你的邮箱和电话
5. 提交申请
6. **注意**：Google通常需要1-2个工作日审核申请
7. 审核通过后，你会在"API中心"看到你的**开发者令牌**（Developer Token）

---

## 第四步：获取刷新令牌（Refresh Token）

### 4.1 使用OAuth 2.0 Playground（推荐方法）

1. 访问：https://developers.google.com/oauthplayground/
2. 点击右上角的设置图标（⚙️）
3. 勾选"Use your own OAuth credentials"
4. 输入你的**客户端ID**和**客户端密钥**
5. 点击"关闭"

### 4.2 授权Google Ads API

1. 在左侧API列表中找到"Google Ads API"
2. 展开并选择以下作用域：
   - `https://www.googleapis.com/auth/adwords`
3. 点击"Authorize APIs"
4. 登录你的Google账号并授权
5. 点击"Exchange authorization code for tokens"
6. 复制**刷新令牌**（Refresh Token）

### 4.3 或者使用Python脚本获取（更专业）

创建一个Python脚本：

```python
from google_auth_oauthlib.flow import InstalledAppFlow
import json

# OAuth 2.0配置
SCOPES = ['https://www.googleapis.com/auth/adwords']
CLIENT_ID = '你的客户端ID'
CLIENT_SECRET = '你的客户端密钥'
REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'  # 桌面应用使用

# 创建OAuth流程
flow = InstalledAppFlow.from_client_config(
    {
        "installed": {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [REDIRECT_URI]
        }
    },
    SCOPES
)

# 获取授权
credentials = flow.run_console()

# 保存凭证
with open('google_ads_credentials.json', 'w') as f:
    json.dump({
        'refresh_token': credentials.refresh_token,
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'token_uri': credentials.token_uri
    }, f)

print(f"刷新令牌: {credentials.refresh_token}")
```

---

## 第五步：获取MCC账号ID

### 5.1 登录Google Ads

1. 访问：https://ads.google.com/
2. 使用你的MCC账号登录

### 5.2 查找MCC账号ID

1. 在Google Ads界面，点击右上角的账号选择器
2. 选择你的MCC账号
3. 在URL中可以看到账号ID，格式类似：`https://ads.google.com/aw/overview?__c=1234567890`
4. 其中 `1234567890` 就是你的**MCC账号ID**

---

## 第六步：配置到系统中

### 6.1 在系统中添加MCC账号

1. 登录系统
2. 进入"MCC管理"页面（需要创建）
3. 点击"添加MCC账号"
4. 填写以下信息：
   - **MCC账号ID**：从第五步获取
   - **MCC账号名称**：给你的MCC账号起个名字
   - **邮箱**：关联的邮箱
   - **客户端ID**：从第二步获取
   - **客户端密钥**：从第二步获取
   - **刷新令牌**：从第四步获取
   - **开发者令牌**：从第三步获取
5. 点击"保存"

### 6.2 测试连接

1. 在MCC账号列表中，点击"测试连接"
2. 如果配置正确，应该显示"连接成功"
3. 如果失败，检查所有配置信息是否正确

---

## 常见问题

### Q1: 开发者令牌申请被拒绝怎么办？

**A**: 
- 确保填写了详细的申请信息
- 说明你的应用是用于数据分析，不会修改广告设置
- 如果被拒绝，可以联系Google Ads API支持团队

### Q2: 刷新令牌过期了怎么办？

**A**: 
- 刷新令牌通常不会过期（除非你撤销了授权）
- 如果过期，需要重新授权获取新的刷新令牌

### Q3: 可以使用测试账号吗？

**A**: 
- 可以，Google Ads提供测试账号用于开发
- 访问：https://developers.google.com/google-ads/api/docs/first-call/test-account
- 测试账号的开发者令牌是：`TEST_DEVELOPER_TOKEN`

### Q4: 多个MCC账号怎么办？

**A**: 
- 每个MCC账号都需要单独配置
- 在系统中为每个MCC账号创建一条记录
- 系统会自动汇总所有MCC账号的数据

---

## 安全建议

1. **不要将凭证提交到Git仓库**
   - 使用环境变量存储敏感信息
   - 在`.gitignore`中排除凭证文件

2. **定期轮换密钥**
   - 建议每3-6个月更新一次OAuth凭证

3. **限制访问权限**
   - 只给需要的人访问权限
   - 使用最小权限原则

---

## 下一步

配置完成后，系统将能够：
1. 自动从Google Ads API获取广告数据
2. 每天定时同步数据
3. 自动匹配广告系列到平台账号
4. 生成每日分析和L7D分析

如有问题，请查看Google Ads API官方文档：
https://developers.google.com/google-ads/api/docs/start

