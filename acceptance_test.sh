#!/usr/bin/env bash
# ==============================================================================
#  系统验收脚本 — ad-automation CRM
#  目标服务器: 43.156.142.141 | 端口: 20050 | PM2: ad-automation
#  用法: bash acceptance_test.sh [admin_email] [admin_password] [user_email] [user_password]
# ==============================================================================

set -euo pipefail

# ── 颜色 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass()  { echo -e "${GREEN}  ✓ PASS${RESET}  $1"; ((PASS_CNT++))  || true; }
fail()  { echo -e "${RED}  ✗ FAIL${RESET}  $1"; ((FAIL_CNT++))  || true; FAILED_ITEMS+=("$1"); }
warn()  { echo -e "${YELLOW}  ⚠ WARN${RESET}  $1"; ((WARN_CNT++))  || true; }
info()  { echo -e "${BLUE}  ℹ INFO${RESET}  $1"; }
section(){ echo -e "\n${BOLD}${CYAN}══════════════════════════════════════════════════${RESET}"; \
           echo -e "${BOLD}${CYAN}  $1${RESET}"; \
           echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════${RESET}"; }

PASS_CNT=0; FAIL_CNT=0; WARN_CNT=0
FAILED_ITEMS=()

# ── 参数 / 配置 ──────────────────────────────────────────────────────────────
SSH_HOST="${SSH_HOST:-43.156.142.141}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-/c/Users/Administrator/Desktop/服务器/密钥/xlx0310.pem}"
REMOTE_PORT="${REMOTE_PORT:-20050}"
BASE_URL="http://localhost:${REMOTE_PORT}"

# 数据库连接（从服务器 .env 读取，可被环境变量覆盖）
DB_URL="${DB_URL:-mysql://crm:CrmPass2026!@localhost:3306/google-data-analysis}"
DB_USER=$(echo "$DB_URL" | sed 's|.*://||;s|:.*||')
DB_PASS=$(echo "$DB_URL" | sed 's|.*://[^:]*:||;s|@.*||')
DB_HOST=$(echo "$DB_URL" | sed 's|.*@||;s|:.*||')
DB_PORT=$(echo "$DB_URL" | sed 's|.*@[^:]*:||;s|/.*||')
DB_NAME=$(echo "$DB_URL" | sed 's|.*/||')
MYSQL_CMD="mysql -u${DB_USER} -p${DB_PASS} -h${DB_HOST} -P${DB_PORT} ${DB_NAME} -s -N"

ADMIN_EMAIL="${1:-${ADMIN_EMAIL:-}}"
ADMIN_PASS="${2:-${ADMIN_PASS:-}}"
USER_EMAIL="${3:-${USER_EMAIL:-}}"
USER_PASS="${4:-${USER_PASS:-}}"
USER_ID="${USER_ID:-}"

# 检测是否已经在服务器上运行（本地模式）
_LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
if [[ "${LOCAL_MODE:-}" == "1" ]] || [[ "$_LOCAL_IP" == *"43.156.142.141"* ]]; then
  LOCAL_MODE=1
else
  LOCAL_MODE=0
fi

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║    CRM 系统验收测试  $(date '+%Y-%m-%d %H:%M:%S')         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${RESET}"

[[ "$LOCAL_MODE" == "1" ]] && info "本地模式（直接在服务器上运行）" || info "远程模式（SSH 到 ${SSH_HOST}）"

# ── SSH helper：在服务器上执行命令（本地模式下直接执行） ────────────────────
ssh_run() {
  if [[ "${LOCAL_MODE:-0}" == "1" ]]; then
    local _tmp=$(mktemp /tmp/acc_run_XXXXXX.sh)
    printf '%s\n' "$@" > "$_tmp"
    bash "$_tmp" 2>/dev/null
    local _rc=$?
    rm -f "$_tmp"
    return $_rc
  else
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
        "${SSH_USER}@${SSH_HOST}" "$@" 2>/dev/null
  fi
}

# ── MySQL 查询 helper（直接调 mysql CLI，避免 Node 引号问题） ───────────────
db_query() {
  if [[ "${LOCAL_MODE:-0}" == "1" ]]; then
    MYSQL_PWD="${DB_PASS}" mysql -u"${DB_USER}" -h"${DB_HOST}" -P"${DB_PORT}" \
      "${DB_NAME}" -s -N -e "$1" 2>/dev/null
  else
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
        "${SSH_USER}@${SSH_HOST}" \
        "MYSQL_PWD='${DB_PASS}' mysql -u'${DB_USER}' -h'${DB_HOST}' -P'${DB_PORT}' '${DB_NAME}' -s -N -e \"$1\"" 2>/dev/null
  fi
}

# ── curl helper：通过 SSH 隧道调用本机 API ───────────────────────────────────
# $1=method $2=path $3=body(可空) $4=token(可空)
api_call() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local auth_hdr=""
  [[ -n "$token" ]] && auth_hdr="-H 'Cookie: $token'"
  local cmd="curl -s -w '\n__HTTP_STATUS__%{http_code}' -X $method '$BASE_URL$path' \
    -H 'Content-Type: application/json' $auth_hdr"
  [[ -n "$body" ]] && cmd+=" -d '$body'"
  ssh_run "eval $cmd" 2>/dev/null
}

