# 员工添加MCC账号 - 快速参考

## 🎯 最简单方式（3步）

### 1️⃣ 获取刷新令牌

```bash
# 向经理要：客户端ID 和 客户端密钥

# Windows PowerShell
$env:GOOGLE_ADS_SHARED_CLIENT_ID="经理给的客户端ID"
$env:GOOGLE_ADS_SHARED_CLIENT_SECRET="经理给的客户端密钥"
python backend/scripts/get_google_ads_refresh_token.py

# 复制输出的"刷新令牌"
```

### 2️⃣ 在系统添加

1. 登录系统 → 进入"MCC账号"页面
2. 点击"添加MCC账号"
3. 填写：
   - **MCC账号ID**：`941-949-6301`（你的账号）
   - **刷新令牌**：从步骤1复制的
4. 点击"确定"

### 3️⃣ 测试

点击"测试连接" → 显示"连接成功" ✅

---

## 📞 需要帮助？

- 详细步骤：查看 `docs/员工配置MCC账号指南.md`
- 还是不会？联系经理

