#!/bin/bash
# D-370 站群首页白屏修复 —— 生产机执行脚本
#
# 用法（在生产机 43.156.142.141 上）：
#   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
#   bash scripts/d370-runbook.sh gate      # ① 验代码是否已部署（不改任何东西）
#   bash scripts/d370-runbook.sh scan      # ② 全量扫描（不改任何东西）
#   bash scripts/d370-runbook.sh dryrun    # ③ 空跑（不改任何东西）
#   bash scripts/d370-runbook.sh one <域名> # ④ 先单站实修验证
#   bash scripts/d370-runbook.sh all       # ⑤ 全部实修
#   bash scripts/d370-runbook.sh verify    # ⑥ 复扫确认
#
# 为什么分这么多步、为什么 gate 是硬闸：
#   首页白屏的真因是「数据和渲染器同住一个文件 + 写入是整体读改写」。
#   发布链路有三条路径会把渲染器抹掉（兜底分支 / 读不到文件 / 改日期整体重写）。
#   **代码没部署就去修站，修好的站下一次发布或改日期又会被抹一次。**
#   所以 gate 不过，后面几步一律拒绝执行。
#
# 详见设计方案 D-370。

set -uo pipefail

CRM_DIR="/home/ubuntu/Google-Data-Analysis/crm-mvp"
SCRIPT="scripts/d368-repair-broken-site-js.ts"
LOG_DIR="/home/ubuntu/d370-logs"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$CRM_DIR" 2>/dev/null || { echo "✗ 进不去 $CRM_DIR"; exit 1; }
mkdir -p "$LOG_DIR"

# ─── 硬闸：这三个标记必须都在已部署的代码里 ───────────────────────────────
gate() {
  echo "===== D-370 部署闸 ====="
  local fail=0

  check() {
    local desc="$1" file="$2" needle="$3"
    if grep -q "$needle" "$file" 2>/dev/null; then
      echo "  ✓ $desc"
    else
      echo "  ✗ $desc  —— 在 $file 里找不到 '$needle'"
      fail=1
    fi
  }

  # ① 原子写：治「写一半断」
  check "原子写 sftpAtomicWrite" "src/lib/remote-publisher.ts" "sftpAtomicWrite"
  # ② 三条抹渲染器的路径已堵
  check "兜底分支已改为报错中止" "src/lib/remote-publisher.ts" "已中止发布：整体重写会抹掉首页渲染器"
  check "改日期不再整体重写" "src/lib/remote-publisher.ts" "replaceJsArrayLiteral(dataContent, varName, existing)"
  # ③ 护栏与闸门
  check "wouldDropRenderer 护栏" "src/lib/site-write-guard.ts" "wouldDropRenderer"
  check "shrink 闸门" "src/lib/remote-publisher.ts" "skipped_would_shrink"
  # ④ 巡检判据
  check "巡检 looksLikeRenderer 判据" "src/lib/site-write-guard.ts" "looksLikeRenderer"

  echo
  echo "  当前 HEAD: $(git -C /home/ubuntu/Google-Data-Analysis log --oneline -1 2>/dev/null)"
  echo "  PM2 进程:  $(pm2 pid ad-automation 2>/dev/null || echo '查不到')"

  if [ "$fail" -ne 0 ]; then
    echo
    echo "✗ 闸门未通过：D-370 的代码还没部署到这台机上。"
    echo "  先把分支合进 main 等 Actions 部署完，再回来跑。"
    echo "  现在去修站是白费——下次发布/改日期会把渲染器再抹一次。"
    return 1
  fi
  echo
  echo "✓ 闸门通过，可以进行扫描与修复。"
  return 0
}

require_gate() {
  if ! gate > /dev/null 2>&1; then
    echo "✗ 部署闸未通过，拒绝执行「$1」。先跑：bash scripts/d370-runbook.sh gate"
    exit 1
  fi
}

# ─── ② 扫描：只读，不改任何东西 ──────────────────────────────────────────
do_scan() {
  local log="$LOG_DIR/scan-$STAMP.log"
  echo "===== 全量扫描（只读）====="
  echo "按 publish_sites 全量跑，判两类损坏：截断 / 渲染器被抹"
  echo "日志：$log"
  echo
  npx tsx "$SCRIPT" --scan 2>&1 | tee "$log"
  echo
  echo "——— 摘要 ———"
  grep -cE "^BROKEN" "$log" 2>/dev/null | xargs -I{} echo "  坏站 {} 个"
  echo
  echo "下一步：bash scripts/d370-runbook.sh dryrun"
}

# ─── ③ 空跑：算出将写入多少条，仍不落盘 ─────────────────────────────────
do_dryrun() {
  require_gate "dryrun"
  local log="$LOG_DIR/dryrun-$STAMP.log"
  echo "===== 空跑（不落盘）====="
  echo "日志：$log"
  echo
  npx tsx "$SCRIPT" --dry-run 2>&1 | tee "$log"

  echo
  echo "——— 重点看这个 ———"
  if grep -q "skipped_would_shrink" "$log" 2>/dev/null; then
    echo "  ⚠ 有站报了 skipped_would_shrink：库里的文章比站上少太多（<60%）。"
    echo "    按库重建会把站上多出来的条目从索引里抹掉 —— 文章页还在，"
    echo "    但首页和列表再也找不到，等于静默下线几百篇。"
    echo
    grep "skipped_would_shrink" "$log" | sed 's/^/    /'
    echo
    echo "  ✗ 不要直接加 --allow-shrink。先查清差额那批条目是什么："
    echo "    可能是早年手工发的、或已下线商家的文章 —— 确认该不该留。"
  else
    echo "  ✓ 没有 skipped_would_shrink，库里数据够全。"
  fi
  echo
  echo "下一步：先拿一个站验证  bash scripts/d370-runbook.sh one <域名>"
}

