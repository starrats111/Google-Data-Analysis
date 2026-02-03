# 如何获取各平台的API Token

## CreatorFlare (CF)

1. 登录 CreatorFlare 平台后台
2. 进入 **API设置** 或 **开发者设置** 页面
3. 找到 **API Token** 或 **Access Token**
4. 复制Token（通常是一串字符）

**API文档位置：**
- 通常在后台的"API"或"开发者"菜单中
- 或者联系平台客服获取

## LinkBux (LB)

1. 登录 LinkBux 平台后台
2. 进入 **渠道设置** 或 **API设置** 页面
3. 选择对应的渠道（Channel）
4. 找到该渠道的 **Token**
5. 复制Token

**API文档位置：**
- 后台 → API设置 → Transaction API
- Token通常与渠道（Channel）关联

## PartnerBoost (PB)

1. 登录 PartnerBoost 平台后台
2. 进入 **渠道管理** 或 **API设置** 页面
3. 选择对应的渠道（Channel）
4. 找到该渠道的 **Token**
5. 复制Token

**API文档位置：**
- 后台 → API设置 → Transaction API
- Token通常与渠道（Channel）关联

## PartnerMatic (PM)

1. 登录 PartnerMatic 平台后台
2. 进入 **API设置** 或 **开发者设置** 页面
3. 找到 **API Token** 或 **Access Token**
4. 复制Token（通常是一串字符）

**API文档位置：**
- 通常在后台的"API"或"开发者"菜单中
- 或者联系平台客服获取

## 注意事项

1. **Token安全**：
   - Token相当于密码，请妥善保管
   - 不要将Token分享给他人
   - 如果Token泄露，及时在平台后台重新生成

2. **Token格式**：
   - 通常是一串字母数字组合
   - 长度可能从几十到几百个字符不等
   - 可能包含特殊字符

3. **Token权限**：
   - 确保Token有读取交易数据的权限
   - 某些平台可能需要单独申请API访问权限

4. **获取帮助**：
   - 如果找不到Token，可以联系平台客服
   - 说明需要API Token用于数据同步
   - 提供你的账号信息以便客服协助

## 测试Token

获取Token后，可以使用测试脚本验证：

```bash
cd backend && source venv/bin/activate
python test_new_platforms.py "cf_token,lb_token,pb_token,pm_token"
```

如果Token有效，会显示成功获取的数据；如果无效，会显示错误信息。

