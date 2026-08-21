# ATC 广告情报系统并入方案

> 文档版本：v2.0  
> 日期：2026-05-08（v1.0）/ 2026-08-19（v2.0 数据源重构）  
> 目标系统：`crm-mvp`（Next.js + Ant Design + MySQL/Prisma）

---

## 【v2.0】数据源重构：SerpApi → ATC 直连 RPC（2026-08-19）

### 迭代记录

| 功能主题 | 修改方向 | 当前结论 | 07 备注状态 |
|---|---|---|---|
| 商家竞争度数据源 | SerpApi 付费接口 → 免费直连 ATC 内部 RPC，SerpApi 降级备用 | 已上线（08-19），生产验证通过 | 07 已确认（08-19） |
| 广告情报搜索 | 暂不动，继续走 SerpApi | — | — |
| **同行判定规则（C-093/094 → v2.1「有效同行」）** | 废弃「≥3 合格域名」旧规则，改为：**近 7 天在投广告 >10 条 且 域名重复率 ≤5%** | 已上线（08-20），存量 281 广告主已全量重判 | 07 提出新规则（08-20）；「昨天在投」窗口放宽到近 7 天见下方说明，**待 07 确认** |
| **广告图 OCR（C-088 → v2.2 去 AI 化）** | AI 视觉模型 → 本地 Tesseract 免费识别，AI 仅可选兜底（默认关） | 生产实测 37/40 全自动正确，代码已上线（08-20） | 07 要求降 OCR 成本、最好零 AI（08-20） |

### 【v2.3】有效同行判定补充：唯一域名 ≥5 直接判同行（2026-08-20）

**背景**：全量重判后可关注广告主只有 19 个，07 问原因。漏斗拆解发现 127 个「在投>10 但重复率>5%」被判自投的广告主里，头部全是给 40+ 个不同商家域名投广告的明显同行（South Wind Tech 100条/45域名、刘荣 78/44、Silveredge 100/43…）。根因：同行给同一商家通常投 2~5 条素材，重复率天然 >5%，一刀切误伤。

**新规则（07 2026-08-20 确认）**：有效同行 = 近 7 天在投 >10 条 **且（唯一域名 ≥5 或 域名重复率 ≤5%）**。
- 唯一域名 ≥5 通道：品牌自投顶多 1~3 个域名（主站+地区站），≥5 个必是同行；OCR 未跑完也可提前定论（域名数只增不减）。
- 重复率 ≤5% 通道保留：兜住 OCR 覆盖率低的同行（如 WHATECH 100 条在投只识别出 2 个域名、零重复），避免把 v2.1 已翻正的同行再打回去。

**存量处理**：不整体 bump epoch（避免全量重拉，直连正被 Google 限流、会烧 SerpApi 配额），改为 SQL 按新规则从快照已存的真实字段（ad_count / unique_domain_count）直接重算 classification，口径与部署代码完全一致。

**数据核对（07 08-20 要求，本机直连实测对账）**：
- 在投数 ≤100 的全部精确（刘荣 78=78、泰顺池池 34=34、Qiang Xu 11=11）；日期窗口正确（所有广告 last_shown 均落在近 7 天内）。
- **=100 是分页上限截断**（Hither AB 实际 276、South Wind ≥600）；判定只需 >10 不受影响，前端统一显示「≥100」明示。
- 发现并修复两个一致性 bug：① epoch 原设 00:00Z 但 D-256 实际 01:15Z 才部署，00:30Z 旧代码写入的 9 行（Mac Duggal 批次，unique 是旧 5 张抽样口径）钻空被放行——epoch 上调至 01:30Z 强制重查；② 缓存命中路径（1a）只在内存算分类不回写 DB，导致温州诚惠等被「可关注」SQL 筛选漏掉——已改为不一致时回写。

**【D-259】在投数绝对精准（07 08-20 要求）**：
- 探测确认响应 key4/key5 只是估算区间（Hither AB 真实 276，返回 200~300），不能当总数用。
- 精确唯一路径 = 翻页到底：直连 maxAds 100→2000（页间 300ms 小憩防限频，正常翻到无下一页 token 即停，数值即精确总数）；SerpApi 降级路径同步实现 next_page_token 翻页（上限 10 页 = 每广告主最多 10 次配额，首页失败报错、后续页失败保留已取部分）。
- 前端「≥100」改为仅撞 2000 兜底上限时显示「≥2000」；存量 ad_count=100 的截断行部署后全量强刷。

