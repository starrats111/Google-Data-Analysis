# 同步问题解决方案

## 问题分析

### 1. 平台账号同步失败的原因

**问题现象：**
- 点击"同步数据"按钮后，显示"同步失败"或没有反应
- 控制台可能有错误信息

**可能的原因：**
1. **API Token未配置**：账号的备注（notes）字段中没有保存API Token
2. **平台不支持**：该平台的API集成尚未实现（目前只支持CollabGlow和LinkHaitao）
3. **日期范围错误**：选择的日期范围无效
4. **网络问题**：无法连接到平台API服务器

### 2. MCC同步失败的原因

**问题现象：**
- 点击"同步数据"按钮后，显示"同步失败"或"0条数据"
- 控制台可能有错误信息

**可能的原因：**
1. **API配置不完整**：MCC账号缺少以下任一配置：
   - Client ID
   - Client Secret
   - Refresh Token
2. **Developer Token未配置**：系统`.env`文件中缺少`GOOGLE_ADS_SHARED_DEVELOPER_TOKEN`
3. **Google Ads库未安装**：服务器上未安装`google-ads`库
4. **API权限问题**：Google Ads API权限不足或Token过期
5. **MCC下没有客户账号**：MCC账号下没有可访问的客户账号

## 解决方案

### 步骤1：运行诊断脚本

在阿里云服务器上执行以下命令，诊断问题：

```bash
cd ~/Google-Data-Analysis/backend
source venv/bin/activate
python scripts/diagnose_sync_issues.py
```

这个脚本会检查：
- Google Ads库是否安装
- 所有平台账号的API Token配置
- 所有MCC账号的API配置
- 系统的Developer Token配置

### 步骤2：根据诊断结果修复问题

#### 修复平台账号同步问题

**如果显示"未配置API Token"：**
1. 在"平台账号"页面，点击"编辑"按钮
2. 在"备注"字段中，填写JSON格式的Token：
   ```json
   {"collabglow_token": "你的token"}
   ```
   或
   ```json
   {"linkhaitao_token": "你的token"}
   ```
   或
   ```json
   {"api_token": "你的token"}
   ```
3. 点击"确定"保存

**如果显示"平台API集成尚未实现"：**
- 该平台的API集成功能尚未开发
- 目前只支持CollabGlow和LinkHaitao
- 如需支持其他平台，请联系开发人员

#### 修复MCC同步问题

**如果显示"未配置Client ID/Secret/Token"：**
1. 在"MCC账号"页面，点击"编辑"按钮
2. 填写以下字段：
   - Client ID：Google Ads API的客户端ID
   - Client Secret：Google Ads API的客户端密钥
   - Refresh Token：Google Ads API的刷新令牌
3. 点击"确定"保存

**如果显示"Developer Token未配置"：**
1. 在服务器上编辑`.env`文件：
   ```bash
   cd ~/Google-Data-Analysis/backend
   nano .env
   ```
2. 添加以下配置：
   ```
   GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=你的开发者令牌
   ```
3. 保存文件并重启后端服务：
   ```bash
   pkill -f "uvicorn" || true
   nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
   ```

**如果显示"Google Ads库未安装"：**
在服务器上执行：
```bash
cd ~/Google-Data-Analysis/backend
source venv/bin/activate
pip install google-ads
```

### 步骤3：更新代码并重启服务

```bash
cd ~/Google-Data-Analysis
git pull
cd backend
source venv/bin/activate
pkill -f "uvicorn" || true
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &
sleep 3
curl -s http://127.0.0.1:8000/health
```

### 步骤4：测试同步功能

1. **测试平台账号同步：**
   - 进入"平台账号"页面
   - 点击某个账号的"同步数据"按钮
   - 选择日期范围（建议选择最近7天）
   - 如果提示输入Token，填写Token
   - 点击"开始同步"
   - 查看是否显示"成功同步 X 条记录"

2. **测试MCC同步：**
   - 进入"MCC账号"页面
   - 点击某个MCC账号的"同步数据"按钮
   - 查看是否显示"成功同步 X 条广告系列数据"

## 常见错误信息及解决方法

### 错误1："未配置CollabGlow Token"
**解决方法：** 在账号编辑页面的"备注"字段中填写Token

### 错误2："MCC账号缺少API配置"
**解决方法：** 在MCC账号编辑页面填写Client ID、Client Secret和Refresh Token

### 错误3："系统缺少Google Ads开发者令牌"
**解决方法：** 在`.env`文件中配置`GOOGLE_ADS_SHARED_DEVELOPER_TOKEN`

### 错误4："Google Ads API库未安装"
**解决方法：** 执行`pip install google-ads`

### 错误5："Google Ads API错误: UNAUTHENTICATED"
**解决方法：** 
- 检查Client ID、Client Secret、Refresh Token是否正确
- 检查Refresh Token是否过期（需要重新获取）

### 错误6："MCC下没有找到客户账号"
**解决方法：**
- 检查MCC账号是否有权限访问客户账号
- 检查MCC ID是否正确

## 获取Google Ads API凭证的步骤

1. 访问 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建或选择项目
3. 启用"Google Ads API"
4. 创建OAuth 2.0客户端ID和密钥
5. 获取Refresh Token（需要使用OAuth 2.0流程）
6. 申请Developer Token（需要Google Ads账户）

详细步骤请参考：[Google Ads API文档](https://developers.google.com/google-ads/api/docs/oauth/overview)

## 需要帮助？

如果按照以上步骤仍然无法解决问题，请：
1. 运行诊断脚本并保存输出结果
2. 查看后端日志：`tail -n 100 ~/Google-Data-Analysis/backend/run.log`
3. 将诊断结果和日志发送给开发人员

