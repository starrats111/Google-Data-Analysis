#!/bin/bash
# 07的新令牌关联OAuth脚本 - 更新配置

echo "=== 新令牌关联OAuth配置 ==="
echo ""

# 新令牌
NEW_TOKEN="hWBTxgYlOiWB4XfXQl_UfA"

echo "步骤1: 检查当前配置..."
cd ~/Google-Data-Analysis/backend || exit 1

if [ ! -f .env ]; then
    echo "❌ 找不到.env文件"
    exit 1
fi

echo "✅ 找到.env文件"
echo ""

echo "步骤2: 当前配置"
echo "  当前CLIENT_ID: $(grep GOOGLE_ADS_SHARED_CLIENT_ID .env | cut -d'=' -f2)"
echo "  当前DEVELOPER_TOKEN: $(grep GOOGLE_ADS_SHARED_DEVELOPER_TOKEN .env | cut -d'=' -f2)"
echo ""

echo "步骤3: 需要你手动完成以下操作"
echo ""
echo "1. 登录 Google Cloud Console: https://console.cloud.google.com/"
echo "2. 选择项目: endless-sol-485904-h1 (或新令牌关联的项目)"
echo "3. 进入 'APIs & Services' > 'Credentials'"
echo "4. 点击 '+ CREATE CREDENTIALS' > 'OAuth client ID'"
echo "5. 应用类型选择: 'Desktop app'"
echo "6. 名称填写: 'Google Ads API Client'"
echo "7. 点击 'CREATE'"
echo "8. 复制显示的 Client ID 和 Client Secret"
echo ""

echo "步骤4: 更新配置"
echo ""
read -p "请输入新的 Client ID: " NEW_CLIENT_ID
read -p "请输入新的 Client Secret: " NEW_CLIENT_SECRET

if [ -z "$NEW_CLIENT_ID" ] || [ -z "$NEW_CLIENT_SECRET" ]; then
    echo "❌ Client ID 或 Client Secret 不能为空"
    exit 1
fi

# 更新.env文件
echo ""
echo "正在更新.env文件..."

# 备份
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
echo "✅ 已备份.env文件"

# 更新CLIENT_ID
sed -i "s|^GOOGLE_ADS_SHARED_CLIENT_ID=.*|GOOGLE_ADS_SHARED_CLIENT_ID=$NEW_CLIENT_ID|" .env

# 更新CLIENT_SECRET
sed -i "s|^GOOGLE_ADS_SHARED_CLIENT_SECRET=.*|GOOGLE_ADS_SHARED_CLIENT_SECRET=$NEW_CLIENT_SECRET|" .env

# 确保DEVELOPER_TOKEN正确
sed -i "s|^GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=.*|GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=$NEW_TOKEN|" .env

echo "✅ 配置已更新"
echo ""

echo "步骤5: 验证配置"
source venv/bin/activate
python3 << EOF
from app.config import settings
print(f"CLIENT_ID: {settings.google_ads_shared_client_id[:30]}...")
print(f"CLIENT_SECRET: {settings.google_ads_shared_client_secret[:10]}...")
print(f"DEVELOPER_TOKEN: {settings.google_ads_shared_developer_token[:10]}...")
EOF

echo ""
echo "=== 完成 ==="
echo ""
echo "下一步: 重启服务并测试"
echo "运行: pkill -9 -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &"


# 07的新令牌关联OAuth脚本 - 更新配置

echo "=== 新令牌关联OAuth配置 ==="
echo ""

# 新令牌
NEW_TOKEN="hWBTxgYlOiWB4XfXQl_UfA"

echo "步骤1: 检查当前配置..."
cd ~/Google-Data-Analysis/backend || exit 1

if [ ! -f .env ]; then
    echo "❌ 找不到.env文件"
    exit 1
fi

echo "✅ 找到.env文件"
echo ""

echo "步骤2: 当前配置"
echo "  当前CLIENT_ID: $(grep GOOGLE_ADS_SHARED_CLIENT_ID .env | cut -d'=' -f2)"
echo "  当前DEVELOPER_TOKEN: $(grep GOOGLE_ADS_SHARED_DEVELOPER_TOKEN .env | cut -d'=' -f2)"
echo ""

echo "步骤3: 需要你手动完成以下操作"
echo ""
echo "1. 登录 Google Cloud Console: https://console.cloud.google.com/"
echo "2. 选择项目: endless-sol-485904-h1 (或新令牌关联的项目)"
echo "3. 进入 'APIs & Services' > 'Credentials'"
echo "4. 点击 '+ CREATE CREDENTIALS' > 'OAuth client ID'"
echo "5. 应用类型选择: 'Desktop app'"
echo "6. 名称填写: 'Google Ads API Client'"
echo "7. 点击 'CREATE'"
echo "8. 复制显示的 Client ID 和 Client Secret"
echo ""

echo "步骤4: 更新配置"
echo ""
read -p "请输入新的 Client ID: " NEW_CLIENT_ID
read -p "请输入新的 Client Secret: " NEW_CLIENT_SECRET

if [ -z "$NEW_CLIENT_ID" ] || [ -z "$NEW_CLIENT_SECRET" ]; then
    echo "❌ Client ID 或 Client Secret 不能为空"
    exit 1
fi

# 更新.env文件
echo ""
echo "正在更新.env文件..."

# 备份
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
echo "✅ 已备份.env文件"

# 更新CLIENT_ID
sed -i "s|^GOOGLE_ADS_SHARED_CLIENT_ID=.*|GOOGLE_ADS_SHARED_CLIENT_ID=$NEW_CLIENT_ID|" .env

# 更新CLIENT_SECRET
sed -i "s|^GOOGLE_ADS_SHARED_CLIENT_SECRET=.*|GOOGLE_ADS_SHARED_CLIENT_SECRET=$NEW_CLIENT_SECRET|" .env

# 确保DEVELOPER_TOKEN正确
sed -i "s|^GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=.*|GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=$NEW_TOKEN|" .env

echo "✅ 配置已更新"
echo ""

echo "步骤5: 验证配置"
source venv/bin/activate
python3 << EOF
from app.config import settings
print(f"CLIENT_ID: {settings.google_ads_shared_client_id[:30]}...")
print(f"CLIENT_SECRET: {settings.google_ads_shared_client_secret[:10]}...")
print(f"DEVELOPER_TOKEN: {settings.google_ads_shared_developer_token[:10]}...")
EOF

echo ""
echo "=== 完成 ==="
echo ""
echo "下一步: 重启服务并测试"
echo "运行: pkill -9 -f 'uvicorn.*app.main' && sleep 2 && nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > run.log 2>&1 &"