### 【D-260】watchlist 扫描去 SerpApi 化 + 代理兜底传输（2026-08-21）

**背景**：08-21 晨 07 报「今日广告数量不对」（全 0）。排查：08:00 的 atc-watchlist-scan cron 扫 83 条 watchlist **全部失败**——该链路当时仍 SerpApi-only，而配额已被 08-20 的 D-259 精准计数重刷烧光（83/83 返回 429 run out of searches）。同时服务器 IP 直连被 Google 间歇性限频（302 sorry，单发能过、连发必挂，08-20 晚封了 14+ 小时）。

**排查中的重要事实（勿再误判）**：
- 「HTTP 200 + 空响应 {}」是**合法的 0 结果**，不是软封禁——本机+服务器+ATC 官网三方核验：nike.com 正常返回数据（协议未变），而刘荣 AR12750437245409820673、caledoniantravel.com 是**真的从 ATC 整体消失**（连官网「任意时间」都查 0 条，疑似 Google 清退了一批联盟套利广告主）。抽查 11 个 watchlist 广告主 10 个仍有数据。
- 广告主从 ATC 消失时直连返回空列表，属正常业务结果，不触发 SerpApi 降级。

**改动**：
1. **传输层第三级兜底（atc-direct.ts）**：fetch → curl 直连 → **curl 走代理池**。curl 直连被 302/429 拦时，从 CRM 代理池（kyads_proxies，换链接同款）取 US SOCKS5 出口（socks5h，kookeey/tnbproxy 均实测可绕过封禁）重试；成功后 30 分钟内直接走代理，之后回探直连。轮换住宅代理每请求换出口 IP，限频极难触发；流量消耗每天几十 MB 级，相对 kookeey 20GB 余量可忽略。
2. **searchIntelligence 广告主查询直连优先（atc-service.ts）**：AR ID 精确查询改 fetchAdvertiserCreativesDirect（maxAds 500，anywhere 口径），失败才降级 SerpApi（region 口径不变）；SerpApi key 改懒取，key 池为空/配额烧光时直连照跑。
3. **域名反查富化直连优先（enrichDomainsFromSnapshots）**：每域名先走 fetchDomainCreativesDirect（域名过滤查询回显 target_domain，免费），失败降级 SerpApi text 搜索。
4. **扫描器不再因 key 池空整轮放弃（atc-watchlist-scanner.ts）**：删掉 getPoolKeys 空即 return 的旧逻辑。

**效果**：watchlist 每日扫描（83 条 × 多页）从纯 SerpApi（日耗 200+ 配额）变为免费直连+代理，SerpApi 仅剩兜底与 text 搜索（低频 UI）两个用途。08-21 补扫实测：83 条全扫完仅 1 条失败（82 条零配额消耗），今日告警 3153 条 / 57 条通知，「今日广告」恢复。

**D-260.1**：轮换代理单会话偶发 TLS 握手失败（kookeey curl exit 35）→ proxyRescue 失败时重取代理 URL（=新会话新出口 IP）再试一次，最多 2 个会话。

### 【D-260.2】07 报「广告主被误判」的核查结论（2026-08-21 上午）

07 质疑列表页多个广告主分类错误。逐一直连+翻页核实（近 7 天窗口、anywhere 口径，与部署代码一致）：

| 广告主 | 快照在投数 | 实测在投数 | 历史广告 | 结论 |
|---|---|---|---|---|
| 泰顺县文兰日用品店 | 10 | **12** | — | 快照过时（昨晨拉的，今天已越过 >10 阈值）；已强刷 → 12 条/OCR 判定中 |
| Qingqing Zhang | 无快照 | **18** | — | 从未按新规则查过（显示「待重判」）；已强刷 → 18 条/OCR 判定中 |
| 王福来 | 1 | **1** | 27 条，第 10 新 last_shown 停在 06-17 | 计数无误；历史同行、近期几乎停投 |
| 杨月莉 | 5 | **7** | 100+ 条，第 10 新停在 07-28 | 计数无误；历史同行、当前仅 ~7 条在投 |
| 薛春 | 0 | **0** | 5 条，最近 last_shown 2026-05-15 | 3 个月前已全停，判「未知」合理 |