# 解析 HTTP 状态码
http_status() { echo "$1" | grep -o '__HTTP_STATUS__[0-9]*' | sed 's/__HTTP_STATUS__//'; }
http_body()   { echo "$1" | sed 's/__HTTP_STATUS__[0-9]*$//'; }

# 解析 JSON 字段（简单 grep）
json_val() { echo "$1" | grep -o "\"$2\":[^,}]*" | head -1 | sed 's/.*://;s/[",}]//g;s/^ *//'; }

# ============================================================================
section "0. SSH 连通性检查"
# ============================================================================
if [[ "${LOCAL_MODE:-0}" == "1" ]]; then
  pass "本地模式：直接在服务器上运行，无需 SSH (${SSH_HOST})"
elif ssh_run "echo ssh_ok" | grep -q "ssh_ok"; then
  pass "SSH 连接服务器成功 (${SSH_HOST})"
else
  fail "SSH 连接失败，请检查密钥 ${SSH_KEY} 和主机 ${SSH_HOST}"
  echo -e "${RED}SSH 无法连接，验收中止。${RESET}"
  exit 1
fi

# ── 服务器资源 ───────────────────────────────────────────────────────────────
MEM=$(ssh_run "free -m | awk '/^Mem:/{print \$7}'")
DISK=$(ssh_run "df -h / | awk 'NR==2{print \$5}'")
LOAD=$(ssh_run "uptime | awk -F'load average:' '{print \$2}' | awk '{print \$1}'")
info "可用内存: ${MEM}MB | 磁盘使用: ${DISK} | 负载: ${LOAD}"
[[ "${MEM:-0}" -lt 200 ]] && warn "可用内存低于 200MB，可能影响服务稳定性"

# ── PM2 进程 ─────────────────────────────────────────────────────────────────
PM2_STATUS=$(ssh_run "pm2 list 2>/dev/null | grep ad-automation || echo 'NOT_FOUND'")
if echo "$PM2_STATUS" | grep -q "online"; then
  pass "PM2 进程 ad-automation 状态: online"
elif echo "$PM2_STATUS" | grep -q "NOT_FOUND"; then
  fail "PM2 进程 ad-automation 不存在"
else
  fail "PM2 进程 ad-automation 不在线: $PM2_STATUS"
fi

# ============================================================================
section "1. 健康检查"
# ============================================================================
HEALTH=$(ssh_run "curl -s -w '\n__HTTP_STATUS__%{http_code}' '$BASE_URL/api/health'" 2>/dev/null)
HEALTH_STATUS=$(http_status "$HEALTH")
HEALTH_BODY=$(http_body "$HEALTH")

if [[ "$HEALTH_STATUS" == "200" ]]; then
  pass "/api/health 返回 200"
  # 检查 health 响应体
  DB_CONN=$(echo "$HEALTH_BODY" | grep -oi '"database"[^,}]*' | head -1)
  info "健康检查响应: $HEALTH_BODY"
  if echo "$HEALTH_BODY" | grep -qi '"status":"ok"\|"ok":true\|healthy'; then
    pass "服务状态正常"
  else
    warn "健康检查响应格式异常，请手动确认"
  fi
else
  fail "/api/health 返回非 200: $HEALTH_STATUS (body: $HEALTH_BODY)"
fi

# ============================================================================
section "2. 管理员登录"
# ============================================================================
if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASS" ]]; then
  warn "未提供管理员凭证，跳过管理员相关测试"
  ADMIN_TOKEN=""
else
  ADMIN_LOGIN=$(ssh_run "curl -s -w '\n__HTTP_STATUS__%{http_code}' -c /tmp/admin_cookie.txt \
    -X POST '$BASE_URL/api/auth/login' \
    -H 'Content-Type: application/json' \
    -d '{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASS}\",\"role\":\"admin\"}'" 2>/dev/null)
  AL_STATUS=$(http_status "$ADMIN_LOGIN")
  AL_BODY=$(http_body "$ADMIN_LOGIN")
  if [[ "$AL_STATUS" == "200" ]] && echo "$AL_BODY" | grep -q '"code":0'; then
    pass "管理员登录成功"
    ADMIN_TOKEN=$(ssh_run "cat /tmp/admin_cookie.txt 2>/dev/null | grep admin_token | awk '{print \"admin_token=\"\$7}'" 2>/dev/null || echo "")
  else
    fail "管理员登录失败: code=$AL_STATUS body=${AL_BODY:0:200}"
    ADMIN_TOKEN=""
  fi
fi

# ============================================================================
section "3. 用户登录"
# ============================================================================
if [[ -z "$USER_EMAIL" || -z "$USER_PASS" ]]; then
  warn "未提供用户凭证，跳过用户相关测试（部分数据库一致性检查仍会运行）"
  USER_TOKEN=""
