# 在线获取Google Ads API Refresh Token - 使用说明

## 功能说明

现在员工可以直接在网页上获取Google Ads API的Refresh Token，无需手动操作。

## 使用步骤

### 前提条件

1. **在Google Cloud Console中配置OAuth 2.0客户端**
   - 访问 [Google Cloud Console](https://console.cloud.google.com/)
   - 创建或选择项目
   - 启用"Google Ads API"
   - 创建OAuth 2.0客户端ID和密钥
   - **重要**：在"已授权的重定向URI"中添加：
     ```
     https://google-data-analysis.top/google-oauth-callback
     ```
     或
     ```
     https://www.google-data-analysis.top/google-oauth-callback
     ```
     （根据你的实际域名）

2. **获取Client ID和Client Secret**
   - 从Google Cloud Console中复制Client ID和Client Secret

### 操作步骤

1. **进入MCC账号管理页面**
   - 点击左侧菜单"MCC账号"
   - 点击"添加MCC账号"或点击已有账号的"编辑"按钮

2. **填写基本信息**
   - MCC ID
   - MCC名称
   - 邮箱

3. **填写API配置**
   - Client ID：粘贴从Google Cloud Console获取的Client ID
   - Client Secret：粘贴从Google Cloud Console获取的Client Secret
   - Refresh Token：点击"在线获取"按钮

4. **获取Refresh Token**
   - 点击"在线获取"后，会弹出"获取Google Ads API Refresh Token"对话框
   - **步骤1：输入信息**
     - Client ID和Client Secret会自动填充（如果已填写）
     - 确认回调URL是否正确
     - 点击"获取授权URL"按钮
   
   - **步骤2：授权**
     - 点击"打开授权页面"按钮（会在新窗口打开）
     - 在新窗口中登录Google账号（使用MCC账号对应的Google账号）
     - 完成授权（勾选权限并点击"允许"）
     - 授权完成后，页面会跳转到回调页面，显示授权码
     - 复制授权码
     - 回到原页面，粘贴授权码到输入框
     - 点击"获取Token"按钮
   
   - **步骤3：完成**
     - 如果成功，Refresh Token会自动填充到主表单中
     - 点击"完成"关闭对话框
     - 点击"确定"保存MCC账号配置

## 注意事项

1. **回调URL配置**
   - 必须在Google Cloud Console中配置正确的回调URL
   - 回调URL格式：`https://你的域名/google-oauth-callback`
   - 如果配置错误，授权后会显示错误

2. **Google账号**
   - 必须使用MCC账号对应的Google账号登录
   - 该账号必须有访问Google Ads API的权限

3. **权限范围**
   - 授权时会请求`https://www.googleapis.com/auth/adwords`权限
   - 这是Google Ads API所需的最小权限

4. **Refresh Token有效期**
   - Refresh Token长期有效，除非：
     - 用户撤销了授权
     - 6个月未使用（Google可能会撤销）
   - 如果Refresh Token过期，需要重新获取

## 常见问题

### Q: 点击"获取授权URL"后没有反应？
A: 检查浏览器控制台是否有错误，可能是Client ID格式错误。

### Q: 授权后显示"redirect_uri_mismatch"错误？
A: 回调URL未在Google Cloud Console中配置，请按照前提条件中的步骤配置。

### Q: 授权后没有显示授权码？
A: 检查回调URL是否正确配置，或者查看浏览器控制台的错误信息。

### Q: 获取Token时显示"invalid_grant"错误？
A: 授权码可能已过期（通常5分钟内有效），请重新获取授权码。

### Q: Refresh Token获取成功但同步失败？
A: 检查：
   - Developer Token是否在.env文件中配置
   - Client ID、Client Secret、Refresh Token是否正确
   - Google账号是否有访问MCC的权限

## 技术说明

- **授权流程**：OAuth 2.0 Authorization Code Flow
- **授权端点**：`https://accounts.google.com/o/oauth2/v2/auth`
- **Token端点**：`https://oauth2.googleapis.com/token`
- **权限范围**：`https://www.googleapis.com/auth/adwords`

## 需要帮助？

如果遇到问题，请：
1. 检查浏览器控制台的错误信息
2. 检查后端日志：`tail -n 50 ~/Google-Data-Analysis/backend/run.log`
3. 确认Google Cloud Console中的配置是否正确