**根因不是数错，是标签语义**：现行规则「在投 ≤10 一律判 brand_self（品牌自投）」把**低活跃/被清退的同行**也贴成了「品牌自投」——王福来、杨月莉历史投过几十上百条（明显同行身份），近期停投后落入 ≤10 区间，被冒名「品牌」。

**待 07 确认项（v2.4 提案）**：0 < 在投 ≤10 的广告主不再标「品牌自投」，改标「低活跃」（不进「可关注广告主」，维持有效同行 >10 门槛不变）；如需进一步区分身份，可用免费直连查历史广告（不限时间一页）+ 已有 OCR 缓存做历史域名多样性判定（历史唯一域名 ≥5 → 「同行·低活跃」）。**未经 07 确认前不改判定逻辑。**

### 【v2.2 / D-257】OCR 去 AI 化——Tesseract 免费识别（2026-08-20）

**背景**：07 指出 AI 视觉 OCR 按图烧钱（存量已烧 1.1 万+ 次：按次 claude-haiku 3421 次、gemini-flash-lite 7399 次等），要求找免费/低成本方案，**最好完全不用 AI OCR**。

**选型与生产实测**（对照集 = 库里 AI 已成功识别的 40 张随机图）：

| 方案 | 命中 | 说明 |
|---|---|---|
| Tesseract 5.3 裸跑 | 36/40 | 4 个 miss 里 3 个是小字单字符误读 |
| + 3x 放大/灰度/锐化预处理 | 39/40 | 唯一 miss 是纯 logo 图（图里没有域名文字，AI 是靠品牌 logo 猜的） |
| 预处理 + 全自动挑域名（无真值） | **37/40** | 生产可用口径；另外 AI 判 permanent_failure 的图反而救回 8/10 |

RapidOCR/PaddleOCR 准确率更高但装包 80~500MB 且吃内存，2C/3.7G 生产机不划算；Tesseract apt 包 ~10MB、纯 CPU、单图 ~5s，够用。

**实现**（`src/lib/ocr-local.ts` + `ocr-domain.ts` 引擎调度）：

1. 管线：curl 下载（避 Node TLS 指纹）→ imagemagick 3x 放大+灰度+锐化 → tesseract psm 11（无候选再 psm 3）→ 按空白分词 → 域名形 token 过 TLD 白名单 → 剥 www → **根域名归一化（eTLD+1，含 co.uk 类二级后缀）** → 频次最高者胜出。
2. 引擎由 `system_configs.ocr_engine` 控制：`tesseract`（**默认，零 AI 费用**）/ `tesseract+ai`（本地识别不出的图才走 AI 兜底）/ `ai`（旧行为）。
3. 误差影响评估：单字符误读产生的假唯一域名对 5% 重复率判定无实质影响（品牌自投重复率通常 90%+）；纯 logo 无文字图约占 2.5%，放弃不影响大局。
4. 系统依赖：生产服务器 apt 安装 `tesseract-ocr` + `imagemagick`（2026-08-20 已装）；环境缺依赖时 worker 跳过并报原因，不静默烧 AI。
5. 存量 AI 判 failed/permanent_failure 的 ~1800 张图重置为 pending，由 tesseract 免费重试（实测可救回大部分）。

**成本结论**：OCR 边际成本从「每图一次 AI 调用」降为 **0**（纯服务器 CPU）。

### 【v2.1】有效同行判定重构（2026-08-20）

**背景**：07 发现同行识别错误——Qiang Xu、温州志君等明显在为几十个不同商家投广告的联盟同行被判为「品牌自投」。根因：旧规则只抽 5 张广告图 OCR，样本太小；且「合格域名需含 ≥30 天长跑创意」条件过苛。

**07 给出的新规则**：有效同行 = 昨天在投的广告超过 10 个，且域名重复率 ≤5%（50 个里只能重复一次）。

**实测数据与口径调整（待 07 确认）**：

| 广告主 | 昨天在投 | 近2天 | 近3天 | 近7天 | 07 预期 |
|---|---|---|---|---|---|
| Qiang Xu | 9 | 10 | 10 | 11 | 同行 |
| 温州志君 | 12 | 16 | 16 | 22 | 同行 |

严格按「昨天 >10」Qiang Xu（9 条）会被排除，与 07 预期矛盾（ATC 数据按太平洋时间统计、有约 1 天滞后，「昨天」窗口天然偏小）。故实现采用 **近 7 天在投 >10 条**，阈值与窗口均为代码常量，07 可随时调整。

**实现路径**：