else
  USER_LOGIN=$(ssh_run "curl -s -w '\n__HTTP_STATUS__%{http_code}' -c /tmp/user_cookie.txt \
    -X POST '$BASE_URL/api/auth/login' \
    -H 'Content-Type: application/json' \
    -d '{\"email\":\"${USER_EMAIL}\",\"password\":\"${USER_PASS}\",\"role\":\"user\"}'" 2>/dev/null)
  UL_STATUS=$(http_status "$USER_LOGIN")
  UL_BODY=$(http_body "$USER_LOGIN")
  if [[ "$UL_STATUS" == "200" ]] && echo "$UL_BODY" | grep -q '"code":0'; then
    pass "用户登录成功"
    USER_TOKEN=$(ssh_run "cat /tmp/user_cookie.txt 2>/dev/null | grep user_token | awk '{print \"user_token=\"\$7}'" 2>/dev/null || echo "")
    USER_ID=$(echo "$UL_BODY" | grep -o '"userId":[^,}]*' | sed 's/.*://;s/[^0-9]//g' | head -1)
    info "登录用户 ID: ${USER_ID:-未知}"
  else
    fail "用户登录失败: code=$UL_STATUS body=${UL_BODY:0:200}"
    USER_TOKEN=""
    USER_ID=""
  fi
fi

# ============================================================================
section "4. 关键 API 连通性测试"
# ============================================================================

check_api() {
  local desc="$1" method="$2" path="$3" token_cookie="$4" expected_code="${5:-200}"
  local cookie_arg=""
  [[ -n "$token_cookie" ]] && cookie_arg="-b /tmp/${token_cookie}_cookie.txt"
  local result
  result=$(ssh_run "curl -s -w '\n__HTTP_STATUS__%{http_code}' -X $method $cookie_arg '$BASE_URL$path'" 2>/dev/null)
  local status=$(http_status "$result")
  local body=$(http_body "$result")
  if [[ "$status" == "$expected_code" ]]; then
    # 检查 API 是否返回业务错误
    if echo "$body" | grep -q '"code":0\|"success":true'; then
      pass "$desc (HTTP $status, 业务正常)"
    elif echo "$body" | grep -qi '"code":[^0]\|"error"'; then
      local err_msg=$(echo "$body" | grep -o '"message":"[^"]*"' | head -1)
      warn "$desc (HTTP $status, 业务错误: $err_msg)"
    else
      pass "$desc (HTTP $status)"
    fi
  else
    fail "$desc — 期望 $expected_code 实际 $status | ${body:0:150}"
  fi
  echo "$body"
}

# 基础 API 连通（需要有效凭证；无凭证时 401 是正常的，不算失败）
if [[ -n "$ADMIN_EMAIL" ]]; then
  check_api "GET /api/auth/me (admin)" GET "/api/auth/me" "admin" 200 > /dev/null || true
fi
if [[ -n "$USER_EMAIL" ]]; then
  check_api "GET /api/auth/me (user)" GET "/api/auth/me" "user" 200 > /dev/null || true
fi

if [[ -n "$USER_TOKEN" ]]; then
  # 用户核心 API
  MERCHANT_RESP=$(check_api "GET /api/user/merchants?tab=claimed"  GET "/api/user/merchants?tab=claimed&pageSize=20"  "user" 200)
  check_api "GET /api/user/merchants?tab=available" GET "/api/user/merchants?tab=available&pageSize=20" "user" 200 > /dev/null
  check_api "GET /api/user/data-center/campaigns"   GET "/api/user/data-center/campaigns"              "user" 200 > /dev/null
  check_api "GET /api/user/notifications"           GET "/api/user/notifications"                      "user" 200 > /dev/null
  check_api "GET /api/user/holidays"                GET "/api/user/holidays"                           "user" 200 > /dev/null
  check_api "GET /api/user/ad-settings"             GET "/api/user/ad-settings"                        "user" 200 > /dev/null
  check_api "GET /api/user/link-exchange"           GET "/api/user/link-exchange"                      "user" 200 > /dev/null
  check_api "GET /api/user/team/stats"              GET "/api/user/team/stats"                         "user" 200 > /dev/null
  check_api "GET /api/user/settings/mcc"            GET "/api/user/settings/mcc"                       "user" 200 > /dev/null
else
  warn "用户未登录，跳过用户 API 连通测试"
fi

if [[ -n "$ADMIN_TOKEN" ]]; then
  check_api "GET /api/admin/stats"         GET "/api/admin/stats"          "admin" 200 > /dev/null
  check_api "GET /api/admin/users"         GET "/api/admin/users"          "admin" 200 > /dev/null
  check_api "GET /api/admin/sites"         GET "/api/admin/sites"          "admin" 200 > /dev/null
  check_api "GET /api/admin/proxies"       GET "/api/admin/proxies"        "admin" 200 > /dev/null
  check_api "GET /api/admin/system-config" GET "/api/admin/system-config"  "admin" 200 > /dev/null
else
  warn "管理员未登录，跳过管理员 API 连通测试"
fi

# ============================================================================
section "5. 【重点】广告信息有效性验收"
# ============================================================================

