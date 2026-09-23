#!/bin/bash
# ─── 广告自动化发布 · 应急重启脚本 ───
#
# ⚠️ 生产部署不要用这个脚本。正式部署走 GitHub Actions：
#     push 到 main 且改动了 crm-mvp/** → .github/workflows/deploy.yml 自动部署
#     （前置跑 npm test + typecheck:tests，不过不部署）
#
# 本脚本现在只做一件事：**重启/拉起已有的 PM2 进程**，供 CI 不可用时应急。
#
# ─── D-353：为什么砍掉了原来的 pull + build + migrate（2026-09-23，01 报障）───
#
# 原脚本自带一套完整部署流程，但那套逻辑与 CI 里的严重漂移，且从不被任何测试覆盖。
# 跑它的人踩的是没人验证过的路径——2026-09-05 19:45 真实发生过一次，后果 18 天后才被发现：
#
#   原脚本用 `pm2 delete` + `pm2 start npm --max-memory-restart 700M` + `pm2 save`
#   拼命令行起进程，绕开 ecosystem.config.cjs，把里面的配置全丢掉，并被 pm2 save
#   固化进 ~/.pm2/dump.pm2。此后每次开机 systemd → pm2 resurrect 都按错配置起进程。
#   丢掉的每一条都有对应事故记录：
#     · max_memory_restart 1600M → 700M：比 ARCH-01 出事的 900M 还低 200M
#       （900M 时 puppeteer 尖峰即被 SIGINT，累计 129 次重启、近半数生成失败）
#     · MALLOC_ARENA_MAX=2 丢失：glibc arena 碎片让 RSS 顶满上限，单日 31 次重启
#       （2026-09-12 实测 RSS 1118MB 而 V8 堆仅 251MB，缺口全是 arena 碎片）
#     · TZ=Asia/Shanghai 丢失：时区退回 UTC，报表按 UTC 零点切 → D-331 那类日期错账
#     · CRON_SECRET 丢失：定时任务认证失败
#     · kill_timeout 10s → 默认 1.6s：在途请求来不及结束，部署期 502 变多
#     · max_restarts / min_uptime / restart_delay 丢失：B-3 的防疯狂重启失效
#
# 另外原构建段本身就跑不通/会伤线上，也是砍掉的理由：
#     · `npm ci --production` 无条件砍掉 devDependencies。CI 只在 package*.json 变动时才装依赖，
#       所以服务器 node_modules 里一直留着历次装好的 typescript/@types（2026-09-23 实测在，eslint 已不在）；
#       本脚本这条每次都跑，会把 Next 读 next.config.ts 所需的 typescript 删掉（未实跑验证必失败，但是无谓风险）
#     · 堆上限写 512M，而 package.json 的 build 是 1536M → Next16 编译中途 OOM
#     · 就地构建会重写正在服务的 .next，旧进程读到被删/未重建的产物 → chunk 404 被 CF 负缓存
#       （D-078 已在 CI 改成「构建到 .next.tmp → 验证 BUILD_ID → 原子 mv」，本脚本没有）
#     · `npx prisma migrate deploy 2>&1 | tail -5` 的非零退出码被管道吞掉，迁移失败照样上线
#       （D-254 事故：新代码带着缺列上线，管理页 500 约 5 分钟）
#     · 缺 D-159 的「上一版静态资源合并进新 .next」，老页面拿不到旧 chunk → ChunkLoadError
#     · 缺 `--webpack`，turbopack 生产构建有 client chunk 未输出的 bug → ChunkLoadError
#
# 这些 CI 里全部处理好了。与其在 shell 里再抄一遍（并继续漂移），不如让本脚本只管重启。
# 要改部署流程，改 .github/workflows/deploy.yml，别在这里另起一套。

set -e

APP_DIR="$HOME/Google-Data-Analysis/crm-mvp"
PORT=20050
LOG_DIR="$APP_DIR/logs"
EXPECTED_MEM_MB=1600   # 与 ecosystem.config.cjs 的 max_memory_restart 对齐，用于自检

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

MODE="${1:-restart}"

# ─── 挡掉旧用法：原来的 full / update 会 pull + build + migrate，已按 D-353 砍掉 ───
# 静默改行为最危险（有人以为部署了、其实只重启了旧代码），所以显式报错退出。
if [ "$MODE" != "restart" ]; then
  echo -e "${RED}✖ 本脚本已不再执行部署（模式 '${MODE}' 不再支持）${NC}"
  echo ""
  echo -e "${YELLOW}生产部署请走 GitHub Actions：${NC}"
  echo "    把改动 push 到 main（改动 crm-mvp/** 即自动触发）"
  echo "    → 前置跑 npm test + typecheck:tests，通过后自动构建并 reload"
  echo "    → 流程见 .github/workflows/deploy.yml"
  echo ""
  echo -e "${YELLOW}本脚本仅剩应急重启：${NC}"
  echo "    ./deploy.sh          # 等同 restart"
  echo "    ./deploy.sh restart  # 按 ecosystem.config.cjs 重载/拉起进程"
  echo ""
  echo -e "${YELLOW}原因（详见本文件顶部 D-353 注释）：${NC}"
  echo "    旧流程与 CI 严重漂移且无人验证，曾把 dump.pm2 写成 700M，"
  echo "    丢掉 MALLOC_ARENA_MAX / TZ / kill_timeout 等配置，18 天后才被发现。"
  exit 2