1. **在投广告数**：直连 RPC 按广告主查询（`3.13`=AR ID + `3.6/3.7`=近7天~今天），免费、精确。实测确认：单日区间（end<今天）返回空，end 必须含今天；过滤语义 = 投放期与区间有交集。
2. **域名来源**：广告主查询与详情接口均**不返回域名**（ATC 把搜索广告渲染成归档图片），域名只能 OCR 广告图——复用现有 `ad_image_ocr_cache` 管线（永久缓存，每张图一生只 OCR 一次），抽样上限从 5 张提到 **50 张**（07 规则要求的样本量；C-094.5 的 5 张下调决策被本规则取代）。
3. **判定**：`有效同行 = 在投数 >10 && (已识别数-唯一域名数)/已识别数 ≤ 5%`；OCR 未跑完 → pending（前端已有轮询机制）；无广告 → unknown；其余 → 品牌自投。
4. **旧快照失效**：以规则上线时间为界（epoch gate），旧快照一律视为过期重查（直连免费，无成本顾虑）；SerpApi 降级路径同步改用相同时间窗，保证降级写入的快照口径一致。
5. 分类枚举（peer/brand_self/pending/unknown）不变，三处前端零结构改动，仅更新判定标准文案。

**成本影响**：广告数查询从 SerpApi（1 次额度/广告主）变为免费直连；OCR 从 5 张/广告主升至最多 50 张/广告主（一次性，命中缓存后 0 成本），走 `domain_ocr` 场景配置的视觉模型。

**限频/指纹拦截实测与对策（2026-08-20，本机与生产服务器双重复现）**：
- 定性结论：Google 按 **TLS 指纹（JA3）拉黑 Node 默认 TLS 栈**——同一台机器上 undici fetch 与 node:https 被 302 到 google.com/sorry 或直接 429，而 curl、python 全部畅通（生产服务器实测：curl 200 / python 200 / node 429）。
- 对策已内置 `atc-direct.ts` 三级传输：① fetch（带 Cookie 引导与 429 重试）；② fetch 被拦 → **自动切换 child_process 调 curl**（TLS 指纹不同，实测畅通；成功后本进程内记住偏好，打 `[ATC-direct] fetch 被拦，已切换 curl 传输` warn 可巡检）；③ curl 也失败 → SerpApi 降级，行为等同旧版。
- 本机验证（2026-08-20 09:40）：fetch 429 → curl 自动接管，QiangXu 近7天 11 条/志君 22 条/kaptest 域名查询 100 条全部正常。

**数据库变更**：`atc_advertiser_domain_snapshot` 新增 `classification` 列（Prisma 迁移 `20260820020000_d256_advertiser_snapshot_classification`），供「可关注广告主」等接口 SQL 级筛选；NULL = 旧规则快照（读取时被 epoch gate 强制重查，重查后补上）。

### 重构背景

- 徐克（08-19）推荐 3 个开源方案替代付费数据源。经评估：`block-town/google-ads-transparency-mcp` 为可用的直连实现（`faniAhmed` 原版的修复版超集）；`josueaagomez` 为浏览器+AI 读图方案，不适合低配生产机，弃用。
- SerpApi 免费额度 250 次/月/Key，团队靠 Key 池（`serpapi-key-pool`）勉强支撑；直连后此瓶颈消失。

### 三方对比测试结论（2026-08-19，全流程记录在 `_atc_cmp_*` 系列文件）

- 抓包证实：ATC 网页前端调用的就是 `SearchService/SearchCreatives` 这个 RPC，直连 = 与网页同源。
- 5 个生产库快照域名对比：当天快照（mendi.io）三方 100% 一致；1~3 天时差域名的差异均可归因于投放变动、商家自身过滤、100 条抽样上限（amazon 类大盘域名固有噪声，SerpApi 同样受限）。

### RPC 协议要点（网页抓包验证）

```
POST https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=
body: f.req=<JSON>
  "2"          返回条数（≤100）
  "3.6"/"3.7"  起止日期 YYYYMMDD
  "3.8"        [地区数字码]（与 SerpApi 同套编码 = 2000 + ISO 数字码，US=2840，复用 atc-regions.ts）
  "3.12"       {"1": 域名, "2": true}（域名精确搜索）
  "3.14"       [3] = 仅 Google 搜索平台
响应列表项：
  "1" AR ID   "2" CR ID   "12" 广告主名   "14" 投放域名
  "6.1"/"7.1" first/last_shown（Unix 秒）   "3.3.2" 预览 HTML（含缩略图）
```