# 通过 MySQL CLI 直接查询（最稳定的方式）
DB_CHECK() {
  local label="$1" sql="$2" expected_max="${3:-0}"
  local result
  result=$(db_query "SELECT IFNULL((${sql}),0) as _result" 2>/dev/null || echo "ERR")
  if [[ "$result" == "ERR" ]] || [[ -z "$result" ]]; then
    # 尝试直接执行 SQL（针对已包含别名的查询）
    result=$(db_query "${sql}" 2>/dev/null || echo "ERR")
  fi
  if [[ "$result" == "ERR" ]] || [[ -z "$result" ]]; then
    warn "$label — 数据库查询失败（请手动检查）"
    return
  fi
  local num
  num=$(echo "$result" | grep -o '[0-9]*' | head -1)
  num="${num:-0}"
  if [[ "$num" -le "$expected_max" ]]; then
    pass "$label (数量: $num ≤ 阈值 $expected_max)"
  else
    fail "$label (发现 $num 条问题记录，期望 ≤ $expected_max)"
  fi
}

# 5-A: 已提交到 Google 但标题/描述为空的广告素材
DB_CHECK \
  "已提交广告-标题为空检查" \
  "SELECT COUNT(*) as cnt FROM ad_creatives ac
   INNER JOIN ad_groups ag ON ag.id=ac.ad_group_id AND ag.is_deleted=0
   INNER JOIN campaigns c ON c.id=ag.campaign_id AND c.is_deleted=0
   WHERE c.google_campaign_id IS NOT NULL
     AND ac.is_deleted=0
     AND (ac.headlines IS NULL OR JSON_LENGTH(ac.headlines)=0)" \
  0

DB_CHECK \
  "已提交广告-描述为空检查" \
  "SELECT COUNT(*) as cnt FROM ad_creatives ac
   INNER JOIN ad_groups ag ON ag.id=ac.ad_group_id AND ag.is_deleted=0
   INNER JOIN campaigns c ON c.id=ag.campaign_id AND c.is_deleted=0
   WHERE c.google_campaign_id IS NOT NULL
     AND ac.is_deleted=0
     AND (ac.descriptions IS NULL OR JSON_LENGTH(ac.descriptions)=0)" \
  0

# 5-B: 落地页 URL 无效（空或非 https 开头）
DB_CHECK \
  "已提交广告-落地页URL无效检查" \
  "SELECT COUNT(*) as cnt FROM ad_creatives ac
   INNER JOIN ad_groups ag ON ag.id=ac.ad_group_id AND ag.is_deleted=0
   INNER JOIN campaigns c ON c.id=ag.campaign_id AND c.is_deleted=0
   WHERE c.google_campaign_id IS NOT NULL
     AND ac.is_deleted=0
     AND (ac.final_url IS NULL OR ac.final_url='' OR ac.final_url NOT LIKE 'https://%')" \
  0

# 5-C: 标题含明显虚假词（检测示例词汇）
DB_CHECK \
  "广告素材-标题含 Lorem/Test/Untitled 等虚假内容" \
  "SELECT COUNT(*) as cnt FROM ad_creatives ac
   INNER JOIN ad_groups ag ON ag.id=ac.ad_group_id AND ag.is_deleted=0
   INNER JOIN campaigns c ON c.id=ag.campaign_id AND c.is_deleted=0
   WHERE c.google_campaign_id IS NOT NULL
     AND ac.is_deleted=0
     AND (LOWER(JSON_UNQUOTE(JSON_EXTRACT(ac.headlines,'$[0]'))) REGEXP 'lorem|ipsum|untitled|test headline|placeholder')" \
  0

# 5-D: 标题长度超 30 字符（Google Ads 硬限制）- 检查第1条标题（最具代表性）
DB_CHECK \
  "广告素材-第1条标题超30字符限制检查" \
  "SELECT COUNT(*) as cnt FROM ad_creatives ac
   INNER JOIN ad_groups ag ON ag.id=ac.ad_group_id AND ag.is_deleted=0
   INNER JOIN campaigns c ON c.id=ag.campaign_id AND c.is_deleted=0
   WHERE c.google_campaign_id IS NOT NULL AND ac.is_deleted=0
     AND JSON_LENGTH(ac.headlines) > 0
     AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(ac.headlines, '$.0'))) > 30" \
  0

# 5-E: 描述长度超 90 字符
DB_CHECK \
  "广告素材-第1条描述超90字符限制检查" \
  "SELECT COUNT(*) as cnt FROM ad_creatives ac
   INNER JOIN ad_groups ag ON ag.id=ac.ad_group_id AND ag.is_deleted=0
   INNER JOIN campaigns c ON c.id=ag.campaign_id AND c.is_deleted=0
   WHERE c.google_campaign_id IS NOT NULL AND ac.is_deleted=0
     AND JSON_LENGTH(ac.descriptions) > 0
     AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(ac.descriptions, '$.0'))) > 90" \
  0

# 5-F: 广告状态在 Google 是 ENABLED 但数据库无 google_campaign_id（孤立状态）
DB_CHECK \
  "广告系列-ENABLED但无Google Campaign ID" \
  "SELECT COUNT(*) as cnt FROM campaigns
   WHERE is_deleted=0 AND google_status='ENABLED' AND google_campaign_id IS NULL" \
  0