fi

echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  广告自动化发布 · 应急重启${NC}"
echo -e "${GREEN}  （生产部署请走 GitHub Actions）${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"

cd "$APP_DIR"
mkdir -p "$LOG_DIR"

if [ ! -f ecosystem.config.cjs ]; then
  echo -e "${RED}✖ 找不到 ecosystem.config.cjs（当前目录：$(pwd)）${NC}"
  echo -e "${RED}  没有它就只能拼命令行起进程，那正是 D-353 要消除的做法——中止。${NC}"
  exit 1
fi

# ─── 构建产物必须已存在：本脚本不构建 ───
if [ ! -f .next/BUILD_ID ]; then
  echo -e "${RED}✖ .next/BUILD_ID 不存在，说明尚无可用构建产物${NC}"
  echo -e "${RED}  本脚本不负责构建。请走 GitHub Actions 部署，或人工构建后再重启。${NC}"
  exit 1
fi
echo -e "${YELLOW}当前构建 BUILD_ID: $(cat .next/BUILD_ID)${NC}"

# ─── 内存概况（只报告，不再 drop_caches：那是治症状，且需要 root） ───
echo -e "${YELLOW}内存: $(free -m | awk '/^Mem:/{print $2"MB 总计 / "$7"MB 可用"}')${NC}"

# ─── 重启：一律走 ecosystem.config.cjs ───
if ! command -v pm2 &> /dev/null; then
  echo -e "${RED}✖ 未找到 pm2。本机的进程守护依赖 PM2（开机 systemd → pm2 resurrect）。${NC}"
  echo -e "${RED}  裸 nohup 起进程会丢掉内存守护与自动重启，且与 dump.pm2 不一致——中止。${NC}"
  exit 1
fi

echo "🔄 按 ecosystem.config.cjs 重载服务..."
if pm2 describe ad-automation > /dev/null 2>&1; then
  # reload 是滚动重启，比 delete+start 少一个空窗
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi

# dump.pm2 决定开机 resurrect 出来的进程长什么样，必须与当前运行态一致。
# CI 目前没有这一步，所以这里做（D-353：dump 被写成 700M 的坑就是靠它兜住）。
pm2 save

echo -e "${GREEN}✅ 已重载${NC}"
pm2 status ad-automation

# ─── 自检：把「配置是否真的生效」摊在日志里，别等出事才查 ───
# 读运行态与 dump 两处：运行态对而 dump 错的情况真实发生过（重启后才爆）。
echo ""
echo "─── 配置自检 ───"
READ_MEM='let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).find(x=>x.name==="ad-automation");const v=a&&a.pm2_env&&a.pm2_env.max_memory_restart;console.log(v?Math.round(v/1048576):0)}catch(e){console.log(0)}})'
LIVE_MEM=$(pm2 jlist 2>/dev/null | node -e "$READ_MEM" 2>/dev/null || echo 0)
DUMP_MEM=$(node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.pm2/dump.pm2","utf8"));const x=(Array.isArray(a)?a:a.apps||[]).find(y=>y.name==="ad-automation");console.log(x&&x.max_memory_restart?Math.round(x.max_memory_restart/1048576):0)}catch(e){console.log(0)}' 2>/dev/null || echo 0)

SELFCHECK_FAIL=0
for pair in "运行态:$LIVE_MEM" "dump.pm2:$DUMP_MEM"; do
  label="${pair%%:*}"; val="${pair##*:}"
  if [ "$val" = "$EXPECTED_MEM_MB" ]; then
    echo -e "  ${GREEN}✓ ${label} max_memory_restart=${val}M${NC}"
  else
    echo -e "  ${RED}✖ ${label} max_memory_restart=${val}M，预期 ${EXPECTED_MEM_MB}M${NC}"
    SELFCHECK_FAIL=1
  fi
done

# 环境变量自检：这几个丢了都有对应事故（见顶部 D-353 注释）
APP_PID=$(pgrep -f 'next start' | head -1 || true)
if [ -n "$APP_PID" ] && [ -r "/proc/$APP_PID/environ" ]; then
  for v in MALLOC_ARENA_MAX TZ NODE_OPTIONS CRON_SECRET; do
    val=$(tr '\0' '\n' < "/proc/$APP_PID/environ" 2>/dev/null | grep "^$v=" | head -1 || true)
    if [ -n "$val" ]; then
      echo -e "  ${GREEN}✓ ${val}${NC}"
    else
      echo -e "  ${RED}✖ ${v} 缺失（ecosystem 未生效？）${NC}"
      SELFCHECK_FAIL=1
    fi
  done
fi

if [ "$SELFCHECK_FAIL" != "0" ]; then
  echo -e "${RED}⚠ 自检未全通过——别放任，见本文件顶部 D-353 注释${NC}"
fi

# ─── 健康检查 ───
echo ""
sleep 3
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || echo "000")
if [ "$HEALTH" = "200" ]; then
  echo -e "${GREEN}🩺 健康检查 http=${HEALTH}${NC}"
else
  echo -e "${RED}🩺 健康检查 http=${HEALTH}（预期 200）——查 pm2 logs ad-automation --err${NC}"
fi
echo -e "${GREEN}🌐 http://$(hostname -I | awk '{print $1}'):${PORT}${NC}"