无需 Cookie / API Key，Node 原生 `fetch` 即可调用。

### 代码变更（本期范围：仅商家竞争度查询）

```
新建：crm-mvp/src/lib/atc-direct.ts        直连客户端（fetchDomainCreativesDirect）
修改：crm-mvp/src/lib/atc-service.ts       queryMerchantAtc 第3步改为：
                                           直连优先 → 失败时 console.warn 留痕并降级原 SerpApi 路径
```

- 过滤算法、24h 团队缓存、快照表、前端、API 路由**零改动**；
- SerpApi Key 改为惰性获取：直连成功时完全不需要 Key（原实现无 Key 直接抛错）；
- `sample_ads` 字段（域名/起止时间/缩略图）直连响应全部可提供，不丢功能。

### 风险与约束

1. **非官方接口**：Google 可能改协议或按 IP 限频，故必须保留 SerpApi 降级路径；线上换用降级路径会打 `[ATC-direct]` warn 日志，可巡检。
2. 100 条抽样上限与 SerpApi 相同，大盘域名（amazon 等）竞争度仍为下限估计（v1.0 已知约束不变）。
3. 生产机为 2C/3.7G 低配：直连是轻量 HTTP 请求（单次 <2s），无额外资源压力。

---

## 一、概述

本方案将「Google Ads Transparency Center 广告情报」功能并入现有 CRM 系统，**不另起炉灶**，完全复用现有技术栈、数据库、权限体系和 UI 组件库。新增工作量极小，对现有功能零破坏。

### 核心价值

员工可以通过此功能了解：
- 自己负责的每个商家，**市场上有多少真实联盟广告主**在为其投放（竞争热度）
- 某个广告主**具体在推哪些商家**（反向发现优质商家）
- 对比自己团队内部的投放人数与市场竞争度，做出更优的商家选择决策

---

## 二、现有系统基础（已有，无需新建）

| 能力 | 对应表/文件 | 本次复用方式 |
|------|------------|------------|
| 多联盟账号绑定 | `platform_connections` | 直接复用，无需改动 |
| 商家库 | `user_merchants` | 扩展 3 个字段 |
| AI 供应商配置 | `ai_providers` + `ai_model_configs` | 直接复用（后续报告功能） |
| 系统键值配置 | `system_configs` | 存团队公共 SerpApi Key |
| 消息通知 | `notifications` | 直接复用（监控告警） |
| 定时任务框架 | `src/app/api/cron/` | 新增一个 cron 文件 |
| 个人设置页 | `/user/settings/page.tsx` | 新增一个 Tab |
| 侧边导航 | `UserLayout.tsx` | 新增两个菜单项 |
| 操作日志 | `operation_logs` | 直接复用 |

---

## 三、数据源：SerpApi