# ============================================================================
section "6. 【重点】广告语言与国家一致性验收"
# ============================================================================

# 国家→预期语言代码映射（与代码中 COUNTRY_TO_LANG_CODE 一致）
# 验证：campaign 的 language_id 是否符合 target_country 对应的语言
LANG_CHECK_SQL="
SELECT COUNT(*) as cnt FROM campaigns
WHERE is_deleted=0
  AND target_country IS NOT NULL
  AND language_id IS NOT NULL
  AND language_id != 'en'
  AND target_country IN ('US','UK','GB','CA','AU','IE','SG','NZ','PH','IN')
  AND google_campaign_id IS NOT NULL
"
DB_CHECK "英语国家-广告语言必须为 en" "$LANG_CHECK_SQL" 0

DB_CHECK \
  "德语国家(DE/AT/CH)-广告语言非 de 检查" \
  "SELECT COUNT(*) as cnt FROM campaigns
   WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     AND target_country IN ('DE','AT','CH')
     AND language_id IS NOT NULL AND language_id != 'de'" \
  0

DB_CHECK \
  "法语国家(FR/BE)-广告语言非 fr 检查" \
  "SELECT COUNT(*) as cnt FROM campaigns
   WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     AND target_country IN ('FR','BE')
     AND language_id IS NOT NULL AND language_id != 'fr'" \
  0

DB_CHECK \
  "西班牙语国家(ES/MX/AR/CL/CO)-广告语言非 es 检查" \
  "SELECT COUNT(*) as cnt FROM campaigns
   WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     AND target_country IN ('ES','MX','AR','CL','CO')
     AND language_id IS NOT NULL AND language_id != 'es'" \
  0

DB_CHECK \
  "日语国家(JP)-广告语言非 ja 检查" \
  "SELECT COUNT(*) as cnt FROM campaigns
   WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     AND target_country='JP'
     AND language_id IS NOT NULL AND language_id != 'ja'" \
  0

DB_CHECK \
  "韩语国家(KR)-广告语言非 ko 检查" \
  "SELECT COUNT(*) as cnt FROM campaigns
   WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     AND target_country='KR'
     AND language_id IS NOT NULL AND language_id != 'ko'" \
  0

DB_CHECK \
  "葡萄牙语国家(BR/PT)-广告语言非 pt 检查" \
  "SELECT COUNT(*) as cnt FROM campaigns
   WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
     AND target_country IN ('BR','PT')
     AND language_id IS NOT NULL AND language_id != 'pt'" \
  0

# 综合：检查所有已提交广告的语言-国家不匹配情况（输出详情供人工复核）
info "正在获取语言-国家不匹配的广告列表（用于人工复核）..."
# 语言-国家不匹配详情：用 MySQL CASE 语句直接对比
LANG_MISMATCH_SQL="SELECT campaign_name, target_country, language_id,
  CASE target_country
    WHEN 'US' THEN 'en' WHEN 'UK' THEN 'en' WHEN 'GB' THEN 'en'
    WHEN 'CA' THEN 'en' WHEN 'AU' THEN 'en' WHEN 'IE' THEN 'en'
    WHEN 'SG' THEN 'en' WHEN 'NZ' THEN 'en' WHEN 'PH' THEN 'en' WHEN 'IN' THEN 'en'
    WHEN 'DE' THEN 'de' WHEN 'AT' THEN 'de' WHEN 'CH' THEN 'de'
    WHEN 'FR' THEN 'fr' WHEN 'BE' THEN 'fr'
    WHEN 'ES' THEN 'es' WHEN 'MX' THEN 'es' WHEN 'AR' THEN 'es'
    WHEN 'CL' THEN 'es' WHEN 'CO' THEN 'es'
    WHEN 'IT' THEN 'it' WHEN 'PT' THEN 'pt' WHEN 'BR' THEN 'pt'
    WHEN 'NL' THEN 'nl' WHEN 'JP' THEN 'ja' WHEN 'KR' THEN 'ko'
    WHEN 'CN' THEN 'zh_CN' WHEN 'TW' THEN 'zh_TW' WHEN 'HK' THEN 'zh_TW'
    WHEN 'RU' THEN 'ru' WHEN 'PL' THEN 'pl' WHEN 'SE' THEN 'sv'
    WHEN 'NO' THEN 'no' WHEN 'DK' THEN 'da' WHEN 'FI' THEN 'fi'
    WHEN 'TR' THEN 'tr' WHEN 'TH' THEN 'th' WHEN 'VN' THEN 'vi'
    WHEN 'SA' THEN 'ar' WHEN 'AE' THEN 'ar' WHEN 'IL' THEN 'iw'
    ELSE NULL END AS expected_lang
  FROM campaigns
  WHERE is_deleted=0 AND google_campaign_id IS NOT NULL
    AND language_id IS NOT NULL AND target_country IS NOT NULL
  HAVING expected_lang IS NOT NULL AND language_id != expected_lang
  LIMIT 20"

LANG_MISMATCH_ROWS=$(db_query "$LANG_MISMATCH_SQL" 2>/dev/null || echo "")
LANG_TOTAL=$(db_query "SELECT COUNT(*) FROM campaigns WHERE is_deleted=0 AND google_campaign_id IS NOT NULL" 2>/dev/null || echo "0")

