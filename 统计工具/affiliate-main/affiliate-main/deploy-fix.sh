#!/bin/bash

echo "🚀 部署提现管理修复..."
echo ""

# 检查是否有未提交的更改
if [[ -n $(git status -s) ]]; then
  echo "📝 发现未提交的更改，正在提交..."
  git add .
  git commit -m "fix: 修复提现管理数据显示问题 - 确保 settlement 字段正确保存"
  echo "✅ 提交完成"
else
  echo "ℹ️  没有新的更改需要提交"
fi

echo ""
echo "📤 推送到 Railway..."
git push

echo ""
echo "✅ 部署完成！"
echo ""
echo "📋 接下来的步骤："
echo "1. 等待 Railway 部署完成（1-2分钟）"
echo "2. 访问 https://your-domain/admin.html"
echo "3. 登录超级管理员账号"
echo "4. 点击左侧'提现管理'"
echo "5. 应该看到："
echo "   💰 可提现金额: $4,906.38"
echo "   🏢 3个账号都显示正确金额"
echo ""
echo "⚠️  注意：无需点击'同步数据'按钮，数据已经在数据库中！"
echo ""
echo "📖 详细说明请查看: WITHDRAWAL_LOGIC_FINAL_FIX.md"
