#!/usr/bin/env bash
# chromium 孤儿回收看门狗
# 背景：generate-extensions 的 buildCrawlCache 用 Promise.race([crawl, 300s兜底])，
# 超时后只抛错返回接口，但内层卡在 Cloudflare 挑战的 chromium 不会被取消/关闭，
# 在 2C 机器上累积成僵尸雪崩，拖垮整机(load 冲高 / swap 颠簸 / SSH 失联)。
# 本看门狗每 3 分钟兜底：杀掉存活超过 THRESHOLD 秒的 chrome 进程。
# 主爬取兜底 300s，故 >360s 的 chrome 必然是已被放弃的孤儿，不会误杀进行中的爬取。
#
# D-184：顺带清理无对应 chrome 进程的 /tmp/puppeteer_dev_profile-* 目录，
# 防止强杀后 profile 堆积挤内存/磁盘。
set -u
THRESHOLD=360
# comm 字段是可执行名(chrome / chromium-browse)，不含脚本路径，避免误杀本脚本
PIDS=$(ps -eo pid=,etimes=,comm= | awk -v th="$THRESHOLD" '$3 ~ /chrom/ && $2 > th {print $1}')
n=0
for pid in $PIDS; do
  if kill -9 "$pid" 2>/dev/null; then
    n=$((n + 1))
  fi
done
if [ "$n" -gt 0 ]; then
  echo "$(date '+%F %T') reaped ${n} orphan chromium (>${THRESHOLD}s)" >> /home/ubuntu/chromium-reaper.log
fi

# D-184：清理孤儿 puppeteer profile
cleaned=0
ACTIVE_PROFILES=$(ps -eo args= 2>/dev/null | grep -oE 'user-data-dir=/tmp/puppeteer_dev_profile-[A-Za-z0-9]+' | sed 's|user-data-dir=||' | sort -u || true)
for d in /tmp/puppeteer_dev_profile-*; do
  [ -d "$d" ] || continue
  keep=0
  for a in $ACTIVE_PROFILES; do
    if [ "$d" = "$a" ]; then keep=1; break; fi
  done
  if [ "$keep" = "0" ]; then
    rm -rf "$d" 2>/dev/null && cleaned=$((cleaned + 1)) || true
  fi
done
if [ "$cleaned" -gt 0 ]; then
  echo "$(date '+%F %T') cleaned ${cleaned} orphan puppeteer profiles" >> /home/ubuntu/chromium-reaper.log
fi
exit 0