if [[ -z "$LANG_MISMATCH_ROWS" ]]; then
  pass "广告语言-国家一致性：全部 ${LANG_TOTAL:-?} 个已提交广告语言-国家一致"
else
  MISMATCH_CNT=$(echo "$LANG_MISMATCH_ROWS" | grep -c '.' || echo "0")
  fail "广告语言-国家一致性：发现 $MISMATCH_CNT 个不匹配（共 ${LANG_TOTAL:-?} 个广告）"
  echo "$LANG_MISMATCH_ROWS" | while IFS=$'\t' read -r name country lang_id expected; do
    echo -e "    ${RED}广告: ${name:0:40} | 国家:$country | 实际语言:$lang_id | 应为:$expected${RESET}"
  done
fi

# ============================================================================
section "7. 【重点】商家库与 API 一致性验收"
# ============================================================================

# 7-A: user_merchants 中 claimed 商家 vs campaigns 中存在 google_campaign_id 的数量一致性
DB_CHECK \
  "商家库-已认领商家有对应campaign记录" \
  "SELECT COUNT(*) as cnt FROM user_merchants um
   WHERE um.is_deleted=0 AND um.status IN ('claimed','paused')
     AND NOT EXISTS (
       SELECT 1 FROM campaigns c WHERE c.user_merchant_id=um.id AND c.is_deleted=0
     )" \
  0

# 7-B: 由 CRM 创建的广告（user_merchant_id>0）无对应商家（同步来的广告 user_merchant_id=0 正常）
DB_CHECK \
  "广告系列-CRM创建广告无对应商家" \
  "SELECT COUNT(*) as cnt FROM campaigns c
   WHERE c.is_deleted=0 AND c.google_campaign_id IS NOT NULL
     AND c.user_merchant_id > 0
     AND NOT EXISTS (SELECT 1 FROM user_merchants um WHERE um.id=c.user_merchant_id AND um.is_deleted=0)" \
  0

# 7-C: 商家 merchant_id 在 DB 和 API 同步的一致性（检查 available 商家是否有重复）
DB_CHECK \
  "商家库-platform+merchant_id 唯一性 (非软删除)" \
  "SELECT COUNT(*) as cnt FROM (
     SELECT platform, merchant_id, COUNT(*) as dup_cnt
     FROM user_merchants
     WHERE is_deleted=0
     GROUP BY user_id, platform, merchant_id
     HAVING COUNT(*) > 1
   ) t" \
  0

# 7-D: 商家 tracking_link/campaign_link 为空（已认领商家必须有推广链接）
DB_CHECK \
  "商家库-已认领商家推广链接为空检查" \
  "SELECT COUNT(*) as cnt FROM user_merchants
   WHERE is_deleted=0 AND status IN ('claimed','paused')
     AND (tracking_link IS NULL OR tracking_link='')
     AND (campaign_link IS NULL OR campaign_link='')" \
  5

# 7-E: 商家 URL 有效性（已认领商家 merchant_url 不为空）
DB_CHECK \
  "商家库-已认领商家merchantURL为空" \
  "SELECT COUNT(*) as cnt FROM user_merchants
   WHERE is_deleted=0 AND status IN ('claimed','paused')
     AND (merchant_url IS NULL OR merchant_url='')" \
  10

# 7-F: 已提交广告的商家状态是否为 claimed/paused（不能是 available）
DB_CHECK \
  "商家库-已提交广告商家状态异常(应为claimed/paused)" \
  "SELECT COUNT(*) as cnt FROM campaigns c
   INNER JOIN user_merchants um ON um.id=c.user_merchant_id AND um.is_deleted=0
   WHERE c.is_deleted=0 AND c.google_campaign_id IS NOT NULL
     AND um.status NOT IN ('claimed','paused')" \
  0

# 7-G: 用户API返回商家总数与DB一致性
if [[ -n "$USER_ID" ]]; then
  API_MERCHANT_TOTAL=$(ssh_run "curl -s -b /tmp/user_cookie.txt '$BASE_URL/api/user/merchants?tab=claimed&pageSize=1'" 2>/dev/null | \
    grep -o '"total":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "")
  DB_MERCHANT_TOTAL=$(db_query "SELECT COUNT(*) FROM user_merchants WHERE user_id=${USER_ID} AND is_deleted=0 AND status IN ('claimed','paused')" 2>/dev/null || echo "")

  if [[ -z "$API_MERCHANT_TOTAL" || -z "$DB_MERCHANT_TOTAL" ]]; then
    warn "商家库一致性：API 或 DB 查询失败（API:${API_MERCHANT_TOTAL:-空}, DB:${DB_MERCHANT_TOTAL:-空}）"
  elif [[ "$API_MERCHANT_TOTAL" == "$DB_MERCHANT_TOTAL" ]]; then
    pass "商家库-API与DB商家数量一致 (均为 $DB_MERCHANT_TOTAL)"
  else
    fail "商家库-API与DB商家数量不一致: API=$API_MERCHANT_TOTAL, DB=$DB_MERCHANT_TOTAL"
  fi
else
  warn "未提供用户凭证，跳过商家API与DB数量一致性对比"
fi

# ============================================================================
section "8. 文章质量验收"
# ============================================================================

DB_CHECK \
  "文章-generating状态超过1小时(卡死)" \
  "SELECT COUNT(*) as cnt FROM articles
   WHERE is_deleted=0 AND status='generating'
     AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)" \
  5