- **服务**：[SerpApi — Google Ads Transparency Center API](https://serpapi.com/google-ads-transparency-center-api)
- **免费额度**：每人每月 **250 次查询**
- **计费模式**：每人配置自己的 API Key，使用自己的额度
- **核心端点**：`GET https://serpapi.com/search?engine=google_ads_transparency_center`

### SerpApi 关键参数

| 参数 | 说明 |
|------|------|
| `engine` | 固定值：`google_ads_transparency_center` |
| `domain` | 商家域名，用于「商家竞争度」查询 |
| `text` | 广告主名称，用于「广告情报」搜索 |
| `region` | 投放地区，如 `US`、`GB` 等 |
| `num` | 单次返回最多 100 条 |

---

## 四、数据库变更（最小化）

### 4.1 `users` 表：新增 1 个字段

```sql
ALTER TABLE users
  ADD COLUMN serpapi_key VARCHAR(128) NULL COMMENT '个人 SerpApi API Key';
```

对应 Prisma schema 修改：

```prisma
// 在 model users {} 内新增：
serpapi_key  String?  @db.VarChar(128)
```

---

### 4.2 `user_merchants` 表：新增 3 个字段

```sql
ALTER TABLE user_merchants
  ADD COLUMN atc_advertiser_count INT UNSIGNED NULL       COMMENT 'ATC 真实广告主数（已过滤商家自身和代理商）',
  ADD COLUMN atc_last_synced_at   DATETIME NULL           COMMENT '最后 ATC 同步时间',
  ADD COLUMN atc_sync_status      VARCHAR(16) DEFAULT 'idle' COMMENT 'idle / syncing / done / error';
```

对应 Prisma schema 修改：

```prisma
// 在 model user_merchants {} 内新增：
atc_advertiser_count  Int?     @db.UnsignedInt
atc_last_synced_at    DateTime? @db.DateTime(0)
atc_sync_status       String   @default("idle") @db.VarChar(16)
```

---

### 4.3 新建表：`merchant_atc_snapshots`（ATC 结果团队共享缓存）

```sql
CREATE TABLE merchant_atc_snapshots (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain                VARCHAR(255) NOT NULL           COMMENT '商家域名（唯一键）',
  region                VARCHAR(8)   NOT NULL DEFAULT 'US',
  raw_advertiser_count  INT UNSIGNED DEFAULT 0          COMMENT 'ATC 原始广告主总数（未过滤）',
  real_advertiser_count INT UNSIGNED DEFAULT 0          COMMENT '过滤后真实竞争广告主数',
  top_advertisers_json  JSON NULL                       COMMENT '前20个广告主样本 [{id, name}]',
  sample_ads_json       JSON NULL                       COMMENT '广告创意样本（最多10条）',
  fetched_at            DATETIME NOT NULL               COMMENT '本次抓取时间',
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_domain_region (domain, region)
);
```

> **缓存策略**：同一 `domain + region` 组合，有效期 **24 小时**。任意员工触发查询时，若缓存有效直接返回，**不消耗任何人的 SerpApi 额度**。

---

### 4.4 新建表：`merchant_monitor_rules`（监控告警规则，后续迭代）

```sql
CREATE TABLE merchant_monitor_rules (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id             BIGINT UNSIGNED NOT NULL,
  user_merchant_id    BIGINT UNSIGNED NOT NULL,
  rule_type           VARCHAR(32) NOT NULL   COMMENT 'count_increase / count_decrease',
  threshold_pct       TINYINT UNSIGNED DEFAULT 20 COMMENT '变化阈值百分比，如 20 表示 ±20%',
  is_active           TINYINT DEFAULT 1,
  is_deleted          TINYINT DEFAULT 0,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_user (user_id)
);
```

---

## 五、新增/修改的前端页面

### 5.1 个人设置页——新增「广告情报」Tab

**文件**：`src/app/user/settings/page.tsx`（**修改**，新增 Tab）

Tab 内容：

```
┌──────────────────────────────────────────────────────┐
│ 广告情报设置                                          │
│                                                      │
│  SerpApi API Key                                     │
│  ┌────────────────────────────────┐ [测试] [保存]    │
│  │ ●●●●●●●●●●●●●●●●●●●●●●●●●●●● │                  │
│  └────────────────────────────────┘                  │
│                                                      │
│  ℹ  免费额度：每月 250 次查询                         │
│     获取地址：serpapi.com → Dashboard → API Key      │
│     团队共享缓存：同一商家域名 24h 内仅消耗 1 次额度   │
└──────────────────────────────────────────────────────┘
```

---

### 5.2 商家列表——新增 ATC 竞争度列

**文件**：`src/app/user/merchants/page.tsx`（**修改**，扩展列定义）

在现有商家表格中，于「投放状态」列之后新增一列：

| 列名 | 宽度 | 内容 |
|------|------|------|
| ATC 竞争度 | 140px | 广告主数 + 颜色标识 + 刷新按钮 |

**单元格显示逻辑**：

```
未配置 Key      → [配置 SerpApi Key]（灰色链接，跳转设置页）
未查询 (idle)   → [查询竞争度]（蓝色按钮）
查询中 (syncing)→ [转圈 loading]
已有数据 (done) → 🔴 87个  2天前  [↻]     （50+：红，10-49：橙，0-9：绿）
查询失败 (error)→ ⚠ 失败  [重试]
```

---

### 5.3 广告情报页（新建页面）

**文件**：`src/app/user/intelligence/page.tsx`（**新建**）

**功能**：按广告主名称搜索，查看其在 Google 全平台投放的所有广告创意。

**用途**：查一个已知的大联盟推手投的是什么商家，反向发现好商家。

```
┌─ 搜索区 ─────────────────────────────────────────────────────┐
│  广告主名称: [Nike Inc.                ] [🔍 搜索]            │
│  筛选条件: 平台[全部▾]  格式[全部▾]  地区[US▾]  时间[近30天▾] │
└──────────────────────────────────────────────────────────────┘

┌─ 结果区 ─────────────────────────────────────────────────────┐
│ 找到 3 个匹配广告主 · 共 240 条广告创意                        │
│                                                              │
│  广告主: Nike Inc.  AR17828074...  ▼ 展开（120条广告）         │
│  ┌──────┬──────────────┬────────────────┬────────┬────────┐  │
│  │ 格式 │ 广告预览      │ 投放域名        │ 首次   │ 末次   │  │
│  ├──────┼──────────────┼────────────────┼────────┼────────┤  │
│  │ 文字 │ [缩略图] 标题 │ nike.com       │ 25-01  │ 26-05  │  │
│  │ 视频 │ [缩略图]      │ adidas.com     │ 24-11  │ 26-04  │  │
│  └──────┴──────────────┴────────────────┴────────┴────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 六、新增/修改的后端 API

| 路径 | 方法 | 说明 | 文件 |
|------|------|------|------|
| `/api/user/settings/serpapi` | GET/POST | 读写个人 SerpApi Key | 新建 |
| `/api/user/atc/merchant-count` | POST | 查询单个商家竞争度（带缓存） | 新建 |
| `/api/user/atc/intelligence` | GET | 按广告主名称搜索广告 | 新建 |
| `/api/cron/atc-snapshot` | GET | 定时批量更新 ATC 数据（可选，需团队 Key） | 新建 |

---

## 七、核心业务逻辑

### 7.1 「真实广告主数」过滤算法

当用域名搜索 ATC 时，返回的广告主包含三类，需要过滤：

```
原始结果
  ├─ 商家自身（如搜 nike.com，Nike Inc. 自己的广告）        → 排除
  ├─ 代理商（如 "Nike Digital Marketing Agency"）          → 排除
  └─ 真实联盟推手 / 第三方广告主                            ✅ 保留并计数
```

**过滤规则（TypeScript 伪代码）**：

```typescript
// 1. 去重：按 advertiser_id 去重
const uniqueAdvertisers = deduplicateById(ads);

// 2. 排除商家自身：广告主名与商家名模糊相似度 > 80%
function isMerchantSelf(advertiserName: string, merchantName: string): boolean {
  const a = normalize(advertiserName);  // 小写 + 去非字母数字
  const m = normalize(merchantName);
  return a.includes(m) || m.includes(a) || levenshteinSimilarity(a, m) > 0.8;
}

// 3. 排除代理商：名称包含代理商特征词
const AGENCY_KEYWORDS = [
  "agency", "media", "marketing", "digital", "advertising",
  "ads", "seo", "sem", "ppc", "performance", "growth",
  "solutions", "services", "consulting", "studio", "creative",
  "partners", "group", "associates"
];
function isAgency(advertiserName: string): boolean {
  const lower = advertiserName.toLowerCase();
  return AGENCY_KEYWORDS.some(kw => lower.includes(kw));
}

// 4. 最终计数
const realCount = uniqueAdvertisers.filter(adv =>
  !isMerchantSelf(adv.name, merchant.merchant_name) &&
  !isAgency(adv.name)
).length;
```

> **说明**：SerpApi 单次最多返回 100 条，单次查询可识别最多 100 个广告主。对绝大多数联盟商家已足够。大型商家（如 Amazon）实际广告主数远超 100，此时 `atc_advertiser_count` 为保守下限估计，可在 UI 上标注「100+」。

---

### 7.2 SerpApi 额度保护策略（250次/月免费额度）

| 场景 | 行为 | 额度消耗 |
|------|------|---------|
| 员工 A 点击刷新商家 X（缓存有效 < 24h） | 直接返回缓存 | **0 次** |
| 员工 B 查同一商家 X（缓存有效） | 直接返回缓存 | **0 次** |
| 任意员工查商家 X（缓存过期 > 24h） | 调用 SerpApi，更新缓存 | **1 次** |
| 广告情报页搜索广告主名称 | 调用 SerpApi | **1 次** |

**核心优势**：热门商家（如 Shein、Amazon、Nike）全团队每天仅消耗 **1 次**额度，而非 50 次。

---

### 7.3 `/api/user/atc/merchant-count` 接口逻辑

```
请求：POST { merchant_id, force_refresh?: boolean }

流程：
1. 读取当前用户的 serpapi_key
   → 若未配置，返回 error: "请先配置 SerpApi Key"
2. 读取该商家的 merchant_url，提取域名
   → 若无域名，返回 error: "该商家未配置域名，无法查询"
3. 查询 merchant_atc_snapshots 缓存
   → 若缓存有效（fetched_at > now - 24h）且非 force_refresh
     → 直接返回缓存数据，更新 user_merchants.atc_advertiser_count
4. 调用 SerpApi：
     engine=google_ads_transparency_center
     domain=<merchant_domain>
     num=100
     region=US（可配置）
5. 过滤广告主（排除自身 + 排除代理商）
6. 写入 merchant_atc_snapshots（upsert by domain+region）
7. 更新 user_merchants：
     atc_advertiser_count = realCount
     atc_last_synced_at   = now
     atc_sync_status      = "done"
8. 返回结果
```

---

## 八、侧边导航变更

**文件**：`src/components/UserLayout.tsx`（**修改**）

在普通用户菜单的「商家管理」分组下新增 1 项，新增「广告情报」分组：

```typescript
// 原「商家管理」分组 children 新增：
{ key: "/user/intelligence", icon: <EyeOutlined />, label: "广告情报" },
```

---

## 九、迭代阶段规划

### Phase 1（本期，最小可用版）

| 序号 | 任务 | 涉及文件 |
|------|------|---------|
| 1 | Prisma schema 加字段 + 生成 migration | `schema.prisma` |
| 2 | 个人设置页加「广告情报」Tab（Key 的增删改） | `settings/page.tsx` + `/api/user/settings/serpapi` |
| 3 | ATC 查询服务封装（SerpApi 调用 + 过滤 + 缓存） | `src/lib/atc-service.ts`（新建） |
| 4 | 商家列表新增 ATC 列 + 手动刷新按钮 | `merchants/page.tsx` + `/api/user/atc/merchant-count` |
| 5 | 广告情报页（按广告主名称搜索） | `intelligence/page.tsx` + `/api/user/atc/intelligence` |
| 6 | 侧边导航加入口 | `UserLayout.tsx` |

**预计改动文件数**：6 个已有文件修改 + 4 个新文件 = **10 个文件**

---

### Phase 2（后续迭代）

- **监控告警**：员工对商家设置「广告主数量变化 >X%」告警，触发站内通知
- **Claude 市场报告**：对某商家或某类别自动生成 AI 分析报告，复用现有 `ai_providers` 配置
- **Claude 推荐引擎**：基于「内部投放人数 vs 市场竞争度」矩阵，推荐值得重点推广的商家
- **管理员公共 Key**：管理员在 `system_configs` 配置团队公共 SerpApi Key，用于每日自动全量同步，不依赖个人额度

---

## 十、关键约束与注意事项

1. **SerpApi 免费额度**：250次/月/人，适合按需查询；如需每日全量自动同步（50人 × N商家），需升级付费套餐或由管理员配置团队公共 Key。

2. **广告主过滤误判**：代理商关键词过滤基于名称启发式规则，可能存在误判。后续可引入人工标记白名单（已知代理商 ID 列表）来提高准确率。

3. **100条上限**：单次 SerpApi 查询最多返回 100 条广告（对应最多 100 个去重广告主）。大型商家的实际竞争数会被低估，UI 上应展示「≥X个」而非精确数字。

4. **SerpApi Key 安全**：Key 存储在 `users.serpapi_key`，后端查询时从 session 读取，**不暴露给前端**，每次调用由 Next.js API Route 代理请求 SerpApi。

5. **对现有功能零影响**：所有改动均为新增（新列、新表、新页面、新 API），不修改任何现有业务逻辑。

---

## 十一、文件变更清单

```
修改（6个）：
  crm-mvp/prisma/schema.prisma
  crm-mvp/src/components/UserLayout.tsx
  crm-mvp/src/app/user/settings/page.tsx
  crm-mvp/src/app/user/merchants/page.tsx
  crm-mvp/prisma/migrations/YYYYMMDD_atc_fields/migration.sql（自动生成）

新建（5个）：
  crm-mvp/src/lib/atc-service.ts              ATC查询封装（核心逻辑）
  crm-mvp/src/app/api/user/settings/serpapi/route.ts
  crm-mvp/src/app/api/user/atc/merchant-count/route.ts
  crm-mvp/src/app/api/user/atc/intelligence/route.ts
  crm-mvp/src/app/user/intelligence/page.tsx
```

---

*文档结束*
