#!/bin/bash

# 部署脚本 - 联盟营销数据采集系统
# 使用方法: bash deploy.sh

set -e  # 遇到错误立即退出

echo "🚀 开始部署联盟营销SaaS系统..."
echo "================================"

# 1. 更新代码
echo "📥 拉取最新代码..."
git pull origin main

# 2. 安装依赖
echo "📦 安装依赖包..."
npm install --production

# 3. 检查环境变量
if [ ! -f .env ]; then
  echo "⚠️  未发现 .env 文件，从示例文件创建..."
  cp .env.example .env
  echo "❗ 请编辑 .env 文件配置生产环境变量"
  exit 1
fi

# 4. 数据库初始化（如果需要）
echo "🗄️  初始化数据库..."
# 数据库会在服务启动时自动初始化

# 5. 停止旧服务
echo "🛑 停止旧服务..."
pm2 stop affiliate-saas || echo "没有运行中的服务"

# 6. 启动新服务
echo "▶️  启动服务..."
pm2 start ecosystem.config.js --env production

# 7. 保存 PM2 配置
echo "💾 保存 PM2 配置..."
pm2 save

# 8. 查看服务状态
echo "✅ 部署完成！服务状态："
pm2 status

echo ""
echo "================================"
echo "📊 监控命令:"
echo "  pm2 logs affiliate-saas  # 查看日志"
echo "  pm2 monit                # 实时监控"
echo "  pm2 restart affiliate-saas  # 重启服务"
echo "================================"