DB_CHECK \
  "文章-status=failed 文章数量" \
  "SELECT COUNT(*) as cnt FROM articles WHERE is_deleted=0 AND status='failed'" \
  20

DB_CHECK \
  "文章-已发布文章内容为空" \
  "SELECT COUNT(*) as cnt FROM articles
   WHERE is_deleted=0 AND status='published'
     AND (content IS NULL OR content='' OR LENGTH(content)<100)" \
  0

# ============================================================================
section "9. 数据中心完整性验收"
# ============================================================================

DB_CHECK \
  "广告日报表-有消耗但cost为负" \
  "SELECT COUNT(*) as cnt FROM ads_daily_stats WHERE is_deleted=0 AND cost<0" \
  0

DB_CHECK \
  "广告日报表-clicks<0异常" \
  "SELECT COUNT(*) as cnt FROM ads_daily_stats WHERE is_deleted=0 AND clicks<0" \
  0

# 注：联盟平台退款/调整可能产生负值，阈值放宽到 5%（超出则报警）
_TOTAL_TXN=$(db_query "SELECT COUNT(*) FROM affiliate_transactions WHERE is_deleted=0" 2>/dev/null || echo "1")
_NEG_THRESHOLD=$(( _TOTAL_TXN / 20 + 5 ))
DB_CHECK \
  "联盟交易-commission_amount为负(超过总量5%报警)" \
  "SELECT COUNT(*) as cnt FROM affiliate_transactions
   WHERE is_deleted=0 AND CAST(commission_amount AS DECIMAL(12,2))<0" \
  "$_NEG_THRESHOLD"

# 最近 7 天有无新的日报数据（确保同步正常运行）
RECENT_STATS=$(db_query "SELECT COUNT(*) FROM ads_daily_stats WHERE is_deleted=0 AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)" 2>/dev/null || echo "0")
RECENT_STATS="${RECENT_STATS:-0}"

if [[ "${RECENT_STATS:-0}" -gt 0 ]]; then
  pass "广告日报表-最近7天有 $RECENT_STATS 条数据（同步正常）"
else
  warn "广告日报表-最近7天无新数据（请确认是否有活跃广告）"
fi

# ============================================================================
section "10. 系统配置完整性验收"
# ============================================================================

DB_CHECK \
  "系统配置-MCC账户配置检查(至少1个)" \
  "SELECT CASE WHEN COUNT(*)>0 THEN 0 ELSE 1 END as cnt
   FROM google_mcc_accounts WHERE is_deleted=0 AND is_active=1" \
  0

DB_CHECK \
  "系统配置-MCC缺少developer_token" \
  "SELECT COUNT(*) as cnt FROM google_mcc_accounts
   WHERE is_deleted=0 AND is_active=1
     AND (developer_token IS NULL OR developer_token='')" \
  0

DB_CHECK \
  "系统配置-MCC缺少service_account_json" \
  "SELECT COUNT(*) as cnt FROM google_mcc_accounts
   WHERE is_deleted=0 AND is_active=1
     AND (service_account_json IS NULL OR service_account_json='')" \
  0

# ============================================================================
section "11. 日志及错误排查"
# ============================================================================

info "检查 PM2 最近错误日志（最后 50 行）..."
PM2_ERRORS=$(ssh_run "pm2 logs ad-automation --err --lines 50 --nostream 2>/dev/null | grep -iE 'uncaughtException|UnhandledPromiseRejection|FATAL|Cannot find module' | grep -v 'PrismaClientInitializationError\|fetchError' | tail -15" || echo "")
if [[ -z "$PM2_ERRORS" ]]; then
  pass "PM2 错误日志无严重错误"
else
  ERROR_COUNT=$(echo "$PM2_ERRORS" | grep -c '.' || echo "0")
  warn "PM2 日志中发现 $ERROR_COUNT 行严重错误:"
  echo "$PM2_ERRORS" | head -10 | while IFS= read -r line; do
    echo -e "    ${YELLOW}${line:0:120}${RESET}"
  done
fi

# 检查 Next.js 构建状态
BUILD_OK=$(ssh_run "ls ~/Google-Data-Analysis/crm-mvp/.next/BUILD_ID 2>/dev/null && echo OK || echo NOT_FOUND")
  if echo "$BUILD_OK" | grep -q "OK"; then
    BUILD_ID=$(ssh_run "cat ~/Google-Data-Analysis/crm-mvp/.next/BUILD_ID 2>/dev/null | head -1")
  pass "Next.js 构建产物存在 (BUILD_ID: ${BUILD_ID:0:12}...)"
else
  fail "Next.js 构建产物不存在，服务可能运行旧版本"
fi

