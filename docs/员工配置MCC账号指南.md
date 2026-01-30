# 员工配置MCC账号 - 简单指南

## 方案一：使用共享配置（最简单，推荐）

如果经理已经配置了共享的客户端ID、密钥和开发者令牌，员工只需要：

### 步骤1：获取自己的刷新令牌

1. 打开文件：`backend/scripts/get_google_ads_refresh_token.py`
2. 修改脚本中的客户端ID和密钥（使用经理提供的共享配置）
3. 运行脚本获取刷新令牌

### 步骤2：在系统中添加MCC账号

1. 登录系统
2. 进入"MCC账号"页面
3. 点击"添加MCC账号"
4. **只需要填写**：
   - **MCC账号ID**：你的Google Ads MCC账号ID
   - **刷新令牌**：从步骤1获取的刷新令牌
   - **账号名称**：可选，给你的账号起个名字
   - **邮箱**：可选
5. 点击"确定"保存
6. 点击"测试连接"验证

---

## 方案二：完全自己配置

如果经理没有配置共享配置，员工需要自己配置所有信息：

### 需要准备的信息

1. **MCC账号ID** - 从Google Ads获取
2. **开发者令牌** - 从Google Ads API中心申请
3. **客户端ID** - 从Google Cloud Console创建
4. **客户端密钥** - 从Google Cloud Console创建
5. **刷新令牌** - 使用脚本获取

### 详细步骤

参考：`docs/Google_Ads_API_配置_简单版.md`

---

## 快速获取刷新令牌（使用共享配置）

如果经理已经提供了共享的客户端ID和密钥：

### 方法1：修改脚本

1. 打开：`backend/scripts/get_google_ads_refresh_token.py`
2. 修改这两行：
   ```python
   CLIENT_ID = '经理提供的客户端ID'
   CLIENT_SECRET = '经理提供的客户端密钥'
   ```
3. 运行脚本：
   ```cmd
   python backend/scripts/get_google_ads_refresh_token.py
   ```
4. 完成授权，复制刷新令牌

### 方法2：使用环境变量

```cmd
set GOOGLE_ADS_CLIENT_ID=经理提供的客户端ID
set GOOGLE_ADS_CLIENT_SECRET=经理提供的客户端密钥
python backend/scripts/get_google_ads_refresh_token.py
```

---

## 常见问题

### Q1: 我没有Google Cloud账号怎么办？

**A**: 如果经理配置了共享配置，你不需要Google Cloud账号，只需要获取刷新令牌即可。

### Q2: 我没有开发者令牌怎么办？

**A**: 如果经理配置了共享配置，你不需要开发者令牌，系统会自动使用共享的。

### Q3: 刷新令牌过期了怎么办？

**A**: 重新运行脚本获取新的刷新令牌，然后在系统中更新MCC账号的刷新令牌。

---

## 经理需要做什么

如果想让员工使用最简单的配置方式，经理需要：

1. 在系统配置文件中设置共享配置（需要修改后端代码）
2. 或者告诉员工共享的客户端ID和密钥，让员工自己获取刷新令牌

