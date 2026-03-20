#!/bin/bash
# ─── 广告自动化发布 生产环境启动脚本 ───
# 适配 2核2G + 40G 硬盘服务器
#
# 用法：
#   chmod +x deploy.sh
#   ./deploy.sh          # 首次部署
#   ./deploy.sh restart  # 重启

set -e

APP_DIR="$HOME/Google-Data-Analysis/crm-mvp"
PORT=20050
LOG_DIR="$APP_DIR/logs"

# ─── Node.js 内存限制 ───
# 2G 总内存，分配给 Node.js 最多 768MB
# 剩余给 MySQL (~500MB) + 系统 (~700MB)
export NODE_OPTIONS="--max-old-space-size=768"

# ─── 颜色输出 ───
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  广告自动化发布 部署${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"

cd "$APP_DIR"
mkdir -p "$LOG_DIR"

# ─── 检查内存 ───
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
AVAIL_MEM=$(free -m | awk '/^Mem:/{print $7}')
echo -e "${YELLOW}系统内存: ${TOTAL_MEM}MB 总计 / ${AVAIL_MEM}MB 可用${NC}"

if [ "$AVAIL_MEM" -lt 400 ]; then
  echo -e "${YELLOW}⚠ 可用内存不足 400MB，建议先清理内存${NC}"
  echo "  运行: sync && echo 3 > /proc/sys/vm/drop_caches"
fi

# ─── 安装依赖 ───
if [ "$1" != "restart" ]; then
  echo "📦 安装依赖..."
  npm ci --production --ignore-scripts 2>/dev/null || npm install --production
  
  echo "🔨 构建项目..."
  npm run build 2>&1 | tail -5
  
  echo "🗄️ 同步数据库..."
  npx prisma migrate deploy 2>&1 | tail -3
  
  echo "🌱 初始化种子数据..."
  npm run seed 2>&1 | tail -5
fi

# ─── 停止旧进程 ───
echo "🔄 停止旧进程..."
if command -v pm2 &> /dev/null; then
  pm2 delete ad-automation 2>/dev/null || true
else
  # 没有 pm2 就用 kill
  PID=$(lsof -ti:$PORT 2>/dev/null || true)
  if [ -n "$PID" ]; then
    kill -9 $PID 2>/dev/null || true
    sleep 1
  fi
fi

# ─── 启动 ───
echo "🚀 启动服务..."
if command -v pm2 &> /dev/null; then
  # PM2 方式（推荐）— 自动重启 + 日志管理
  pm2 start npm --name "ad-automation" \
    --max-memory-restart "700M" \
    --log "$LOG_DIR/app.log" \
    --time \
    -- start
  
  pm2 save
  echo -e "${GREEN}✅ 服务已启动 (PM2 管理)${NC}"
  pm2 status ad-automation
else
  # nohup 方式
  nohup npm start > "$LOG_DIR/app.log" 2>&1 &
  echo $! > "$APP_DIR/.pid"
  echo -e "${GREEN}✅ 服务已启动 (PID: $(cat $APP_DIR/.pid))${NC}"
fi

echo ""
echo -e "${GREEN}🌐 访问地址: http://$(hostname -I | awk '{print $1}'):${PORT}${NC}"
echo -e "${GREEN}📊 健康检查: http://localhost:${PORT}/api/health${NC}"
echo ""

# ─── 内存使用报告 ───
sleep 3
echo "─── 内存使用报告 ───"
free -m | head -2
echo ""
echo "Node.js 进程:"
ps aux | grep "next start" | grep -v grep | awk '{printf "  PID: %s  RSS: %sMB  CPU: %s%%\n", $2, $6/1024, $3}' || echo "  (等待启动中...)"