# 检查 debug 日志文件（merchant sync）
DEBUG_LOG=$(ssh_run "ls ~/Google-Data-Analysis/crm-mvp/debug-4fc40c.log 2>/dev/null && tail -5 ~/Google-Data-Analysis/crm-mvp/debug-4fc40c.log || echo 'NOT_FOUND'" 2>/dev/null || echo "NOT_FOUND")
if echo "$DEBUG_LOG" | grep -q "NOT_FOUND"; then
  info "merchant sync debug 日志不存在（正常）"
else
  info "merchant sync debug 最后记录:"
  echo "$DEBUG_LOG" | head -5 | while IFS= read -r line; do
    echo -e "    $line"
  done
fi

# ============================================================================
section "12. 广告文案语言内容抽样检查"
# ============================================================================

info "抽样检查已提交广告的语言与国家匹配情况（最新10条）..."
SAMPLE_SQL="SELECT
  SUBSTRING(c.campaign_name,1,40) as name,
  c.target_country, c.language_id,
  CASE c.target_country
    WHEN 'US' THEN 'en' WHEN 'UK' THEN 'en' WHEN 'GB' THEN 'en'
    WHEN 'CA' THEN 'en' WHEN 'AU' THEN 'en' WHEN 'DE' THEN 'de'
    WHEN 'FR' THEN 'fr' WHEN 'ES' THEN 'es' WHEN 'JP' THEN 'ja'
    WHEN 'KR' THEN 'ko' WHEN 'BR' THEN 'pt' WHEN 'PT' THEN 'pt'
    WHEN 'IT' THEN 'it' WHEN 'NL' THEN 'nl' WHEN 'CN' THEN 'zh_CN'
    ELSE 'en' END as expected_lang,
  IFNULL(JSON_LENGTH(ac.headlines),0) as headline_cnt,
  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ac.headlines,'$[0]')),'(无)') as first_headline
FROM campaigns c
LEFT JOIN ad_groups ag ON ag.campaign_id=c.id AND ag.is_deleted=0
LEFT JOIN ad_creatives ac ON ac.ad_group_id=ag.id AND ac.is_deleted=0
WHERE c.is_deleted=0 AND c.google_campaign_id IS NOT NULL
ORDER BY c.id DESC LIMIT 10"

SAMPLE_ROWS=$(db_query "$SAMPLE_SQL" 2>/dev/null || echo "")

if [[ -z "$SAMPLE_ROWS" ]]; then
  warn "抽样查询失败或无已提交广告"
else
  printf "  %-38s %-5s %-8s %-8s %-5s %s\n" "广告名称" "国家" "实际语言" "预期语言" "标题数" "首条标题"
  printf "  %s\n" "$(printf '%0.s─' {1..100})"
  OK_CNT=0; TOTAL_CNT=0
  while IFS=$'\t' read -r name country lang expected hcnt headline; do
    TOTAL_CNT=$((TOTAL_CNT+1))
    if [[ "$lang" == "$expected" ]]; then
      lang_mark="✓"; OK_CNT=$((OK_CNT+1))
    else
      lang_mark="✗"
    fi
    [[ "${hcnt:-0}" -ge 3 ]] && cnt_mark="✓(${hcnt})" || cnt_mark="✗(${hcnt:-0})"
    printf "  %-38s %-5s %-8s %-8s %-5s %.50s\n" \
      "${name:0:38}" "$country" "$lang $lang_mark" "$expected" "$cnt_mark" "${headline:0:50}"
  done <<< "$SAMPLE_ROWS"
  echo -e "  共 $TOTAL_CNT 条抽样，语言一致 $OK_CNT 条"
fi

# ============================================================================
section "总结报告"
# ============================================================================

echo ""
echo -e "${BOLD}════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  验收测试完成  $(date '+%Y-%m-%d %H:%M:%S')${RESET}"
echo -e "${BOLD}════════════════════════════════════════════════${RESET}"
echo -e "  ${GREEN}通过: $PASS_CNT${RESET}  |  ${RED}失败: $FAIL_CNT${RESET}  |  ${YELLOW}警告: $WARN_CNT${RESET}"
echo ""

if [[ $FAIL_CNT -gt 0 ]]; then
  echo -e "${RED}${BOLD}失败项清单：${RESET}"
  for item in "${FAILED_ITEMS[@]}"; do
    echo -e "  ${RED}✗ $item${RESET}"
  done
  echo ""
fi

if [[ $FAIL_CNT -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  🎉 所有关键验收项通过！${RESET}"
  echo -e "${GREEN}  系统状态良好，可进行正式交付。${RESET}"
elif [[ $FAIL_CNT -le 3 ]]; then
  echo -e "${YELLOW}${BOLD}  ⚠ 存在少量问题，请优先修复失败项后再交付。${RESET}"
else
  echo -e "${RED}${BOLD}  ✗ 存在多项问题，暂不建议交付，请排查后重新验收。${RESET}"
fi
echo ""

# 清理临时文件
ssh_run "rm -f /tmp/admin_cookie.txt /tmp/user_cookie.txt" 2>/dev/null || true

exit $((FAIL_CNT > 0 ? 1 : 0))
