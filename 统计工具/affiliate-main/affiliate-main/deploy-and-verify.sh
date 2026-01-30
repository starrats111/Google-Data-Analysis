#!/bin/bash

echo "🚀 提现管理 - 部署和验证"
echo ""
echo "=".repeat(60)

# 步骤 1: 验证准备状态
echo ""
echo "📋 步骤 1/3: 验证准备状态..."
node verify-ready-to-deploy.js

if [ $? -ne 0 ]; then
  echo ""
  echo "❌ 验证失败，请先修复问题"
  exit 1
fi

# 步骤 2: 部署
echo ""
echo "📋 步骤 2/3: 部署到 Railway..."
echo ""

if [[ -n $(git status -s) ]]; then
  echo "📝 提交更改..."
  git add .
  git commit -m "fix: 修复提现管理数据显示 - 确保 settlement 字段正确保存和显示"
  echo "✅ 提交完成"
else
  echo "ℹ️  没有新的更改"
fi

echo ""
echo "📤 推送到 Railway..."
git push

if [ $? -ne 0 ]; then
  echo ""
  echo "❌ 推送失败"
  exit 1
fi

echo ""
echo "✅ 推送成功！"

# 步骤 3: 显示验证说明
echo ""
echo "📋 步骤 3/3: 验证部署..."
echo ""
echo "⏳ 等待 Railway 部署完成（通常需要 1-2 分钟）"
echo ""
echo "然后访问: https://your-domain/admin.html"
echo ""
echo "预期结果:"
echo "  ✅ 💰 可提现金额: $4,906.38"
echo "  ✅ 显示 3 个账号"
echo "  ✅ 每个账号显示正确金额"
echo ""
echo "⚠️  注意: 无需点击'同步数据'按钮！"
echo ""
echo "📖 详细说明: 立即部署.md"
echo ""
echo "=".repeat(60)
echo ""
echo "🎉 部署完成！"