# ─── ④ 单站实修 ─────────────────────────────────────────────────────────
do_one() {
  require_gate "one"
  local domain="${1:-}"
  [ -z "$domain" ] && { echo "✗ 要给域名：bash scripts/d370-runbook.sh one omniportal.shop"; exit 1; }
  local log="$LOG_DIR/apply-$domain-$STAMP.log"

  echo "===== 单站实修：$domain ====="
  echo "原文件会先备份成 *.d368-broken-<时间>.bak（后缀沿用 D-368，脚本是同一个）"
  echo "日志：$log"
  echo
  npx tsx "$SCRIPT" --apply --only "$domain" 2>&1 | tee "$log"

  echo
  echo "——— 立刻验证（绕过 CF 缓存）———"
  verify_one "$domain"
  echo
  echo "确认这个站好了，再跑全部：bash scripts/d370-runbook.sh all"
}

# ─── ⑤ 全部实修 ─────────────────────────────────────────────────────────
do_all() {
  require_gate "all"
  local log="$LOG_DIR/apply-all-$STAMP.log"

  echo "===== 全部实修 ====="
  echo "日志：$log"
  echo
  read -r -p "确认已经单站验证过？(yes/no) " ans
  [ "$ans" != "yes" ] && { echo "已取消。"; exit 0; }

  npx tsx "$SCRIPT" --apply 2>&1 | tee "$log"

  echo
  echo "——— 结果分类 ———"
  for a in repaired skipped_healthy skipped_no_articles skipped_would_shrink failed; do
    local n
    n=$(grep -c "$a" "$log" 2>/dev/null || echo 0)
    echo "  $a: $n"
  done
  echo
  echo "下一步：清 Cloudflare 缓存（这些文件带 Cache-Control: max-age=14400），"
  echo "        然后 bash scripts/d370-runbook.sh verify"
}

# ─── ⑥ 复扫确认 ─────────────────────────────────────────────────────────
# 判据与 site-write-guard.ts 保持一致：
#   - 截断类：首页引用的**任一**本站脚本语法不过 → 坏
#   - 渲染器被抹类：全部脚本扫完，有数据却没有任何 DOM 写入代码 → 坏
# 必须扫全部脚本：bloomroots.top 有 3 个，坏的不一定是第一个；而非 A1 站的
# 纯数据文件是正常的，它的渲染器在另一个脚本里（只看第一个会把好站判坏）。
verify_one() {
  local d="$1" bust="?d370=$(date +%s)"
  local home html srcs n=0 bytes=0 cnt=0
  local syn="ok" rnd="无" anydata="无"

  home=$(curl -s -o /dev/null -w "%{http_code}" -m 25 "https://$d/$bust")
  if [ "$home" != "200" ]; then
    echo "  $d  home=$home  首页不可访问"
    return
  fi
  html=$(curl -s -m 25 "https://$d/$bust")
  srcs=$(echo "$html" | grep -oE '<script[^>]+src="[^"]+"' | grep -v cdn-cgi \
         | sed 's/.*src="//;s/".*//' | grep -vE '^https?://|^//' | cut -d'?' -f1)
  if [ -z "$srcs" ]; then
    echo "  $d  home=$home  首页没有本站脚本引用"
    return
  fi

  local bad=""
  for src in $srcs; do
    local sz
    sz=$(curl -s -m 30 "https://$d/$src$bust" -o /tmp/d370v.js -w "%{size_download}" 2>/dev/null)
    [ "${sz:-0}" -lt 2 ] && continue
    n=$((n+1)); bytes=$((bytes+sz))
    if ! node --check /tmp/d370v.js >/dev/null 2>&1; then
      syn="语法损坏"; bad="$src"
    fi
    grep -qE "innerHTML|insertAdjacentHTML|createElement|appendChild|addEventListener|querySelector|getElementById" \
      /tmp/d370v.js && rnd="有"
    grep -qE '(const|var|let)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=[[:space:]]*\[' \
      /tmp/d370v.js && anydata="有"
    local c
    c=$(grep -oE '"id"[[:space:]]*:' /tmp/d370v.js | wc -l)
    [ "$c" -eq 0 ] && c=$(grep -oE '\bid[[:space:]]*:' /tmp/d370v.js | wc -l)
    cnt=$((cnt+c))
  done

  local verdict="OK"
  [ "$syn" = "语法损坏" ] && verdict="坏-截断($bad)"
  [ "$syn" = "ok" ] && [ "$anydata" = "有" ] && [ "$rnd" = "无" ] && verdict="坏-渲染器被抹"
  printf "  %-24s home=%s 脚本=%d %dB 语法=%s 渲染器=%s 条目=%d → %s\n" \
    "$d" "$home" "$n" "$bytes" "$syn" "$rnd" "$cnt" "$verdict"
}

do_verify() {
  local log="$LOG_DIR/verify-$STAMP.log"
  echo "===== 复扫确认（带 cache-bust，绕过 CF）====="
  echo "日志：$log"
  echo
  npx tsx "$SCRIPT" --scan 2>&1 | tee "$log"
  echo
  echo "——— 逐站直验（本脚本自己 curl，不经 CRM）———"
  for d in $(grep -oE "^(OK|BROKEN)[[:space:]]+[a-z0-9.-]+" "$log" | awk '{print $2}'); do
    verify_one "$d"
  done
  echo
  echo "全部 语法=ok 且 渲染器=有 即为修复完成。"
}

case "${1:-}" in
  gate)   gate ;;
  scan)   do_scan ;;
  dryrun) do_dryrun ;;
  one)    do_one "${2:-}" ;;
  all)    do_all ;;
  verify) do_verify ;;
  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
