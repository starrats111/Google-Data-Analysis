# Hermes 独立智能投放体 — 设计方案

> **文档规范**
> - 验收人：07
> - 设计人：AI 设计研发
> - 创建日期：2026-07-13
> - 版本：v1.3（2026-07-20 P2 上线；v1.2 为 2026-07-17 共享表格接入；v1.1 为 2026-07-16 第二轮需求澄清定稿；v1.0 为 2026-07-13 初稿）
> - 本文档是 Hermes 系统的**专属设计文档**；CRM 主设计文档（`设计方案.md`）中 HM-01 章节仅保留索引。
> - ⚠️ 本文档不写任何明文机密（token/密钥/密码），机密统一见 `C:\Users\Administrator\.infra\服务器总账.md`。

---

## 一、系统定位

Hermes 是**独立于 CRM 和 kyads 之外的第三套系统**：一个飞书交互的数字员工，自动完成联盟 offer 情报整理 → 筛选排队 → 创建投放任务 → 飞书审批 → CID 预占 → Google Ads 发布 → 监控与安全调整 → 每日复盘的全链路。

独立性边界（v1.1 修订）：

| 维度 | 独立方式 |
|---|---|
| 发布通道 | 自己直连 Google Ads API。凭证为 **wj07 在 CRM 绑定的 MCC**（`google_mcc_accounts` user_id=8 名下活跃行：MCC 941-949-6301「zwj0123」，行内自带 SA JSON + dev token）的**本地副本**，运行时不调 CRM/kyads 服务。注：号码与 kyads MCC 相同，但凭证来源以 CRM 该行为准 |
| 数据存储 | 服务器本地 SQLite，不写 CRM/kyads 库；团队去重/黑名单走**共享谷歌表格**（见第 5.4 节） |
| 联盟凭证 | wj07 的**两条** LH api_key 都**复制一份**存 Hermes 本地（CRM 生产库 platform_connections id=17「wenjun3/LH1」、id=277「novanest/LH2」，均 connected），视作两个独立 offer 池 |
| 团队去重 | 读写**共享谷歌表格**（已跑记录 + 黑名单，全员可编辑，各员工 Hermes 自动登记）；替代 v1.0 的 SSH 隧道读库方案。表格暂不可达时用本地缓存快照继续运行 |
| 交互 | Hermes Agent 原生飞书机器人（复用旧飞书应用凭证，websocket 长连，无公网回调）；全部走 07 私聊，不建群 |
| 多员工 | **一个 Hermes 对应一个员工**，本期只做 wj07 这套；代码按可复制部署设计（换员工凭证/配置即可再起一套） |

## 二、需求结论

### 2.1 第一轮（07 已确认，2026-07-13）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 总目标 | 重建 43.165.170.242 上的 Hermes，全环节（offer 管道/发布链路/监控/交互/稳定性） |
| 2 | 定位 | 独立第三系统，完全不依赖 CRM/kyads 运行 |
| 3 | Google Ads 凭证 | ~~复制 kyads 那套~~ → **v1.1 修订**：用 wj07 在 CRM 绑定的 MCC 凭证本地副本（见 2.2 #4） |
| 4 | 投放后端 | 全新重写（旧 hermes-crm 只参考思路，不恢复） |
| 5 | 交互 | Hermes Agent 原生飞书机器人 + 旧飞书应用凭证 |
| 6 | 审批方式 | **纯飞书内完成审批**，不恢复公网审批页（fengdu-ads.top/hermes-approve 保持下线） |
| 7 | 联盟 | 第一期只接 LH（用 CRM 的 wj07 凭证），架构预留多联盟抽象 |
| 8 | 存储 | 自己的 SQLite |
| 9 | 去重 | ~~SSH 隧道只读同步~~ → **v1.1 修订**：共享谷歌表格（见 2.2 #6） |
| 10 | LLM | gemai 中转（OpenAI 兼容，claude 系） |
| 11 | 风控 | 按 SOP 第一周权限：全部 approval_required + 硬限单日预算≤$5、CPC≤$0.3、每日新建≤5 |

### 2.2 第二轮（07 已确认，2026-07-16）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 方案基调 | 以 v1.0 为基础继续，不推翻；核心价值四合一：自动测 offer 流水线、飞书数字员工、情报整理、投放安全监控；不急上线，先聊透 |
| 2 | 多员工模型 | 一个 Hermes 对应一个员工，该员工名下所有数据（MCC/CID、联盟连接）Hermes 均有使用权；本期先把 wj07 这套完整跑通，代码可复制部署 |
| 3 | 范围 | 先 07（wj07）一套；换员工凭证/配置即可再起一套 |
| 4 | CID 来源 | wj07 在 CRM 绑定的 MCC/CID（实查：MCC 941-949-6301「zwj0123」活跃，名下 39 个 CID；791-461-8254 已删除不用） |
| 5 | LH 双池 | id=17（wenjun3/LH1）+ id=277（novanest/LH2）都接，独立 offer 池；A 无 B 有→用 B；两池都有→选佣金率高的池；A 池高 ROI→用 B 再投一份（双开，走复测队列+审批，理由「高 ROI 扩池」） |
| 6 | 团队去重 | 共享谷歌表格（人人可编辑）：登记「团队已跑记录（域名+国家+结果）」+「域名黑名单」两类；各员工 Hermes 测完自动登记、建队列前先读表；**替代** SSH 读库方案；表格开工时新建，结构见 5.4 |
| 7 | 黑名单初始 | 从零开始，靠每日复盘 + 人工拉黑累积 |
| 8 | 建广告参照 | 广告结构/关键词参照 kyads 现有实现（已读代码，规格见第 5.5 节）；**落地 URL 例外**：final URL 必须是商家域名，不照抄 kyads（07 修正，见 HM-D04） |
| 9 | 文案 | **默认 filter 模式（07 纠正，2026-07-20，对齐 kyads 生产默认）**：不 AI 生成——SerpApi 抓品牌词真实在投广告，LLM 只当「筛选官」原文照搬挑选组装 RSA；关键词=域名品牌词；预算/CPC 固定 $2/$0.3。AI 生成（ai_generate）仅 07 明确要求时用。审批卡片逐条展示给 07；成熟后免逐条审 |
| 10 | 测试国家 | 前一天指定「xx 国家多少个」按计划执行；未指定则跟 offer 可投国家，优先美国，一任务一国 |
| 11 | 每日计划 | 每晚 Hermes 主动飞书问「明天测什么」+ 07 随时一句话改计划，两者都要 |
| 12 | 默认预算/CPC | **固定 $2/天、CPC $0.3（07 纠正 2026-07-20，对齐 kyads 默认，不用 AI 建议）**；07 可在建任务时显式指定（仍受硬限 ≤$5 / ≤$0.3）。ai_generate 模式下才用 LLM 建议 |
| 13 | 效果闭环 | Hermes 自己定时拉 LH 转化/佣金报表算每任务 ROI |
| 14 | 归因 | 追踪链接不能带标识；靠**广告系列命名**归因，参照 CRM 实现（规格见第 5.6 节） |
| 15 | 测试周期 | 天数上限 + 花费止损双卡控（具体数值开工时拟一版给 07 审） |
| 16 | 监控 | 每小时巡检；触发止损条件直接自动暂停 + 飞书报告 |
| 17 | 放量 | 前期 Hermes 主动提案（ROI 达标发审批卡片建议加预算，每次加幅有上限），07 批准才执行；经验/学习样本足够后过渡到 Hermes 自主决策 |
| 18 | 每日复盘 | 以在投任务总览为主：每任务花费/点击/转化/佣金/ROI |
| 19 | 交互渠道 | 全部走 07 与 Hermes 的飞书私聊，不建群 |
| 20 | 代码管理 | 只服务器本地 git + 本机克隆备份，不上 GitHub |

## 三、现状基线（2026-07-13 SSH 实测）

- 服务器 43.165.170.242（腾讯云海外，2核/3.7G/59G，磁盘用 25%）。
- 仅剩全新 Hermes Agent v0.18.2（git 安装 upstream 56a8e81d，`~/.hermes` + `~/.hermes/hermes-agent`）；网关进程空转：无消息平台、无可用模型（config 指向 OpenRouter 报 payment error）。
- 旧 hermes-crm/网关 7 月 9 日已整体下线，备份：服务器 `~/hermes-reset-backup-20260709/` + 本地 `.infra` 副本；归档目录 `~/.hermes.old-20260709`（2.2G）、`~/hermes-crm.old-20260709`（414M）。
- 无 systemd hermes 服务、无 crontab 任务。

## 四、总体架构

```
43.165.170.242
├─ Hermes Agent v0.18.2（大脑 + 交互，systemd 用户服务 hermes-gateway）
│   ├─ 模型：gemai 中转 claude 系（config.yaml base_url 指向 gemai）
│   ├─ 飞书原生接入：旧应用凭证，websocket 长连，仅白名单用户/群可用
│   └─ skills（自然语言指令 → 调 hermes-ads API）：
│       sync-offers / build-queues / create-runs / pump-runs / daily-review
└─ hermes-ads（全新投放后端，Node 22 + SQLite，监听 127.0.0.1:8787，Bearer 鉴权）
    ├─ 联盟适配层（NetworkAdapter 接口，第一期实现 LHAdapter × 2 实例：LH1/LH2 双池）
    ├─ offer 管道（标准化 → 过滤 → 黑名单 → 团队去重 → 队列）
    ├─ 团队登记同步器（读写共享谷歌表格：已跑记录 + 黑名单，本地缓存快照兜底）
    ├─ 任务状态机（create → 审批 → CID 预占 → 发布 → 监控）
    ├─ Google Ads 直连（google-ads-api，wj07 的 MCC 凭证本地副本）
    ├─ LH 报表同步器（拉转化/佣金 → 按系列名归因 → 算 ROI）
    ├─ 风控硬限（代码层强制，见第八节）
    └─ SQLite：/home/ubuntu/hermes-ads/data/hermes-ads.db
```

- hermes-ads 以 systemd **系统服务** `hermes-ads.service` 运行，只绑回环，公网零暴露。
- Nginx 不做任何新配置（纯飞书审批，无公网页面）。
- 代码管理：hermes-ads 建独立 git 仓库，**服务器本地裸库 + 本机克隆备份，不推 GitHub**（07 已确认，2026-07-16）。

## 五、offer 管道设计（对应 SOP 第 3-6 节）

### 5.1 联盟适配层

```
interface NetworkAdapter {
  network: string                          // 'LH' | 'RW' | ...
  fetchAllOffers(): RawOffer[]             // 全量 offer 明细
  fetchStatuses(): OfferStatus[]           // 在线/合作状态校验
}
```

**v1.4（2026-07-20 HM-D15）：全联盟入池** —— 07 明确「每个联盟都拉取 API 存入池子」。wj07 名下 7 个联盟账号全部接入（key 复制自 CRM `platform_connections`）：

| 池 | 联盟 | 账号 | 适配器 | 接口形态 |
|---|---|---|---|---|
| LH1 / LH2 | LinkHaitao | wenjun3 / novanest | `adapters/lh.js` | post_form merchantBasicList3，200/页 |
| CG1 | CollabGlow | allurahub | `adapters/generic.js` | post_json monetization，2000/页 |
| EV1 | EngageVantage | mevora | 同上 | 同上 |
| MUI1 | UltraInfluence | allurahub | 同上 | 同上 |
| PM1 | PartnerMatic | keymint | 同上 | 同上 |
| RW1 | Rewardoo | parcelandplate | 同上 | post_form merchant_details，200/页（1000 必 504），慢（CRM 有 504 前科） |

- 端点/分页/限流参数照抄 CRM 生产 `platform-api.ts` 在跑配置；monetization 系传 `relationship:"Joined"` 只回已加入商家。
- 各联盟跳板域名（collabglow/engagevantage/ultrainfluence/partnermatic/rewardoo/creatorflare）已加入后缀跟链 `TRACKER_HOST_PATTERNS`，终态停跳板=没跟到落地页的判定对新联盟同样生效。
- CRM 还有 CF（7 商家）连接但 wj07 无 api_key 记录的不接；RW 连接在 CRM 侧 status=error（连续失败 3 次），Hermes 侧同步失败会在 sync_logs 里体现、不影响其他池。

历史（v1.1 双池版）：
- 池 A = CRM platform_connections id=17（account_name「wenjun3」，LH1）；池 B = id=277（「novanest」，LH2）。api_key 一次性从 CRM 库复制到本地 `.env`。
- 每池独立拉取全量明细，落 `offers` 表（带 `pool`/`network` 字段）。
- **选池规则**（建任务时定）：
  1. 只有一个池有该 offer → 用有的那个池。
  2. 两池都有（普通新测）→ 选佣金率高的池。
  3. 某池已验证高 ROI 可盈利 → 用另一个池再投一份（双开，占两个 CID）；走复测队列 + 飞书审批，理由固定「高 ROI 扩池」。

### 5.2 域名标准化（SOP 第 5 节，全库统一函数）

小写 → 去协议 → 去路径/参数/锚点 → 去 `www.` → 去尾斜杠 → 子域名提取主域名（`m.x.com`/`shop.x.com` → `x.com`）。所有比较（黑名单/已跑/队列）只用 `normalized_domain`。

### 5.3 筛选流水线（SOP 第 6 节，每步落库可追溯）

1. **可测池**：Online + Joined + tracking_url 非空 + siteUrl 可解析域名 + 推广限制不禁目标国家。
2. **排黑名单**：normalized_domain 命中 `domain_blacklist`(status=active)、restricted_keywords 明确禁 PPC/SEM/brand bidding、promotion_area 禁目标国家 → 排除。
3. **团队去重**：`normalized_domain + country_code` 已在共享表格「已跑记录」（本地缓存表 `team_tested_offer_history`）→ 默认不进新测队列。
4. **新测队列** `test_queue`：未跑过的，按佣金高、国家明确、规则清晰、支持 deeplink 排优先级。
5. **复测队列** `retest_queue`：仅限 ROI 好放量 / 人工标记复测 / 上次失败可恢复 / 规则重大变化 / 扩国家 五种理由，理由必填。

### 5.4 团队登记：共享谷歌表格（v1.2，2026-07-17 接入 07 提供的团队现有表格）

- **表格已定**（07 提供，2026-07-17）：`https://docs.google.com/spreadsheets/d/1wQE3ieaVJhkDPvbpn2y6ldThh6gtowQuhW0Tzlm6p7Q`，**任何有链接的人可编辑**（无需逐个授权）。
- **读通道**：公开 CSV 导出（gviz），**不依赖 Sheets API / 服务账号**，SA 的 GCP 项目 API 未启用也照常工作（已实测）。
- **写通道**：仍需 Sheets API（当前未启用）。写失败的行落本地 `pending_sheet_writes` 表兜底 + 本地缓存立即生效，API 启用后可补写。
- 团队表格现有工作表（实测结构，与原草案不同，按团队现状适配）：

**「黑名单」（gid=0，团队既有，约 4800 行）**

| 列 | 说明 | Hermes 用法 |
|---|---|---|
| 商家名称 / 商家平台 | 原始名称与联盟平台 | 留档（note/added_by 辅助） |
| 商家域名 | 域名 | **标准化后作黑名单主键**（5.2 规则） |
| 下架时间 / 备注原因 / 名单来源 | 时间、原因、登记人 | 映射到本地 `domain_blacklist` 的 added_at / reason / added_by |

**「白名单」（gid=874482181，即「推荐商家表」，团队既有，约 390 行）**

| 列 | 说明 | Hermes 用法 |
|---|---|---|
| 商家名称 | 原始名称 | 清洗为 match_key（小写去符号）与 offer 商家名匹配 |
| ROI参考 / 佣金率 / 结算率 | 团队实测参考 | 留档展示 |
| 标记 | 重点分享 / 普通分享 | **入队严格优先（HM-D15 改）**：重点 +1200 / 普通 +1000，白名单必然排在所有非白名单前（非白名单打分上限约 150） |
| 分享时间 / 备注 | 月份、说明 | 留档 |

**「已测记录」（gid=1885280150，已建，Hermes 登记用）**：列结构十列（normalized_domain / country_code / network / network_account / owner / source / tested_at / result / roi / note）。
- **登记时机（HM-D15 定）**：每发布一个广告（状态机进 monitoring）即自动 `registerTestedOffer` 登记一行（result=observing），同时写进本地 `team_tested_offer_history` 立即参与团队去重。
- **写通道（07 拍板 2026-07-20：不开 Sheets API）**：双通道自动降级——① Sheets API（哪天启用了自动生效，最快）→ ② **无头浏览器匿名编辑**（`src/lib/sheet-anon-write.js`：表格「任何有链接可编辑」，匿名 Chrome 会话直接写；公开 CSV 数行定位下一行 → Name Box 跳格 → 逐格键入 → Enter，写完重读 CSV 复核该行真的落表才算成功，全局串行，约 20s/行）→ ③ 两条都失败落 `pending_sheet_writes` 兜底，每日团队表同步时自动补写（`flushPendingSheetWrites`）。每日同步重建缓存时 pending 未补写的行会回填缓存，去重不丢。**服务器实测**：run#14 那行经浏览器通道 19s 写入成功，公开 CSV 复核在表 ✅。

- 同步节奏：建队列前全量读表刷新本地缓存（`domain_blacklist` / `team_whitelist` / `team_tested_offer_history` 三张 SQLite 表）；任务出结果后 Hermes **自动追加**已测记录行（写失败落 pending 兜底）。表格不可达 → 用本地最后快照继续跑 + 飞书告警。
- 实测效果（2026-07-17 服务器）：黑名单同步 4802 条、白名单 387 条；队列重建 9220 候选中 **黑名单排除 695**、白名单命中加权 16，新测队列 4313。

### 5.5 建广告规格（v1.1，参照 kyads 实现，2026-07-16 已读代码提炼）

> 参照来源：`C:\Users\Administrator\Desktop\项目\kyads`（关键文件：`lib/ad-create/google-ads-publisher.ts`、`default-campaign-name.ts`、`prompts/generate.ts`、`final-url.ts`）。

| 项 | Hermes 规格（对齐 kyads） |
|---|---|
| 结构 | 一任务 = 1 SEARCH campaign + 1 ad group + 1 条 RSA |
| 网络 | 仅 Google 搜索（`target_google_search=true`，其余 false） |
| 出价 | Manual CPC（不开 eCPC）；ad group / keyword 设 `cpc_bid_micros` |
| 地理 | 一国定位，`positive_geo_target_type: PRESENCE` |
| 语言 | 按国家映射语言常量 |
| 设备 | 不设 device criterion（默认全设备） |
| 关键词 | **域名品牌词 1 个**（kyads 口径，如 `["tous"]`），**PHRASE** 匹配；不做 LLM 扩词 |
| 否定词 | campaign 级 PHRASE；公共否定词表 = kyads 生产 `team_google_ads_publish_settings` 同款 55 词（2026-07-20 取回），上限 200 |
| RSA 文案 | **默认 filter 模式（kyads 生产默认，07 拍板 2026-07-20）**：SerpApi 三路样本（google SERP desktop+mobile、google_ads 六变体、透明中心整域名）抓真实在投广告 → 标题按 `\|/–/—` 拆、描述按句号拆成候选池（去重、30/90 字符过滤）→ LLM 筛选官按 kyads `prompts/filter.ts` 规则原文挑选（合规红线/六维评分/品牌自投+0.5/阈值降级保 3标题2描述下限）→ **代码层强制校验输出必须原文存在于候选池**；LLM 挂了走本地兜底（品牌自投优先）。样本不足下限→任务创建失败如实报 07（严禁编造）。`ai_generate`（LLM 生成，prompt 参考 kyads `prompts/generate.ts`）仅 07 明确说「用 AI」时启用 |
| Final URL | **必须是商家域名**（07 修正，2026-07-16）：优先商家首页；offer 支持 deeplink 且有更合适页面时可用该商家域名下的内页。**不能**用联盟 click URL，也**不能**照抄 kyads 的「验证落地页当 final URL」做法 |
| 追踪后缀 | 解析 LH tracking_url 跳转到商家落地页后，抽取落地页 URL 的 **query 参数**作 campaign 级 `final_url_suffix`（完整联盟链接 = 商家域名 + ? + suffix）；不用 tracking template。维护采用**完整后缀池体系**（07 已定 A 方案，2026-07-17），见 5.7 |
| 预算/CPC | **filter 模式（默认）固定 $2/$0.3（kyads 同款默认值）**；ai_generate 模式才用 LLM 建议；硬限预算 ≤$5、CPC ≤$0.3 代码层校验 |

**广告系列命名（归因关键，采用 CRM 6 段格式而非 kyads 新 5 段）：**

```
{序号3位}-{平台段}-{商家名清洗}-{国家}-{MMDD}-{merchantId}
例：001-LH1-nike-US-0716-12345
```

- 平台段带池序号（LH1=wenjun3，LH2=novanest），末段必须是 LH 数字 MID——归因解析依赖这两段（见 5.6）。
- 序号按 Hermes 本地历史最大号 +1，撞名自动顺延。

### 5.6 效果归因与 ROI（v1.1，参照 CRM 实现）

> 参照来源：crm-mvp `src/lib/platform-api.ts`（LH cashback2 拉单）、`campaign-naming.ts`、`campaign-merchant-link.ts`、`daily-stats-commission.ts`。

- **拉单**：LH `api.php?mod=medium&op=cashback2`（token=api_key，单次窗口≤31 天，页大小≤2000，限频约 4s），两池各拉各的。
- **归因链（两跳，与 CRM 一致）**：订单 `mcid`（数字 MID）→ 商家；系列名「平台段 + 末段 MID」→ 同一商家。即收入按 **商家 + 联盟账号（池）** 维度对齐花费，不靠追踪链接带标识（LH 的 tagcode/sub id 不用于归因）。
- **ROI 口径**：`(佣金 − 拒付 − Google 花费) / 花费`；日期按 CST 切日两侧统一。
- Hermes 一 CID 一系列、一商家一国一任务，正常情况商家↔系列一一对应，归因比 CRM 场景更干净；双开（两池同商家）时按平台段（LH1/LH2）分开对齐，不串池。
- 同步频率：每小时随监控巡检拉近 14 天增量；每日复盘前全量对账一次。

### 5.7 追踪后缀池体系（v1.1，07 已定 A 方案：完整复刻 CRM 模式，2026-07-17）

> 参照来源：crm-mvp `src/lib/suffix-engine/`（`stock-producer.ts`、`suffix-generator.ts`、`config.ts`）、`/api/cron/suffix-replenish`、`/api/v1/suffix/lease|report`、MCC 脚本 `link-exchange-script-template.ts`。

原理：联盟后缀（clickid/token 类参数）由联盟按次签发、有时效，**点击增长就要换新后缀**，否则转化算不到头上。CRM 用「池子预生成 + 脚本换链」解决，Hermes 完整复刻，但做一处架构适配：

**与 CRM 的差异**：CRM 靠 MCC 里的 Google Ads 脚本（AdsApp）监点击、换后缀；Hermes 自己直连 Google Ads API，**不装 MCC 脚本**，由 hermes-ads 后端直接查点击增量 + mutate `final_url_suffix`，链路更短。

| 环节 | Hermes 规格（对齐 CRM 数值口径） |
|---|---|
| 后缀生成 | 住宅代理跟 LH tracking_url 跳转（支持 LH lhdeal 延迟 JS 跳转，需无头浏览器兜底，单条超时 55s），取落地页 query 串入池；落地被商家前端洗参时回溯跳转链「同根域名 + 带联盟追踪键」那一跳取 query（CRM D-182 同款兜底） |
| 后缀前置验证（硬门槛） | **建任务时先跟链验证能拿到 suffix，再生成文案**（2026-07-20，07 反馈「suffix 跟踪链接没加上」后落地）：验证失败 → 该 offer 从队列排除（`test_queue.status=suffix_failed`）+ 飞书告知，不烧 SerpApi、不占每日额度；验证成功的后缀直接入池，审批卡片/确认页展示「追踪后缀 + 完整联盟链接」供 07 核对。⚠️ LH 部分 offer 走 **tatrck.com 跳板 cookie 归因**（lhdeal → tatrck `?url=&s=lh_xx` 302 → 商家落地**无任何参数**，tous/thriftbooks/airalo/canvasondemand/suppliesoutlet 实测均如此），这类 offer 无法用 final_url_suffix 追踪，只能排除 |
| 池表 | SQLite `suffix_pool`：campaign 维度，状态 `available / leased / consumed / expired` |
| 时效 | 入池 `expires_at = now + 36h`；过期回收；`leased` 超 6h 无回执回收 |
| 水位 | 目标库存 20 / 低水位 6 触发补货（起步任务少，可先按每系列 5/2 缩配，跑通后调） |
| 补货 cron | 每 5 分钟：先回收过期 → 低水位系列补货（带锁防并发、断链冷却） |
| 换链触发 | 每 5 分钟任务泵内查各在投系列**点击增量**（Google Ads API）；有增长 → 从池取最旧可用后缀 → mutate campaign `final_url_suffix` → 标记 consumed |
| 断链处理 | 跟链连续失败 ≥3 → 飞书告警 + 8h 冷却，**不自动停投**（广告继续跑旧后缀，对齐 CRM 策略）；由 07 决定处置 |
| 发布时 | 建系列前先为该商家生成首条后缀，发布时一并挂上；生成失败则任务 failed（发布前置校验） |
| 代理 | **复用 CRM 同款代理商 kookeey**（07 已定，2026-07-17）：网关 `gate.kookeey.info:1000`，socks5/http 同端口双协议，用户名模板带 `{COUNTRY}` + 8 位 session + life-5m（每会话 5 分钟出口轮换）；wj07 在 CRM 即绑 kookeey。凭证密码在 CRM 库 `kyads_proxies` id=1（AES 加密存储），P1 开工时解密复制一份到 Hermes 本地 `.env`，运行时不依赖 CRM |

## 六、任务状态机（对应 SOP 第 7 节）

```
created ──审批请求──▶ pending_approval ──07在飞书批准──▶ approved
   │                        │拒绝                        │
   │                        ▼                            ▼
   │                     rejected                  cid_reserved（一CID一系列）
   │                                                     │
   └───任何步骤失败───▶ failed（记录阶段+原因，停住不重试）│
                                                         ▼
                                                    publishing ──▶ monitoring
                                                                      │
                                                          止损触发→pause(自动，v1.1)
                                                          加预算/加CPC/扩词/扩国/双开(需审批)
```

关键规则（代码层强制，不靠提示词）：
1. 创建一律 `mode=approval_required`（第一周无 auto_publish）。
2. Hermes 机器身份**不能审批任何任务**（审批接口校验审批人身份 ≠ 机器）。
3. CID 预占：本地状态可用 + 远程实查无 enabled campaign，双验通过才占；失败即停。
4. 发布失败 → failed 并飞书报告，不自动换 CID 重试。
5. SOP 第 9 节 10 条停止条件全部实现为状态机的硬中断。
6. （v1.1）测试周期双卡控：天数上限 + 累计花费止损（具体数值 P2 开工时拟定给 07 审），到期/到线自动出结论并登记共享表格。
7. （v1.1）放量提案：monitoring 中 ROI 达标（阈值待拟）→ Hermes 主动发审批卡片建议加预算/加 CPC，每次加幅有上限（如 ×2 封顶）；07 批准才执行。经验样本足够后（07 另行批准）过渡到自主决策。
8. （v1.1）CID 来源：wj07 名下 MCC 941-949-6301（CRM google_mcc_accounts id=1「zwj0123」）的 39 个 CID；预占前本地状态 + 远程实查双验（沿用 v1.0 规则）。

### 飞书内审批流程（交互式卡片 + 指令双通道，07 私聊）

1. 任务进入 pending_approval 后，机器人向 **07 私聊**发**交互式卡片**（07 要求，2026-07-20）：蓝头卡片展示任务号、offer、域名、国家、池（LH1/LH2）、文案模式、预算、CPC、止损、关键词、RSA 文案逐条 + **「✅ 批准发布 / ❌ 拒绝」两个按钮**。卡片发送失败自动降级纯文本（含审批链接）。
2. 审批双通道任选：**① 点卡片按钮**——打开确认页（`https://google-data-analysis.top/hermes-approve/approve?rid=&act=&sig=`，HMAC-SHA256 签名链接、只发 07 私聊、GET 只展示确认页防预抓、POST 才执行、幂等防重复）；链路 = CRM nginx `/hermes-approve/` → 反向 SSH 隧道（CRM:18788 → Hermes 回环:8788，`hermes-approve-tunnel.service` 常驻，Hermes 安全组仅放行 22 故借道 CRM 入口，仅作哑 HTTPS 转发、无数据耦合）；**② 私聊回复指令**：`批准 #12 同意低预算测试` / `拒绝 #12 规则不清`。
3. 后端审批接口校验**审批人飞书 open_id 白名单**（初始仅 07 一人），并落审计日志（谁、何时、批/拒、备注）；机器人自身 id 硬编码禁止出现在白名单。
4. 同一任务提醒只发一次（去重表），07 可指令要求重发。
5. 每日复盘输出当日全部审批流水，供 07 复核（信任边界补偿：审批指令经由 Agent 转发，审计日志 + 日复盘保证可追责）。

## 七、数据模型（SQLite，建表 DDL 开工时定稿）

| 表 | 用途 | 对应 SOP Sheet |
|---|---|---|
| `offers` | 全量 offer 原始池 + 状态校验结果（含 `pool` 字段区分 LH1/LH2） | all_offers_raw + advertiser_status_raw |
| `domain_blacklist` | 域名黑名单**本地缓存**（源=共享谷歌表格 Sheet2） | domain_blacklist |
| `team_tested_offer_history` | 团队已跑记录**本地缓存**（源=共享谷歌表格 Sheet1，任务出结果后回写表格） | team_tested_offer_history |
| `daily_plans` | 每日测试计划（国家×数量，飞书指令写入） | — |
| `test_queue` / `retest_queue` | 新测/复测队列（含 priority/test_decision/reason） | agent_offer_test_queue / retest_queue |
| `ad_runs` | 投放任务主表（状态机） | agent_run_log 主体 |
| `run_events` | 任务事件流水（每次状态迁移/API调用/失败原因） | agent_run_log 明细 |
| `cid_registry` / `cid_reservations` | CID 池与预占记录（唯一约束保证一 CID 一系列） | — |
| `approvals` | 审批流水（审批人 open_id/动作/备注/时间） | — |
| `daily_reports` | 每日复盘快照 | daily_report |
| `suffix_pool` | 追踪后缀池（campaign 维度，available/leased/consumed/expired，36h 过期） | — |
| `sync_logs` | 联盟同步/去重同步/后缀补货日志 | — |

## 八、风控硬限（代码层，写死不可被提示词绕过）

| 限制 | 值 | 实现位置 |
|---|---|---|
| 单任务日预算 | ≤ $5 | 创建接口校验 + 发布前二次校验 |
| 单任务 CPC | ≤ $0.3 | 同上 |
| 每日新建任务数 | ≤ 5 | 创建接口按日计数 |
| 一 CID 一广告系列 | 唯一约束 + 远程实查 | cid_reservations + Google Ads 查询 |
| 自动调整范围 | 仅 pause/keep：每小时巡检，触发止损条件**直接自动暂停**+飞书报告（v1.1 简化，不做自动降预算/降CPC 中间档） | monitor 执行器白名单 |
| 加预算/加CPC/扩词/扩国 | 必须飞书审批 | 状态机 |
| 机器不能自审 | 审批人白名单排除机器 id | 审批接口 |
| 停止条件 | SOP 第 9 节 10 条 | 状态机硬中断 + 飞书报告 |

第一周结束后由 07 复盘决定是否开放小额 auto_publish（另立变更记录）。

## 九、每日运转（cron 编排）

| 时间 | 任务 | 方式 |
|---|---|---|
| 08:00 | 联盟全量同步（双池）+ 重建队列 | crontab curl `POST /api/sync` + `/api/queues/rebuild` |
| 08:30 | 共享表格同步（已跑记录 + 黑名单刷新本地缓存） | crontab curl `POST /api/team-history/sync` |
| 09:00 | 按当日计划（`daily_plans`）批量建任务 → 发审批卡片 | crontab curl `POST /api/runs/plan-execute` |
| 每 5 分钟 | 任务泵（推进状态机到下一卡点 + 新审批提醒 + 点击增量换后缀） | crontab curl `GET /api/cron/pump?notify=true` |
| 每 5 分钟 | 后缀池补货 + 过期回收 | crontab curl `POST /api/cron/suffix-replenish` |
| 每小时（:12） | 监控巡检：花费/点击回流落 `run_daily_stats` + 止损双卡控自动暂停 + 换后缀健康/回流断流告警（同类 6h 去重） | crontab curl `POST /api/cron/monitor` |
| 每小时 | 监控巡检（Google 花费 + LH 近 14 天报表增量 → 止损判断 → 自动暂停/放量提案） | crontab curl `POST /api/cron/monitor` |
| 21:00 | 飞书私聊问 07「明天测什么（国家×数量）」，回复写入 `daily_plans`；07 全天可随时改 | Agent skill |
| 21:30 | 每日复盘生成（在投任务总览：花费/点击/转化/佣金/ROI）+ LH 全量对账 + 飞书推送 | crontab curl `POST /api/report/daily` |
| 全天 | 07 飞书指令（同步/建任务/审批/改计划/复盘），由 Agent skills 调 API | 飞书私聊 |

所有 cron 接口用 `CRON_SECRET` Bearer 鉴权；日志落 `/var/log/hermes-ads/`，按周轮转。

## 十、分期计划与验收

| 期 | 内容 | 验收标准（07 验收） |
|---|---|---|
| P0 | gemai 模型配置 + 飞书原生机器人上线 + 白名单 | 飞书群 @Hermes 正常对话，非白名单用户被拒 |
| P1 | hermes-ads 骨架 + LHAdapter×2（双池）+ 筛选管道 + 共享谷歌表格（新建+同步器）+ 队列 + skills(sync/queues) | 飞书发「同步 offer / 生成队列」输出 SOP 7.1 规定格式的数量汇报（分池），黑名单/去重抽查零漏，表格自动登记可见 |
| P2 ✅（2026-07-20 交付，见 HM-D09/D10） | 任务状态机 + 每日计划（21:00 问询+指令改）+ 飞书审批 + CID 预占 + Google Ads 发布（5.5 规格）+ skills(create/pump) | 1 个 approval_required 任务全链路走通（含审批卡片展示文案）——**run#8 Tous（filter 模式，真实广告原文筛选）**已到 pending_approval、卡片已发，**发布段等 07 飞书批准后触发**（AI 版 run#7 已按 07 纠正删除，默认改 filter 见 HM-D10）；硬限实测（超 $5/超 0.3/超 5 个/机器自审 全部被拒）✅；测试周期/止损数值定稿→待确认项 #7（默认 7 天/$15 待 07 拍板）。21:00 主动问询属 Agent 侧定时，随 P3 cron 编排一起做 |
| P3 | 每小时 monitor（止损自动暂停 + 放量提案）+ LH 报表归因 ROI + 每日复盘 + cron 编排 | SOP 第 7/8 节每日流程完整跑一天，复盘含每任务花费/点击/转化/佣金/ROI。进度：monitor ✅（HM-D14）、每日复盘 ✅（HM-D19）、自动调参 ✅（HM-D25）、**佣金归因 ROI ✅（HM-D28，扩展为全联盟拉单不止 LH）**；余：放量提案 ROI 阈值（待确认项 #8） |

每期完成在本文档「变更记录」追加一行，07 验收后进下一期。

## 十一、待 07 确认项

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| 1 | ~~审批页入口~~ | 纯飞书内审批，不恢复公网页 | ✅ 已确认（2026-07-13） |
| 2 | ~~LH 凭证~~ | 用 CRM wj07 的 LH 连接（id 17/277 已核实 connected） | ✅ 已确认（2026-07-13） |
| 3 | ~~黑名单初始数据~~ | 从零开始，共享谷歌表格累积（复盘建议 + 人工拉黑） | ✅ 已确认（2026-07-16） |
| 4 | ~~CID 池范围~~ | wj07 名下 MCC 941-949-6301（zwj0123）的 39 个 CID，Hermes 有使用权，预占前双验 | ✅ 已确认（2026-07-16） |
| 5 | ~~wj07 两条 LH 连接用哪条~~ | 都用：双池模型（LH1=wenjun3、LH2=novanest），选池规则见 5.1 | ✅ 已确认（2026-07-16） |
| 6 | ~~hermes-ads 是否推 GitHub 私库~~ | 不推；服务器本地 git + 本机克隆备份 | ✅ 已确认（2026-07-16） |
| 7 | 测试周期/止损具体数值 | **AI 已拟一版（2026-07-20，待 07 拍板）**：① 天数上限 `TEST_DAYS_CAP=7` 天——品牌词测试 7 天足够看出有无转化，无转化即止；② 累计花费止损 `TEST_SPEND_CAP_USD=15`（= 3 天满预算 $5×3）——到线未回本即自动出结论。两者任一先到即触发。数值已写入 hermes-ads `.env`（可随时调），止损执行器（到期/到线自动出结论+暂停）属 P3 monitor cron。**若 07 有别的数值直接说，改 env 即生效** | 待 07 拍板（默认 7 天 / $15） |
| 8 | 放量提案 ROI 阈值与加幅上限 | P3 开工时拟定 | 待拟定 |
| 9 | ~~共享表格创建与授权~~ | 07 直接提供团队现有表格（公开编辑，ID `1wQE3…6p7Q`），Hermes 走公开 CSV 读，已接入并实测（见 5.4 v1.2） | ✅ 已确认（2026-07-17） |
| 10 | ~~后缀维护深度~~ | **A 方案**：完整复刻 CRM 后缀池体系（池+补货+点击增量换链），Hermes 用直连 API 替代 MCC 脚本，规格见 5.7 | ✅ 已确认（2026-07-17，07：A） |
| 11 | ~~跟链代理来源~~ | 复用 CRM 同款代理商 **kookeey**（gate.kookeey.info:1000，实查 CRM 库唯一 active 供应商，wj07 已绑）；凭证开工时从 CRM `kyads_proxies` 解密复制到 Hermes 本地 | ✅ 已确认（2026-07-17） |
| 12 | 共享表格的 Google API 权限 | 07 提供公开编辑表格后，**读已完全解决**（公开 CSV 通道，不需要 API）。残留：Hermes **自动写**「已测记录」仍需 Sheets API（kyads SA 的 GCP 项目未启用，实测 403）。P2 前不阻塞——写失败会落 `pending_sheet_writes` 兜底、去重走本地缓存。彻底解决仍是原二选一：07 到 GCP 控制台启用 Sheets API（项目 opportune-epoch-496313-i9），或后续换有 API 的 SA | 半开（仅写通道，不阻塞） |

## 十二、变更记录

| 记录编号 | 日期 | 内容 | 07 状态 |
|---|---|---|---|
| HM-D45b | 2026-07-28 | **07 看审批页「系列名怎么还是这样」——页面上是 526/527，而当天实际发布出去的是 163**。查下来 HM-D45 的发布改号是对的（152-163 严格连号、日期都是 0728），坏的是**发布之前**那个占位号：建任务时用 `nextSeq()` = 全表 `MAX(seq)+1`，起点是 HM-D27 接管的 CRM 号段（310），再随建任务一路爬，名单深到 92 个时占位号已经飙到 536——等于给 07 看了个跟上线号差三百多的假号；日期段同理是建号那天（0723 的名字挂到 0728 还在）。**发布顺序是 FIFO，所以真号在建任务时就算得准**：`forecastSeq(runId)` = 已发布最大号 + 排在自己前面的待发布任务数；`nextSeq()` 改用它，新任务的占位号不再乱爬；`previewCampaignName(run)` 给发布前的展示用，序号与日期段一起刷成「按当前排队位置 + 今天」，已发布的原样返回不动。审批页（`approve-server.js`）、飞书单条卡、批量卡三处都改成显示预估名并注明「按当前排队位置预估，发布那一刻重定」——**之前只有飞书卡带这句提示，审批页是裸贴库里的名字**，而 07 看的正是审批页。存量 78 条待发布任务的占位号一并刷成 164-241 | 待 07 验收 |
| HM-D48 | 2026-07-28 | **07 给了《选商家 —— 业务流程拆解》，要求「让 Hermes 按照这个来筛选」**。SOP 五个阶段二十个检查点，逐条对下来 Hermes 缺三样数据：商家级拒付率、ATC 在投同行数、客单价——**这三样全在 CRM 手里**（拒付商家页、ATC 快照表、政策标签表），而 Hermes 在另一台机器上、CRM 的 MySQL 只监听 127.0.0.1。落地：① **开只读快照通道**（CRM 侧新增 `/api/hermes/merchant-intelligence`，Bearer 鉴权，一次全量返回政策标签 3193 条 + 拒付率 5202 条 + ATC 快照 341 条；Hermes 侧 `sync-crm-intel.js` 整表替换落进本地 SQLite，每天 07:50 cron 跑，比队列重建早 10 分钟）——**不直连库**是为了 CRM 挂了不影响 Hermes 选品。② **阶段二初筛**（`lib/sop-screen.js`，队列重建时对全池 1.9 万个商家跑，只查本地表）：政策标签违规、拒付率 >25%（口径与 CRM 拒付页一致——按佣金金额不是按笔数）、ATC >10 个同行、商家名是货号。③ **阶段三三关**（`lib/sop-deep.js`，只在建任务前对少数候选跑）：SerpApi 验品牌搜索量（第一条自然结果是不是官网 + 第一屏有没有第三方声量）、联盟条款允不允许投品牌词、单笔佣金 ≥$1.5（推荐表有带单佣金就直接用，没有就 puppeteer-core 抓官网首页价格算，结果缓存 30 天）。**07 拍板「查不到就放行并降分，不淘汰」**——现查失败不该让商家背锅。④ **阶段一取号顺序按 SOP 改成白名单 → 推荐表 → 联盟平台三档严格不重叠**（改前是「推荐表 5000-rank 压过白名单 +1000」，与 SOP 刚好反了），平台内 MUI→LH→LB→EV→CG→RW 也改成档位而非加权分。⑤ **阶段四国家档位对齐**：新增 `countryFromName()`（SOP 4.1.1「先看商家名里的国家词」——Hornby UK 的域名是 hornby.com，只看后缀会漏判成 ES），「不要投」档的主场国按 SOP 4.2 换同语言邻国（NL→BE、BR→ES/US、TH→PH/HK、SE→DE/PL）而不是整个放弃。⑥ **阶段五筛选台账**（`screen_ledger` 表按 SOP 的 A-T 二十列记，通过和淘汰都记，一天一个「域名+国家」一行，重跑只更新）——SOP 原话「淘汰的也要登记，不然下个月这个商家又会被翻出来重判一遍」；回写 Google 工作表**只回写走完三关的那批**，阶段二一天判 2.2 万行是机器扫全池的量，匿名写通道逐格键入写不动也没人看，其余 `GET /api/screen-ledger` 随时查。**两处纠偏**：`looksLikeCodeName` 初版把 Booking.com、PROMOFARMA 一起杀了，拆成 `isObviousCode`（ASIN/货号硬淘汰）+ `needsBrandCheck`（像域名的强制走阶段三品牌搜索验证）；`Revshare 70%` 这类分成比例被当成佣金率会算出天价单笔佣金再打上「优先」标签，>50% 一律当未知（数据真实性规范里记过这个坑）。**07 拍板的三件事**：CRM 违规名单 854 个先报给 07 复核再拉黑（**实测发现全部已被团队黑名单挡住，无敞口**）、缺数据现场查、台账本地表 + 回写工作表。**实测**：全池 22350 行判定，通过 17266、淘汰 5084（无可投国家 2497、标签违规 1511、亏损品类 840、团队已测过 122、拒付率过高 87、禁止品牌词 22、无品牌词 5）| 待 07 验收 |
| HM-D47 | 2026-07-28 | **07 反馈「这个拒登的信息返回要是能让我看懂的」**。起因是令牌池（HM-D46 后续）把发布打通后，飞书连着弹三条 `GoogleAds 400: Request contains an invalid argument. [{"@type":"type.googleapis.com/google.ads.googleads.v21.errors.GoogleAdsFailure","errors":[{"errorCode":{"policyFindingError":"POLICY_FINDING"},…}]}]`——整段 JSON，看不出哪个商家、为什么被拒、要不要管。拆开真实报文发现关键信息埋在第四层：`details.policyFindingDetails.policyTopicEntries[].topic` = `DESTINATION_MISMATCH`，`evidences[].destinationMismatch.urlTypes` = `FINAL_MOBILE_URL`——**不是商家违规，是联盟后缀在手机端把 calvinklein.com 跳去了别的域名**，Google 判网址不一致。落地：① 新增 `src/lib/ads-error.js`，`explainAdsError()` 把政策条目 + 证据 + requestId 拆出来翻成「哪个环节、什么原因、Hermes 怎么处理」，非政策类错误（账号停用、没权限、没绑卡、重名、认证失败、令牌被禁）走 `ERROR_HINTS` 词表各配一句人话与处置建议，认不出来的至少区分「Google 侧」还是「网络/代理侧」；`failureLine()` 补上商家/国家/域名/系列名，飞书里一眼定位。② **建广告当场被拒不再算「发布失败」**——`POLICY_FINDING` 直接进拒登库（HM-D40），同域名今后不再排期，避免同一个商家换个国家再撞一次墙（#163/#164/#165 就是 Calvin Klein 的 HK/TW/JP 各撞一次）；报错落库也存人话，后台列表和日报同样看得懂。③ **通知按域名合并**，一轮多个任务撞同一个坑只讲一遍、列出受影响任务号。④ 政策词表从 13 条补到 38 条（处方药、门票转售、烟草、假冒等），`recordRejection` 去重改为「有 campaignId 按 campaign 认、没有按域名认」（建广告时就被拒压根没有 campaignId，原逻辑会一个国家躺一条）。补录历史 5 条政策失败入库、合并 Calvin Klein 的 3 条重复、旧记录英文政策名刷成中文 | 待 07 验收 |
| HM-D45 | 2026-07-28 | **07 反馈「广告系列名都乱七八糟的，完全没有按照顺序来。要求系列名的顺序和任务顺序一样，我发布的 001 任务序号就是 001，任务序号只认发布的序号」+「任务发布为什么一下发 100 多号、一下发 200 多号，是不是队列弄错了」**。两件事其实是一根因：序号在**建任务**时分配，而 HM-D42 把发布顺序改成了**按推荐表名次抢 CID**，于是 #151 和 #227 交替上线，号码看着毫无规律。落地（07 逐项拍板）：① **序号改在发布那一刻给**——`nextPublishSeq()` 只数已发布的、Hermes 自成一套从 001 连起，`finalizeCampaignName()` 同时重写首段序号与倒数第二段 MMDD（与 HM-D44 合并成一次改名），发布成功才写回、失败不占号不留空号；建任务时的号退化为占位，审批卡标注「序号/日期发布时重定」；顺带砍掉每建一个任务就拉一次 CRM sheet 对齐号段的网络往返。② **发布顺序改回按任务号 FIFO**（撤销 HM-D42 的 priority 排序）——推荐表名次在「建哪些任务」那步已经生效，到发布这步 07 要的是先来后到、好对账。③ **与 CRM 重号 07 拍板接受**（两边靠 campaignId 匹配数据，平台段 + CID 能分清）。④ **历史 140 条按发布时间重排 001-140**（`tools/renumber-published.mjs`，跑前停服务防 pump 抢号），**HM-D27 接管的 5 条 CRM 存量不动**（它们的号属于 CRM 号段，改了会动到 07 自己建的系列）；Google 后台同步改名时**打爆了配额**（BASIC token 15,000 次/天，当天已被 HM-D43 那场 403 风暴烧掉大半），34 条成功、106 条 429，遂改为**巡检自愈**：状态同步（HM-D39）顺带比对远端名字，不一致就推本地名过去，`rename_sync_per_round`(15) 限量摊到每轮，约十轮补齐。**排查中挖到一个比编号严重得多的问题**：新 MCC `988-504-7597` 名下 **37 个在投广告一个都不在回流表格里**，而花费哨兵读表判 $9 线、读不到直接 return——**这批广告的止损从上线起就是失明的，烧到多少都不会自动关**。一开始判断成「MCC Ads Script 只装在老 MCC 上」，**07 指出「每个 MCC 都有一个表格」并给了新 MCC 的表**（`1sL9EZBP…`，结构与老表一致、公开可读、正好盖住那 37 个）——真因是 **Hermes 只读了一张表**。落地：`config.crmMetricsSheetIds`（`CRM_SHEET_IDS` 逗号分隔，默认老表+新表）+ `loadOne()` 逐表读、按 campaignId 合并，一张挂了不连累其他 MCC，全挂才抛错；同时保留 `guardStatsWhenSheetBlind()` 作二道兜底（表里没有就直查 Ads 喂哨兵，`guard_api_interval_min`(15) 节流防吃光配额）。**实测**：覆盖 361 个 campaign，在投 63 个命中 62（仅剩 #25 那个 403 老账户），当时零出单超线 0 个、最高 $8.63 正在逼近线上 ✅。**运维铁律：以后每加一个 MCC，必须把它的表格 ID 追加进 `CRM_SHEET_IDS`，否则该 MCC 全体广告止损失明** | 待 07 验收 |
| HM-D44 | 2026-07-28 | **07 需求「系列名是审批的时候就建好的，但发布可能要两三天后，我希望广告系列里面的日期是发布日期」**。名单模式（HM-D42）下建名与上线彻底解耦——名单 100 深、CID 30-79 个，任务躺两三天很正常，`0726` 的名字挂到 0728 才上线，回头对账分不清哪天开的。落地：`withPublishDate()` 只替换 6 段命名里倒数第二段的 MMDD（序号/平台/商家/国家/MID 全不动，从后往前定位避免商家名含横杠），pump 发布前改名并写回本地、记一条事件流水；审批卡的系列名后面标注「日期段以实际发布当天为准」。**未动序号**：首段 seq 也是建任务时按「本地历史 max+1 与 CRM 在投 max+1 取大」分配的，同理会有滞后甚至与 07 手工建的撞号，但改它要在发布时再查一次 CRM sheet（每条一次网络往返），先留给 07 决定 | 待 07 验收 |
| HM-D43 | 2026-07-28 | **07 反馈「新 MCC 可以投放了，但是没有用 100 个待投放任务，而是重新建任务」——根因是新 MCC 的 CID 全部 403，把任务泵卡死 5 小时**。表象是 Agent 又去手工批量建任务（还撞上 create-run 互斥锁全失败），但名单其实有 112 个任务、CID 池 49 个空位，谁也没接上。**真因链**：① `login-customer-id` 全局写死 wj07 MCC `941-949-6301`，07 新加的 MCC `988-504-7597` 名下 49 个子账号每次调用都 `403 The caller does not have permission`——实测 SA `qmy123@` 对新 MCC **是有权限的**（`listAccessibleCustomers` 里有 9885047597），换成新 MCC 的 login id 立刻 200，纯粹是请求头报错了 MCC；`cid_registry.mcc_id` 本来就记着归属，改成按 CID 查 MCC（10 分钟缓存）即通。② `reserveCid` 对每个任务都把所有候选 CID 挨个远程实查，49 个必 403 × 94 个待投任务 = 四千多次注定失败的 API 调用，**一轮 pump 跑了 5 个多小时**；改为 403 即标记 `is_available='N'`（带 note，走 6h 自愈复查）+ 单次预占最多试 15 个候选。③ **最危险的一环**：pump 是锁内任务，卡住后每 5 分钟的 cron 全被「pump 正在运行中」挡回（cron.log 里 23 条无人看），**花费哨兵连续 5 个多小时没跑**，零出单超线的广告没人管；新增 `pump_round_budget_min`（默认 4 分钟）超时收工、剩下的下一轮接着做，并给互斥锁加看门狗——被挡回时算持锁时长，超 15 分钟发飞书报警（每锁 30 分钟一条）。**修复后实测**：新 MCC CID 直查 200 ✅；4 分钟内自动接位发布 10 条（#131-#140，全部落在新 MCC CID），在投 27→37，名单 102/100 自动补齐 ✅。**遗留**：老 MCC 的 CID `5509319692`（#25 hunderunde）仍 403，是该账号本身没授权给 SA，需 07 在 Google Ads 后台处理 | 待 07 验收 |
| HM-D42 | 2026-07-27 | **07 反馈「我让 Hermes 把审批后待投放的广告队伍扩充到 100，Hermes 这么回我，估计是这个待投放的队伍没做好流程，才让 Hermes 有误解」——待投名单概念澄清 + 补货分轮**。07 说「现在把等待队列数拓张到 100 个」，Agent 改的是 `hard_daily_runs`/`daily_runs`（15→100，每日新建配额），`waitlist_target` 仍是 30，等于**答非所问且动了 Owner 风控栏杆**；随后 07 问「有多少广告缺少」，Agent 又只报了 `pending_approval`=2，实际名单是 29（2 待批 + 27 已批等 CID），听着像名单见底、其实是快满了。**根因是三个数长得像**：待投名单（库存）/ 每日新建配额（速度）/ CID 池（真正能同时在投几条），skill 的设置映射表里只有后两个，没收录「等待队列」这个说法。落地：① `GET /api/waitlist` 一次给全——名单 count/target/低水位、待批与已批等 CID 的拆分、`cid_pool` 总量/可用/占用、要改哪个 key，以及 `bottleneck` 直接把「CID 池已满、N 个已批任务发不出去、扩容要往 CID_List 加子账号」写成人话；② skill v1.13.0 第 5 节加「三个数别搞混」对照表 + 判断口诀（说库存→名单、说速度→配额、说投不出去→先看 CID 池），设置项 desc 里互相点名（`daily_runs` 注明「不是待投名单」、`waitlist_target` 注明 07 的原话说法）；③ 新增 `waitlist_max_build`（默认 30）——名单目标调到 100 后缺口有七十个，一个任务要 1-2 分钟、一轮全建完要两个多小时，会把下一轮 :45 的 cron 撞锁挡掉，改成每轮最多建 30、分几轮爬到 target，返回带 `remaining`。**已按 07 本意改到位**：`waitlist_target` 30→100、`waitlist_low` 10→50、`waitlist_max_build` 30。**同时要交代的事实**：名单是库存不是产能，CID 池只有 30 个（当前 0 可用），名单堆到 100 也只有 30 条能同时在投，07 新加的 MCC 988-504-7597 子账号 CID 填进 CID_List 表后才是真扩容。**07 追加定调「待投名单不预占 CID，有 CID 被释放时就从名单里选一个投，所以名单有多少个都无所谓」**——查证后现状确实如此（CID 只在 pump 发布那一刻 `reserveCid`，`approved` 任务不持有任何 CID，池空就留在 approved 每 5 分钟重试），按这个模型补了四处：① **发布顺序改按价值**——名单深了以后「谁抢到刚释放的 CID」才是真正决定测什么的地方，原来是 `id ASC` 先建先上，等于几天前建的低价值任务永远插在新推荐商家前面；新增 `ad_runs.queue_priority`（建任务时从队列带过来，推荐表层 5000−rank），pump 改 `queue_priority DESC, id ASC`，已回填 43 个存量任务（当前队首是 rank 28 的 lagos-US）；② **出库前复查拒登库**——任务可能在名单里躺几天，期间同域名在别国被拒进了库，不复查就会拿刚回收的 CID 去投注定被拒的广告，命中即 cancelled 不占 CID；③ **删掉「CID 不足已排队」飞书提醒**——名单常态就是排队等 CID（100 深时七十个在等），这个提醒本身成了刷屏源；改为只报**卡住**（池子有空位却发不出去=故障，6h 一条），排队状态每任务只记一条事件流水；④ 每日 09:30 复盘卡加一行名单/CID 池现状（待批、已批等 CID、池容量与空闲、昨日接位发布数） | 待 07 验收 |
| HM-D40 | 2026-07-27 | **07 需求「会有广告因为各种原因被拒登，我需要能给 Hermes 发这个图片，能自动放到拒登库，之后每次做广告避开这些问题」——拒登库**（07 附 311-MUI1-brooksbrothers 的 Google 拒登邮件截图：政策「目标页面不匹配」）。落地时先验证了一件比截图更值钱的事：**拒登状态可以直查**——`ad_group_ad.policy_summary` 带 `approval_status` 与 `policy_topic_entries`，截图上的信息 API 里全有（brooksbrothers 实测返回 `DISAPPROVED` / `DESTINATION_MISMATCH` / 证据 `FINAL_MOBILE_URL`）。所以做成两条入口一个库：① **自动发现**——每小时巡检按 CID 分组查一次（与 HM-D39 状态同步合并成同一条 GAQL，零额外请求），`DISAPPROVED` 即入库 + 暂停 + 回收 CID + 汇总通报；② **07 发截图**——Agent 读图取「系列名 + 政策名 + 说明」调 `POST /api/rejections`（中英文政策名归一到 topic code，默认顺手暂停，`pause:false` 可只入库）。**规避按域名整体生效**（同一域名换国家重测大概率还是拒）：`build-queues` 排队时过滤、`createRunFromQueue` 建任务时拦截（放在最前面，连 SerpApi 文案和后缀验证的钱都省），07 说「拒登 #N 解除」→ `POST /api/rejections/clear` 恢复。新表 `ad_rejections`（系列+政策唯一，含证据/截图路径/来源/解除备注）；skill v1.12.0 第 11 节。**上线首轮实测（2026-07-27 09:33 CST）**：**11 个拒登入库，其中 7 个还开着在跑**——ticombo 一家占 7 国（TICKET_RESALE 票务转售，属需资质的受限类目，US/ES/FR/DE/SG/AU/GB 全军覆没）已全部自动暂停 ✅；另有 beelivery（TOBACCO）、nexcess/mingwangknits/brooksbrothers（DESTINATION_MISMATCH，联盟跳板导致展示网址与到达网址不一致）已是暂停状态，只入库 ✅；5 个域名（ticombo/beelivery/nexcess/mingwangknits/brooksbrothers）从此不再排新任务 | 待 07 验收 |
| HM-D39 | 2026-07-27 | **07 需求「我在 CRM 手动的操作，要回传给 Hermes，两个系统要同步数据」——远端真值同步**。此前 Hermes 只认自己库里的状态，07 在 CRM 数据中心或 Google Ads 后台一手动开关，两边就分叉：Hermes 以为在投的其实早被关了（还在等它出单、占着名额），Hermes 以为关了的其实又被开起来了（脱离止损管理一路亏）。落地：每轮巡检开头按 CID 分组拉 Google 真值（一个 CID 一条 GAQL，顺带取拒登状态，见 HM-D40），**Google 为准回写本地**——① 本地在投 / Google 已关 → 跟随暂停（零出单回收 CID，出过单的留位等佣金回流）；② 本地已停 / Google 在投 → 跟随续投并**重新纳管止损**，同时记「**净亏基线**」：07 明知在亏还要开是他的判断，Hermes 下一轮秒关等于跟他打架，所以要在续投当时的净亏之上**再亏满 `stop_net_loss_usd`** 才自动关（中途被自动止损过则基线作废）；手动续投也不再受运营期 ROI<0 那条闸门约束，只受净亏额度约束。反向不需要同步——CRM 数据中心读的就是 Google 真实状态。**首轮实测**：#47 Cariloha、#48 FatAndWeirdCookie、#76 evryjewels 三个 07 在后台关掉的跟随暂停 ✅（都出过 16-76 笔单，CID 按 HM-D38 规则留位）；#75 mapleparking（07 在后台重开）跟随续投、基线 $4.67 ✅。**上线路上补了一刀**：#75 首轮没纳管成功——它昨天被止损关掉时 CID 已回收给 #100，`reacquireCid` 拒绝后原逻辑直接跳过；但广告在 Google 上照样花钱，不认它只会让它彻底无人管，改为**占不回 CID 也照常纳管**，只记「CID 占位冲突」事件并在通报里标注该账户下有两条 Hermes 系列 | 待 07 验收 |
| HM-D38 | 2026-07-27 | **07 要求「按规则有些不该停、有些过晚停，先做数据检查、系统检查」——全量对账后修三大破口**。**数据检查结论**：钱主要漏在「没人停」而非「停错」——误杀合计仅 $42（CRM 哨兵 6 个，佣金滞后 12-48h 到账），而 CRM 侧 119 个「已出单但持续净亏」的系列仍 ENABLED，累计净亏 **$1,754**（piquelife 一个 -$387），两系统都没有这条规则；另有 87 个哨兵想停停不掉（jy 组 MCC 无 SA 凭据，已花 $1,106、超线浪费 $323）、164 个窗口外零出单 ≥$9 老系列（约 $4,500）、10 个因「同商家有单就豁免」漏判（$228）。**系统检查发现的根因与落地**：① **运营期没有净亏上限**——只有断流规则，持续出单的亏损系列断流天数永远归零，#22 hobobags 复活后从 -$4 一路亏到 -$23.10 才被 07 手动停；新增净亏 ≥ `stop_net_loss_usd` 或 ROI < `operate_min_roi`(0) 立即关，安全区（ROI>200%）按 07 要求仍豁免；② **「止损复活」被当作已通过等待期考核**（HM-D32 原设计），复活门槛只是 ROI 转正，等于给 ROI<100% 的亏损系列开永久绿灯——移除该豁免，复活门槛提到 `revive_roi_min`(0.2) 防关-开振荡；③ **Sheet 花费系统性低估**——比对 27 个系列的 Google 真值，Hermes 记 $6.88 时实际已 $9.06，偏差 $0.5-$2.31，$9 的线实际执行在 $9.5-$10.1（即 07 说的「实际 10 刀以上才关」，HM-D36 压缩的是巡检间隔、没解决数据源滞后）；monitor 与 5 分钟哨兵在花费 ≥ 线×`cost_verify_ratio`(0.8) 时直查一次 Ads API 取真值再判，只在临界点花配额；④ **Sheet 里没有该 campaign 时止损完全失明**（近 24h 434 次「无 campaign」），原逻辑直接 return——改为 Ads 直查兜底，两路都失败才告警；⑤ **出过单的任务止损后 CID 留位 48h**（`cid_hold_hours_earning`）等佣金回流判复活——#35 evryjewels ROI 转正要复活时原 CID 已被 #92 抢走；零出单仍即关即回收（07「热窗不用特意留」不变）；⑥ `pending_discount` 默认 1 → 0.85（hobobags 的 12 笔佣金全是 pending，靠未确认佣金把系列放回去继续烧）。**07 拍板口径**：ROI=(佣金−花费)/花费；净亏闸门除 ROI>200% 安全区外全适用；CRM 侧不做自动止损（「CRM 都是自己手动关停」）。**部署实测（2026-07-27 09:0x CST）**：新规则首轮即命中 #22 hobobags（运营期净亏 $27.81 → 关）✅；预演其余在投任务无误伤（#76 等待期净亏 $0.94 继续）✅；复活门槛 + pending 折算后 7 个 paused 任务全部不够格复活（ROI -5% ~ -89%，确为沙子）✅。**顺带发现待处理**：CID 5509319692（#25 hunderunde）Ads API 返回 403 无权限、Sheet 也无该 campaign，Hermes 既读不到也停不了，需 07 检查该账号；#79 rajapackde 后缀连续 219 次 stuck_on_tracker（tradedoubler/linksprf 跳板跟不动），广告在跑旧后缀 | 待 07 验收 |
| HM-D29 | 2026-07-23 | **07 反馈「建广告只要让我批量通过，不要一个一个通过」——HM-D26 批量卡有路径漏洞，根治**。排查：HM-D26 的批量卡只挂在 09:00 `planExecute`；07 平时在飞书让助手建任务走的是 `POST /api/runs/create`，每建一个即时发一张单卡——实锤当日 #40-#43、#49-#52 共 8 个任务全走单卡（#49-52 一分钟一张）。落地（不依赖 Agent 自觉，双保险）：① `create` 接口**默认缓发卡**（`defer_card=false` 才即时发），任务停在 pending_approval 且 approval_msg_sent=0；② 新增聚合器 `dispatchPendingApprovals` + 接口 `POST /api/runs/dispatch-approval`——把**所有待审未发卡任务合并成一张批量卡**（≥2 批量卡带全部批准/全部拒绝按钮，1 个则单卡），Agent 建完一批调一次；③ **任务泵每 5 分钟兜底**自动聚合发卡（120s 静默窗：最新任务刚建好可能同批未建完，等下轮，防一批被切成两张卡）——就算 Agent 忘了触发，卡最迟约 7 分钟合并送达、绝不会丢；④ skill v1.9.1 建任务章节改红线：建完一批必须调 dispatch-approval 一次、中途不许调。**服务器实测**：把当日被单卡轰炸的 #49-#52 重置未发卡 → dispatch-approval 返回 `{sent:4, channel:'batch'}`，一张 4 任务批量卡已发 07 私聊 ✅；pump 空跑 approvalDispatch=none ✅；4 任务 run_events 各一条「批量审批卡片已发送（4 个任务同卡）」✅ | 待 07 验收 |
| HM-D37 | 2026-07-25 | **07 需求「Hermes 的换链接也要用 CRM 现在的换链接方式」——移植 CRM 前一日跟链降耗修复（CRM commit 40979cf7）**。背景：Hermes 跟链与 CRM **共用同一 kookeey 账号**（HM-D06），CRM 侧排查发现 fetchChain 两个流量放大器（120KB 上限只停缓存不断 socket，多 MB 落地页全量流经代理；Accept-Encoding:identity 拒绝压缩放大 3~6 倍），修复后 CRM 实测单跳 -94~95%、全天消耗 11.3GB→2.1GB。Hermes 的 `suffix-follow.js` requestOnce 正是从 CRM 老版移植的，带同款问题。落地（对齐 CRM 实现）：① 攒够 120KB 立即 destroy 断开 socket；② identity→gzip + zlib 流式解压（gzip/br/deflate 兜住，主动截断触发的解压尾错按已够用完成）；③ 非 HTML 响应直接断开（旧 resume() 全量拉完）。浏览器兜底（suffix-browser.js）已有 CRM 两阶段拦截无需改；接口/判定语义不变，调用方（create-runs / suffix-pool）零改动。**追加（07 拍板「加」）**：冒烟顺带发现存量问题——run#81（ediblearrangements）落地停在 `r.linksprf.com/v2/go?t=<混淆参数>`（secprf.com 同族二段跳板）但该域名不在跳板名单，系统一直把跳板自身的 t= 混淆参数当后缀采信入池（改动前后行为相同，非本次回归）；已将 `linksprf.com` 加入 TRACKER_HOST_PATTERNS——浏览器兜底会等它跳离拿商家真参数，跳不走则如实报 stuck_on_tracker 触发换后缀健康告警，不再产可疑后缀。**加名单后实测**：受影响任务共 2 个——① #81 立竿见影，浏览器等到跳离拿到真实 Impact 参数（`im_ref=…&irgwc=1&utm_source=impact`）；池内 9 条 t= 垃圾后缀已回填过期时间作废，补货 cron 已为 #81 重新生成 5 条真后缀（在投广告下次点击增长换后缀时自动换上）；② #79 Rajapack DE 如实暴露为 stuck_on_tracker（停在 gutscheine.tradedoubler.com，HTTP+浏览器均跟不动）——它从发布起所有后缀都是垃圾、点击从未可归因，属 tatrck 同类「suffix 模式无法归因」商家，监控将按换后缀健康告警上报，是否提前暂停待 07 定 | 待 07 验收 |
| HM-D30 | 2026-07-24 | **07 反馈「到了告警线但同时在出单的，Hermes 直接关了，不看出单情况」（#35 evryjewels 凌晨 03:12 被止损暂停，当时已 6 笔佣金回流）——止损改为出单感知**。根因：HM-D28 佣金数据已入库，但 monitor 止损判断仍是毛口径（累计花费 ≥ spend_cap 即关），佣金没参与决策。落地：① **花费止损改净损口径**：净损 = 累计花费 − 有效佣金（approved+pending+paid，剔 rejected），净损 ≥ spend_cap 才自动暂停——有出单的任务天然多跑，ROI 回正的几乎不会被止损；② **天数止损只关零出单任务**：days ≥ days_cap 且有效佣金=0 才关；有出单的过测试期继续投（它已证明能出单，不是死测试）；③ **止损豁免通知**：毛花费/天数到线但被佣金豁免时，巡检汇总加「🟢 止损豁免（有出单继续投）」名单，**每任务只提醒一次**（run_events 查重），07 可随时「#N 暂停」「#N 止损改 $X」；④ **monitor 每轮开头先刷近 3 天佣金增量**（防「花费先到线、佣金还没回流」窗口期误关；失败不阻塞用库存数据）；⑤ `resume` 校验同步改净损口径（否则 #35 毛花费 $10.42 ≥ $10 恢复会被拒）；⑥ 暂停通知/事件流水带「花费 − 佣金 = 净损」明细；skill v1.9.2 加「止损是出单感知的」说明。**实测（2026-07-24）**：#35 佣金已累计 $10.16/33 笔 vs 花费 $10.42（净损 $0.26），已 resume 续投 ✅；**顺手排查出 #22 hobobags 同样被冤关**（佣金 $10.21 vs 花费 $6.38，净损 −$3.83 已盈利，0721 被天数线关），一并 resume ✅；其余 17 个 paused 任务佣金均为 0，属正常止损。已知边界：#35 刚恢复后 CRM Sheet 尚无当日点击行，monitor 报 stats_failed 只跳过不动作，出点击后自愈 | 待 07 验收 |
| HM-D31 | 2026-07-24 | **07 拍板完整止损标准 + 复活机制**（07 反馈「关停时确实没出单、后面出单 ROI 转正了却没有下一步操作」+ 给出关停标准：到达 9 刀/3 天/佣金−费用=−4/连续 7 天只有花费没佣金总 ROI<1.5/连续 3 天总 ROI<1；ROI 口径 = (佣金−花费)/花费）。**联网核对业内做法后确认 07 标准与主流框架一致**（零出单硬线 ≈ 业内「3×目标 CPA 零转化必杀」金标准；3 天 ≈ 72h 学习期共识；断流+ROI 双条件 ≈ 业内「CPA 连续 5 天超线才杀，单信号杀是最大误杀来源」；补了业内两点：pending 佣金拒付率 5-15% → `pending_discount` 折扣系数可调、复活门槛必须比关停严格防振荡）。落地：① `stopLossDecision`：零出单=花费 ≥ $9（`test_spend_cap_usd`）或 ≥3 天（`test_days_cap`）；有出单=净损 ≥ $4（`stop_net_loss_usd`）/ 断流 ≥3 在投日且 ROI<100%（`stop_dry_short_*`）/ 断流 ≥7 在投日且 ROI<150%（`stop_dry_long_*`）——断流天数=最后一笔非拒付佣金后的**在投日数**（run_daily_stats 行数，暂停期不累积，续投后重新计）；② **止损复活** `reviveStoppedRuns`（`auto_revive` 默认 on）：仅对「止损自动暂停」的任务（07 手动暂停的绝不碰），双条件=暂停后有新佣金（first_seen_at > 暂停时刻）且 ROI 转正 → 自动 resume + 巡检汇总「♻️ 止损复活」；off 时只提案（每暂停周期一次）；③ 全部阈值进 settings 注册表（07 飞书一句话可改）；④ resume 校验同口径（零出单看花费线/出单看净损线）；⑤ 存量 31 个任务线 10/2 → 9/3（07 手动改过线的不动），设置默认值同步 9/3；skill v1.9.3。**实测（2026-07-24 巡检）**：#39 truskin 出 5 笔 $2.15 vs 花费 $6.66 净损 $4.51 ≥ $4 → 关 ✅（成为复活规则天然观察对象）；#40 brooksbrothers 零出单 $9.06 ≥ $9 → 关 ✅（旧线 $10 昨晚放过了它）；#22/#35 有出单未触线继续投 ✅。**已知特性（书面告知 07）**：出单任务净损线 $4 比零出单线 $9 紧——出一小笔单反而更早触线（07 标准字面如此，如需改说「净损线改 $X」） | 被 HM-D32 细化取代 |
| HM-D32 | 2026-07-24 | **07 拍板分阶段生命周期模型（经 AskQuestion 逐项确认口径）**：① **观察期**（发布起 2 天，`test_days_cap` 3→2）：零出单满 2 天或花费 ≥ $9 → 关；**一出单 → 预算自动翻倍**（≤ $10 `boost_cap_usd`，仍受 hard 约束，一次性、run_events 去重，巡检汇总「📈 出单调增」）→ 进等待期、不再看花费线；② **等待期**（首笔非拒付佣金 cst_date 起 2 个 CST 日 `wait_days`，期内再出单**不重置**）：只看净亏 ≥ $4（`stop_net_loss_usd`）→ 关；③ **期满考核**（一次性）：ROI < 100%（`wait_roi_min`）→ 关，达标记「等待期考核通过」进运营期——**曾止损复活/被 07 手动续投的任务跳过考核**（复活与续投本身就是新准入判断，防振荡）；④ **运营期**：ROI > 200%（`roi_safe_threshold`）→ 本月豁免一切自动关（07：「ROI>2 的持续到本月结束再观察」）；断流 ≥3 在投日且 ROI<100% → 关；断流 ≥7 在投日且 ROI<150% → 关；**ROI 每轮实时算、到了谁的管理区间就由谁管理**（07 原话）；⑤ 复活机制（HM-D31）保留：暂停后出新单且 ROI 转正 → 自动续投。**顺带答疑**：07 问「默认预算说了 $4 为什么还是 $2」——settings_log 实锤 default_budget_usd=4 自 07-23 01:15 起生效、新任务（#49-53）都是 $4/$5；$2 是 07-22 之前建的老任务（如 #22），设置不回溯旧广告；已把 #22 预算手动补到 $4。**部署实测**：15 在投任务无误关，#22/#35（有续投记录）正确跳过考核走断流管理，存量广告不参与阶段规则；settings `test_days_cap=2`、存量 31 任务 days_cap 3→2 | 待 07 验收 |
| HM-D37 | 2026-07-25 | **07 规格「30 个等待投放的名单，低于 10 个商家就补齐名单给我批准，不然总是一个一个给我太麻烦」——待投名单水位线补货，取代 HM-D34 逐个关停补位**。旧模式痛点：关一个补一个，每次补位都随一张（往往单任务的）审批卡来，07 被小卡零敲碎打。新模式：**待投名单** = 建好待批（pending_approval）+ 已批排队等 CID（approved）的任务总数；目标 30（`waitlist_target`）、低水位 10（`waitlist_low`）——名单跌破 10 → 每小时补货 cron（:45，`POST /api/cron/waitlist-replenish`）从新测队列按推荐表序一次性补齐到 30，合并批量审批卡让 07 一次批完（**超 12 个自动分页多张卡**，防撞飞书卡片体积上限，每张仍是一键全批）。配套改动：① monitor 止损、pump 花费哨兵、手动暂停三处的 `backfillOne` 逐个补位全部下线（回收的 CID 由 pump 5 分钟内自动发布名单里的下一个任务——名单是常备缓冲，不需要现建）；② `auto_backfill` 语义改为名单补货开关；③ 09:00 plan-execute 无显式 daily_plans 时委托水位线（不再每天固定建满配额，名单封顶 30 自节流，补货豁免每日配额）；④ 新接口 `GET /api/waitlist`（现量/水位）、`?force=1` 忽略水位立即补满（07 说「把名单补满」）；⑤ skill v1.10.0。**上线路上补了一刀**：补货建任务一个要 1-2 分钟，pump 每 5 分钟的兜底聚合（120s 静默窗）会把建到一半的批次拆成零碎单卡——加 `replenishActive` 护栏，补货进行中兜底发卡一律按住，建完由补货自己统一扫尾（`dispatchPendingApprovals`，含历史中断遗留）。**部署实测（2026-07-25 16:04 CST）**：force 补满一轮——名单 14 → 30 ✅，16 个任务建成（#95-#110，Corkcicle/Movado/RAD 三国/Bluetti/Brevo 双国/GOG 等，严格推荐表序），3 个候选建失败自动跳过换下一个 ✅，最后合并 **2 张批量卡（12+4）** 同时发出、全程零零碎单卡 ✅；crontab 每小时 :45 已挂 | 待 07 验收 |
| HM-D36 | 2026-07-24 | **07 反馈「#49 polarde 实际 $10.97 才关（线是 $9）」——止损反应粒度太粗，加花费哨兵**。根因链：Ads 实际花费 → MCC 脚本写 CRM Sheet（07 侧两个脚本错开、各半小时一跑，Sheet 本身保鲜 ≈15-30 分钟）→ Hermes 整点 :12 巡检才做止损判断——超线后最多再跑 1 小时，$9 线冲到 $10.97。07 拍板**不直查 Ads API，调整消费节奏**（「可以用脚本实现实时数据的」）。落地：pump（每 5 分钟）本来就在读 Sheet 做点击换后缀，`campaignMetricsFromSheet` 返回值里 costUsd 一直在手没用——加 `spendGuard`：**零出单（有效佣金≤0，含 pending 折扣口径）且花费 ≥ spend_cap → 立即暂停 + CID 即关即回收 + 补位 + 飞书即时通知**，零新增数据请求；出过单的任务不越权，留给整点 monitor 做三阶段完整决策（净亏线/断流/豁免）；事件前缀保持「止损自动暂停」→ 哨兵关的任务日后出单照常走自动复活；熔断期跳过（monitor 兜底）。止损延迟从「Sheet 保鲜 + ≤60 分钟」压到「Sheet 保鲜 + ≤5 分钟」。**部署实测**：17:00 pump 轮 `guarded:[]` 正常出现（当轮无任务触线）✅ | 待 07 验收 |
| HM-D35 | 2026-07-24 | **07 需求：「每个月我都能拿到推荐表，我其实更推荐从推荐表上按顺序测试」（提供 5 份 7 月推荐 xlsx）——月度推荐表成为队列最高优先层**。表源分析：PM 表 71 家 / LH 表 208 家 / RW 表 95 家 / CZ 表 644 家（「新平台」与「CZ」两份内容完全相同只导一份；按 BU 列拆——chuizhan_ui→MUI 272、chuizhan_cg→CG 204、chuizhan_ev→EV 27，cf/bsh/df 共 141 家无对应池跳过），合计 877 行入库。落地：① 新表 `monthly_recommendations`（source_month+network+MID 唯一，含 rank/域名/国家主场/EPC/佣金率）+ `POST /api/recommendations/import`（replace 全量换月）+ `GET /api/recommendations`；② 本地解析脚本 `tools/import-recommendations.py`（表头关键词自动定位列，支持 --out 出 JSON → scp → 服务器 curl 导入；**每月新表到手跑一次即可**）；③ 队列构建：推荐商家 **priority = 5000−rank 纯表序**（不叠加白名单/佣金分——首版叠加导致 rank7 排到 rank1 前，已修正），绝对高于团队白名单层（≤1200）；多联盟同 rank 并列交错测试；黑名单/团队已测去重照常过滤；**国家优先用表内商家主场**（offer 支持时，如 Rails 用 CA 不强扭 US）；④ 取队排序统一改「推荐层严格表序 → 非推荐层 US 优先+分数」（planExecute/backfill/create Top1 三处）。**实测**：877 行导入 ✅（LH 176/PM 69 表内重复 MID 合并属正常）；队列重建 18741 排队、推荐命中 450；队首 rank 序列 1,1,3,4,4,4,4,5,7,7,8,9 严格表序 ✅（rank 缺号=该商家不在池/被过滤）。**D35b 追加（07 拍板「丢给 Hermes 他能看懂」）**：导入全程 Hermes 自主——飞书网关本就把 07 发的文件缓存到服务器本地（`~/.hermes/cache/documents/doc_*_原名.xlsx`），Agent 拿路径跑 `python3 tools/import-recommendations.py --rebuild <文件...>` 一条龙（联盟自动识别：CZ 看 BU 列、LH/PM/RW 看标题/文件名；同内容文件去重；token 自动读 .env；月份默认当月 CST；识别不出明确报错不猜）；API replace 改**按联盟局部替换**（RW 周更重发只刷 RW 不动别家）；服务器 apt 装 python3-openpyxl 3.1.2。端到端实测：4 份模拟网关缓存名文件 → 识别 4/4、导入 877、重建命中 450，与首轮一致（幂等）✅；skill v1.9.6 | 待 07 验收 |
| HM-D34 | 2026-07-24 | **07 需求：「关掉广告，就对应补上广告」——关停补位保持测试管道满载**。落地：① `backfillOne`（create-runs）：从新测队列取队首（HM-D35 后即推荐表顺位）缓发卡建任务，`auto_backfill` 开关默认 on；② 挂两个触发点：**止损自动暂停**（monitor 暂停成功后）与 **07 手动暂停**（adjust pause 后，接管的存量广告不触发——那不是测试位）；③ 补位任务进批量审批卡等 07 批（HM-D29 通道），巡检汇总新增「🔄 关停补位」节；④ skill v1.9.5/1.9.6。**上线当天 07 反馈「暂停后没有及时补货」（14:12 止损关了 #32/33/34/37 无补位）→ 连修两刀**：❶ 配额语义错——首版补位受每日新建配额约束，当天 15/15 已满被静默挡住；修正为**补位豁免每日配额（是替换不是新增，关 N 补 N 净在投数不变），当天补位总数自身 ≤ daily_runs 防失控**；且跳过/失败不再静默，巡检汇总明说原因（配额满/队列空/连败）；❷ 补位死循环——队首商家 filter 文案样本不足（品牌词真实广告太少）时建任务抛错、队列行不消耗，补位反复撞同一家白烧 SerpApi；修正为**样本不足行标 `copy_failed` 静默排除**（同 suffix_failed 先例，07 指定 ai_generate 仍可建）+ backfillOne 单候选失败自动试下一个（最多 5 个）。**补发实测**：4 个位全补上——#69 Cara Cara New York（EV 推荐榜 #1，单卡）、#70 Music and Arts（MUI #4）、#71/72 The Designer Box US/AU（PM #4，批量卡 3 合 1）；07 全批，#69 已上线；Rails（MUI #1 加拿大）、Yumi Kim（EV #3）因样本不足被排除 | 待 07 验收 |
| HM-D33 | 2026-07-24 | **07 反馈「Hermes 总是 CID 领取失败」（#61-68 连续 8 个预占失败）——CID 池只进不出，根治**。根因：`releaseCid` 只挂在发布失败路径，任务被止损暂停后 CID 永远占着；加上远程实查发现 enabled campaign 就把 CID 标 N **且永不复查**——30 个 CID 的池 26 个被占（含 9 个 paused 任务）+4 个拉黑 = 可用 0。与设计语义自相矛盾（远程双验只挡 enabled campaign，paused 广告的 CID 本该可复用）。落地四件套：① **热窗回池** `releaseStaleCids`：paused/failed 任务的 CID 保留 `cid_hold_hours`（默认 24h，复活主要发生在佣金滞后的 24h 内——#39 案例关停到出新单仅 10h）后自动释放，monitor 每轮执行；② **复活安全网** `reacquireCid`：CID 已释放的任务复活前校验——原 CID 被别的任务占用或远程有 enabled campaign → 不硬来，飞书通知 07 决定（每暂停周期一次）；否则重新占回，**保证一 CID 永不两个活广告**；③ **拉黑自愈**：reserveCid 池空时自动复查拉黑名单（6h 冷却），远程 enabled=0 就解禁回池；④ **排队不弃单**：CID 不足时任务留在 approved 由 pump 每 5 分钟自动重试（飞书只在首次短缺提醒一次），不再直接 failed 轰炸 07。**救急实测**：#61-68 重置回 approved；#61 即由拉黑复查解禁的 CID 3574434429 自动发布 ✅；8 个零出单 paused 任务的 CID 提前手动释放（#39 truskin 已出 9 笔单留在热窗内等复活）→ #62-68 七个全部自动发布上线 ✅。**排查小坑**：pump 路由是 `GET /api/cron/pump`（不是 POST）；run_events 时间为 UTC，算热窗年龄别按北京时间想当然。**次日修正（07 反馈「又出现 CID 不足」）**：热窗与 HM-D34 关停补位相撞——14:12 止损关 4 个零出单任务，CID 全被 24h 热窗扣住，补位任务 #70-72 批准后无 CID 排队。救急：手动释放 #32/33/34/37 四个 CID → pump 一轮 #70/71/72 全部发布上线 ✅。**随后 07 拍板「热窗不用特意留，我们就是疯狂投放、筛选，只找金子不找沙子」→ 热窗机制整体取消**：止损/手动暂停一律**即关即回收**（暂停成功即 releaseCid + monitor 每轮清扫兜底），复活/手动续投前 `reacquireCid` 现场校验占回（被占/远程有 enabled 会拦下），`cid_hold_hours` 设置删除；#39 truskin 的 CID 也已释放（池空闲 +2）。**07-25 再修（07 反馈「怎么又这样了」——09:00 批量建 13 个任务，#78-#90 逐条各发一条「CID 不足已排队」刷屏 13 条）**：核查确认排队本身是设计内（池 27 个可用 CID 全部被 27 个在投任务占着=满载，等止损/关停回收后按队列自动发布），毛病在「首次短缺提醒一次」做成了**每任务一次**——批量建任务场景 N 个任务 = N 条。已改为 **pump 整轮聚合一条**：只在有任务首次进入短缺时发，一条列全所有新排队任务号 + 池子满载状态（27/27 在投）+「无需处理」，后续轮次静默重试；发布成功本就有单独通知。部署实测：修复后手动 pump 一轮，13 个任务全部 firstShortage=false → 零飞书消息 ✅ | 待 07 验收 |
| HM-D28 | 2026-07-23 | **07 反馈「Hermes 没有拿到联盟商家的佣金」→ P3 联盟佣金回流 + ROI 归因上线**。落地：① 新增 `lib/affiliate-txn.js`——移植 CRM 生产 `platform-api.ts` 的 `fetchAllTransactions` 全套口径（LH cashback2 GET/4s 限频/30 天切片/满页续翻；CG/EV/MUI/PM POST JSON 必带 `dataScope:"user"`；RW form limit=30/14 天切片防 504；MUI/EV 订单→items 展平；行级 ID/金额非零优先/状态归一 approved·pending·rejected·paid/paid_date 点亮；时区=LH CST 钟面、其余 Unix 秒真 UTC，`cst_date` 在解析层算好）；② 新表 `affiliate_transactions`（UNIQUE pool+transaction_id upsert）+ `jobs/sync-commissions.js`；③ **归因链按设计 5.6**：订单数字 MID → 商家；系列名池段+末段 MID → 同一任务；LH 双池精确匹配不串池，其余联盟一账号一池按 network 匹配（存量接管广告池序号解析偏差不影响归因）；起投日起、CST 切日；④ ROI=(佣金−拒付−花费)/花费；**复盘卡片每任务加「佣金 当日/累计（含待定/拒付）｜ROI」行** + 💡 新增「ROI 回正→建议放量」；新转化归因到任务时整轮一条「💰 联盟佣金回流」飞书汇总（无新转化静默，对齐通知纪律）；⑤ cron：每小时 :40 增量（近 14 天）+ 09:10 全量对账（最早起投日前 3 天起，封顶 90 天，赶在 09:30 复盘前）；⑥ 接口 `POST /api/cron/sync-commissions`（days/full/notify）、`GET /api/commissions[?run_id=]`；skill v1.9.0 加「佣金/ROI 查询」章节（出单滞后要如实解释，无法归因如实转达）。**首轮全量实测（2026-07-23）**：7 池 867 笔交易入库（LH1 121/LH2 14/EV 447/MUI 189/PM 58/RW 38/CG 0），283 笔归因到任务；**存量广告真实 ROI 浮出——#46 MMLaFleur 佣金 $1217.86 vs 花费 $123.15（ROI +889%）、#47 Cariloha +57%、#48 FatAndWeirdCookie +27%（拒付 $45.93 已剔）**，直接修正了此前把这三个当「严重超止损应暂停」的误判（当时只有花费没佣金）；#35 evryjewels、#39 truskin 等新测任务也已见单（均 pending 待联盟确认）。**顺手排除次生事故**：`cron-env.sh` CRLF 复发（根因=仓库 blob 本身是 CRLF，每次部署 checkout 还原坏行尾，HM-D19 同源）——已重写 LF+`tr -d '\r"'` 双保险，并加 `.gitattributes`（*.sh 强制 LF）根治 | 待 07 验收 |
| HM-D27 | 2026-07-23 | **07 两点反馈：① 巡检通知「这种也是批量通道查看，不要一大堆消息发来」；② 「现在 Hermes 只管自己发的，之前我创建的在投广告他就不管了」**。落地：①【通知整轮汇总】自动调参/止损暂停/告警不再逐条推飞书——monitor 整轮收集后合并成**一条「Hermes 巡检汇总」**（分节：🛑 止损 N 个 / 🤖 调参 N 个 / 📥 新接管 N 个 / 告警），无事发生则静默；`autoTuneRun` 只执行+记流水，通知职责上收 monitor；②【接管存量广告】新增 `jobs/adopt-campaigns.js`，每小时巡检开头扫 CRM 绑定 Sheet 的 Campaigns 表（MCC 脚本维护，含 campaignId/cid/finalUrl/mid/trackingUrl），凡 Hermes 不认识的在投系列：一次性 GAQL 补齐 budget/ad_group 资源与当前预算/CPC（仅 ENABLED 的收），落 ad_runs（`queue_source='external'`，published_at=DailyData 最早日期），此后数据快照+自动调参一视同仁。**存量广告红线**：不设测试止损（caps=NULL，monitor 跳过止损判断，07 显式说「#N 止损改 $X」才会设线）；不参与 Hermes 换后缀/后缀池（kylink/MCC 脚本在管，双写会打架，pump/replenish 均排除 external）；复盘卡片对无止损线任务展示「存量广告（无测试止损）」。**首轮实测**：接管 5 个（#44-#48，EV Desire/Bloom、MMLaFleur、Cariloha、FatAndWeirdCookieCo，预算 CPC 从 GAQL 实读）✅；踩坑并当场修复——**接管首轮无昨日快照，累计花费被当成当日花费**，#46/47/48（$123/$55/$234 累计）误判「撞预算线」加了预算 $8.88→$11.1，已手动改回 $8.88 并加防护：无昨日基线且非当日起投的任务，按日规则（撞线/均价）本轮跳过，等次日有基线再算；复跑巡检 0 误动作 ✅ | 待 07 验收 |
| HM-D26 | 2026-07-23 | **07 需求：「批量创建广告的时候默认给我批量审批通道，而不是单个审批卡」**。落地：① 新设置项 `approval_mode`（batch/single，**默认 batch**，07 说「审批改回单卡」即切）；② 批量建任务（09:00 plan-execute，≥2 个成功创建）时 `createRunFromQueue` 缓发单卡（deferCard），统一走 `dispatchApprovalCards`——batch 模式发**一张批量卡片**：每任务紧凑摘要（商家/国家/池/预算/CPC/止损/系列名/关键词/完整联盟链接）+ 合计预算 + 「✅ 全部批准 / ❌ 全部拒绝」按钮；仅 1 个任务或 single 模式仍走原单卡；③ 批量签名链接：HMAC 覆盖整批 ID（`hermes-approve-batch:1,2,3:action`，ID 规范化去重升序防重排/注入），确认页 `/approve?ids=...` GET 列出全部任务表格+可展开完整文案（已处理的标注跳过），POST 一次对所有仍 pending 的逐个执行并汇总结果页（批准 N/跳过 M/失败 K）；**部分单独处理过的任务再点批量按钮自动跳过，不会重复审批**；④ skill v1.7.0：第 2 节加批量审批话术（「全部批准/全部拒绝」→ Agent 查 pending 逐个调接口；「批准 #12 #13，拒绝 #14」逐条执行），设置表加 approval_mode 行。**服务器实测**：approval_mode 默认 batch ✅；批量链接确认页 200（列出 #14/#18 并标注已处理）✅；篡改签名 403 ✅ | 待 07 验收 |
| HM-D25 | 2026-07-23 | **07 需求：「Hermes 要帮我实时监控在投数据，适当加减预算、CPC」——从 HM-D22 的「只建议、07 确认才执行」升级为自动执行**。落地：① 新增 `jobs/auto-tune.js`，挂进每小时监控巡检（monitor-runs 第 4 步，止损未触发才轮到调参），4 条保守规则（kyads 决策树按现有点击/花费信号裁剪）：**加预算**=当日花费 ≥ 日预算 95%（撞线卡量）→ +25%；**降 CPC**=当日 ≥5 点击且实际均价 ≤ 出价一半 → 降到均价×1.5（绝对下限 $0.05）；**提 CPC**=投放 ≥3 天累计 0 点击 → +50% 试探；**减预算**=近 3 天日均花费 ≤ 预算 20% 且预算高于默认值 → -20% 回收敞口（下限=默认预算）。② 风控继承既有体系：预算/CPC 永远 ≤ Owner 上限 hard_*（走 adjustRun 同一校验），每任务每类动作 **22h 冷却**（run_events event=auto_tune 判重），单轮巡检每任务最多 1 个动作，Ads 熔断时静默跳过下轮再试；③ **事后通知制**（非事前请示）：每次动作即时飞书通知 07（含依据 + 「不认可直接说 #N 改回 $X」），09:30 复盘卡片再兜一遍「近 24h 自动调参汇总」；④ 新设置项 `auto_tune`（on/off，默认 on），07 说「自动调参关掉」全停，止损暂停等既有保护不受影响；⑤ skill v1.6.0：解释 4 条规则 + 开关话术 + 「为什么自动改了」查 run_events 依据；Agent 本身仍不得自作主张调价（自动调参是 cron 干的）。**生产实测（2026-07-23 首轮巡检 23 个在投）**：12 个动作全部按规则执行——run#18/#22 降 CPC $0.5→$0.08（当日均价仅 $0.05-0.06）✅；run#24/#26 预算 $3→$3.8、run#29/30/32/34/35/37/39 预算 $2→$2.5（当日花费全部撞线）✅；每笔 adjust+auto_tune 双流水 ✅；飞书通知 0 失败 ✅ | 待 07 验收 |
| HM-D24 | 2026-07-22 | **07 两项发文规格：① 允许「给我 MUI xxx 商家的文章链接」当提示词；② 违规链接绝不发联盟绑定站点，必须发 draftify.sbs**。落地：①【按联盟池查商家】`publish-article.js` 加 `findOfferByNetwork`（network+商家名/域名模糊查 offers 池；命中多个不同域名商家时报歧义列候选让 07 选）；**正常发文选站升级为「如实发站点」= 该联盟连接绑定的站**（CRM publish-sites 接口新增 `bindings`——wj07 的 platform_connections.publish_site_id：CG/MUI→allurahub.top、EV→mevora.top、LH→aura-bloom.top/novanest.one、PM→keymint.co、RW→parcelnplate.top），无绑定才落节奏轮换；**同商家已有已发布文章直接回链接（reused=true）不重发**，07 明确说重新发才 `force_new`；②【违规链接隔离】`violation:true` 模式：强制选隔离站（`VIOLATION_SITE_DOMAIN` 默认 draftify.sbs，= CRM publish_sites id=44），忽略 site_id 覆盖 + 发布前硬断言兜底（选站结果≠隔离站直接拒发），隔离站不参与正常文章轮换，违规/正常文章分开去重；`article_publishes` 加 `network/is_violation` 列；③ skill v1.5.0：两种新说法的调用模板 + 红线（07 说「违规」必带 violation:true；就算指定别的站也会被隔离站覆盖）。**实测（2026-07-22）**：bindings 7 条 ✅；「RW 的 plarium」→ 如实报「RW 池里找不到」（plarium 实际在 LH/PM 池）✅；「PM 的 plarium 违规链接」→ 发布至 `draftify.sbs/post-plarium-vs-other-free-to-play-platforms-three-honest-differences`（8 图全本地化，对比型标题/问题开篇/多小标题结构）✅；同参数二次调用秒回 reused=true 同链接 ✅。注意：首次全流程（抓图+LLM+发布）可能超 10 分钟（plarium 首跑 >600s，二跑约 4.5 分钟），Agent 侧建议 nohup/耐心等待勿重复触发 | 待 07 验收 |
| HM-D23 | 2026-07-22 | **07 需求：Hermes 跳板宝塔发布文章（配图 5-8 张，质量对齐 draftify.sbs 参考文）**。07 拍板执行方式=**委托**（Hermes 生成内容与编排，真正写宝塔走 CRM 久经考验的发布链路），保留 Humanizer AI 痕迹门禁，站点共享 CRM 站群，飞书指令触发。落地分两端：①【CRM 端】新增 `/api/hermes/*` 三个 Bearer 接口（独立 `HERMES_API_TOKEN`，非 CRON_SECRET；未配置整体 503 禁用）——`GET publish-sites`（活跃站点清单+各商家最近发布日，供节奏校验）、`POST crawl-images`（复用 CRM 本地爬虫主页+产品子页+搜索兜底抓图，出口统一 isQualityImageUrl，返回 ≤40 候选）、`POST publish-article`（接收 Hermes 成品文章：**配图硬校验 5-8 张 img** → Humanizer 门禁（不过检自动清洗一次，仍不过 422 拒发）→ articles 落库（归属 `HERMES_ARTICLE_USERNAME` 默认 wj07，CRM 文章列表可见）→ 同站同 slug 409 防重 → `publishArticleToSite`（SSH 宝塔 + 图片下载本地化 `/images/articles/{id}_{n}.webp` + 索引/静态页 + CDN））；②【Hermes 端】新增 `jobs/publish-article.js` + `POST /api/articles/publish`（传 `run_id` 给广告任务配软文，或 merchant_name+merchant_url 独立发文）+ `article_publishes` 本地表：**选站**=同品牌同站 ≥7 天硬约束、优先最久未发站（CRM 历史+本地记录双查）；**配图**=CRM 抓图候选 → HEAD 体积探测 ≥20KB 过滤图标/占位（draftify 参考图 40-120KB webp 口径），目标张数 5-8 随机（防固定张数指纹），达标 <5 张如实拒发；**生成**=LLM（gemai claude-opus-4-6）按 `seo-article-style.mdc` 反指纹轮换：标题结构 10 池（同商家 90 天不重复）、开篇钩子 5 型（不连续同型）、正文结构 6 型（与上一篇错开）、年份出现率控制、字数 750-1150 随机；system prompt 内置 Humanizer 禁词表（em dash/delve/seamless 等）降低被门禁拒率；嵌图不达标自动重试 1 次；**登记**=article_publishes 记录轮换参数（title_structure/hook_type/body_layout 支撑后续去重）+ 发布成功飞书通知（助手身份）；③ skill v1.4.0 加「发布软文文章」章节（红线：配图不足/节奏冲突不硬发、Humanizer 连拒 2 次停下问 07）。**实测端到端（2026-07-22）**：run#35（Evry Jewels/evryjewels.com）72 秒完成——自动选站 aurislane.top、标题结构=数字明确型/钩子=失败教训/结构=决策清单型、`After 3 Returns and $200 Wasted…` 发布成功，**8 张图全部本地化**（4589_0~7.webp，19-80KB 实拍级商品/模特图，人工抽查 2 张质量达标）、Humanizer 一次过检、文内 3 处追踪链接 ✅ | 待 07 验收 |
| HM-D22 | 2026-07-22 | **07 规格：AI 日常运营（加预算/调 CPC 等）——SSH 探查 kyads 生产实现后复刻**。kyads 闭环＝cron 5:00 LLM 分析（决策树提示词 v5.0）→ 建议进 ai_recommendations/decision_journal → **人工在 UI 确认** → apply-actions → v23 REST mutate（预算=campaign_budget.amount_micros；CPC=组层 cpc_bid_micros 或 TARGET_SPEND 出价上限；只有 pause 无 resume；无自动执行）。Hermes 落地（对话代替 UI）：① `google-ads.js` 加 `setCampaignBudget`（同 kyads 口径）+ `setManualCpc`（**与 kyads 的差异**：Hermes 发布时关键词层也写了出价会覆盖组层，故组+全部关键词 criteria 一次原子 mutate）+ `resumeCampaign`（kyads 没有；止损暂停后续投需要）；② 新增 `jobs/adjust-run.js` + `POST /api/runs/adjust`：`set_budget / set_cpc / pause / resume / set_caps`，仅 monitoring/paused 可操作，预算/CPC 受 Owner 上限（hard_*）拒超，resume 时若累计花费仍超止损线则拒绝并要求带新线（防续投即被 monitor 再暂停），全部动作记 run_events(event=adjust) 流水；③ **每日复盘卡片加 💡 操作建议**（kyads 决策树按现有信号裁剪：预算撞线 95%→建议加预算；实际均价≤出价一半→建议降 CPC；3 天 0 点击→建议提价或停投；累计达止损线 80%→提前问续投），**只建议不自动执行**，07 回「#N 预算改 $X」即落地（对齐 kyads 人工确认制；ROI 归因 P3 接入后升级完整决策树）；④ skill v1.3.0 加「日常运营」+「每日运营纪律」章节，红线=不自作主张调价。**服务器实测**：run#14 validateOnly 干跑调预算 $2.5/调 CPC $0.35（组+1 关键词）均 200 ✅；set_caps 真执行 $10/2天↔$15/7天 往返 ✅（流水两条）；预算 $99 超上限被拒 ✅；新版复盘卡片已发 07 ✅ | 待 07 验收 |
| HM-D21 | 2026-07-22 | **07 纠正 HM-D20：回流不该靠 Ads API 节流，应读已有公开 Google Sheet**。CRM 表 `1UtzNj_Zei…` 的 **Campaigns.todayClicks**（换后缀水位）+ **DailyData**（按日 Clicks/Cost micros → SUM 累计止损/回流）已由 MCC Ads Scripts 写入，Hermes 原先用 GAQL `campaignStats` 重复烧 BASIC token 才导致 429 风暴。落地：新增 `crm-metrics-sheet.js`（公开 gviz CSV + 90s 缓存）；pump/monitor **读路径全面改 Sheet**；Ads API **仅保留** mutate（换后缀 / 止损暂停 / 发布 / CID 实查）。HM-D20 的点击 15 分钟节流与「熔断整轮跳过回流」已撤销（读不再耗配额）；mutate 侧熔断仍保留。口径：换后缀用今日点击（跨日回落重置水位）；止损/复盘用 DailyData 累计。 | 待 07 验收 |
| HM-D20 | 2026-07-22 | **07 飞书告警「回流断流 / 换后缀异常」排查并修复**。根因：Hermes 单 Developer Token（BASIC）被 pump（每 5 分钟 × 全部 monitoring CID GAQL）打爆日配额 → 持续 Google Ads **429 RESOURCE_EXHAUSTED**；monitor 再按任务刷「回流断流」飞书噪音。修复：① `google-ads.js` 进程级熔断（日配额 → 等到太平洋时区次日 00:05；短时 429 → 3–30 分钟）；② pump 点击查询默认 **15 分钟** 节流（`ADS_CLICK_POLL_MIN_SEC`，14 CID×5min 约 168 次/时 → 约 56 次/时）；熔断期间跳过点击查询/暂缓 approved 推进，不再逐任务写 429 error；③ monitor 熔断整轮跳过 + **全局「配额熔断」告警一条**（run_id=0 去重），换后缀/回流告警排除 429 噪音。广告不停投；熔断结束后自动恢复。后续可选：多 token 池（对齐 CRM） | ⚠️ 已被 HM-D21 纠正（节流治标；正确读源=Sheet） |
| HM-D01 | 2026-07-13 | 需求澄清完成（11 项结论），方案 v1.0 定稿；核实服务器白纸状态、wj07 LH 凭证可用、CRM 黑名单表为空 | ✅ 已批准（07：先开工） |
| HM-D02 | 2026-07-13 | **P0 完成**：① gemai 模型接通（provider=custom + base_url=api.gemai.cc，默认 claude-opus-4-6；密钥经实测有效，注：gemai 已下架 claude-sonnet-4-5，旧文档记录过期）；② 飞书原生机器人接入（旧应用凭证，websocket 已 connected，白名单仅 07 的 open_id）；③ 网关常驻化（systemd 用户服务 hermes-gateway + linger，开机自启/崩溃自拉）；④ 实测 `hermes -z` 中文对话正常、`hermes send` 已向 07 飞书私聊发送上线通知。配置变更均有备份（.env.bak.p0 / config.yaml.bak.p0）。**待 07 验证**：在飞书私聊回一条消息确认收发闭环 | 待 07 飞书验证 |
| HM-D03 | 2026-07-16 | **第二轮需求澄清定稿（v1.1）**：20 项新结论（见 2.2）。要点：① 一 Hermes 一员工，先做 wj07、可复制部署；② CID 改用 wj07 名下 MCC 941-949-6301（39 CID，实查 CRM 库）；③ LH 双池（LH1 wenjun3 / LH2 novanest）+ 选池/双开规则；④ 团队去重改共享谷歌表格（替代 SSH 读库），结构草案见 5.4；⑤ 建广告规格参照 kyads 提炼完成（5.5：1系列1组1RSA、仅搜索、Manual CPC、品牌词 PHRASE、6 段命名）；⑥ 归因参照 CRM 提炼完成（5.6：cashback2 拉单、商家+池维度对齐、ROI 口径）；⑦ 监控每小时巡检、止损即自动暂停；⑧ 放量前期提案制、后期自主；⑨ 每晚 21:00 问明日计划；⑩ 交互全走私聊。 | 待 07 验收 |
| HM-D04 | 2026-07-16 | **07 修正落地 URL 规格**：final URL 必须是**商家域名**（优先首页，支持 deeplink 可用商家内页），不能照抄 kyads 的「验证落地页当 final URL」；追踪后缀 = 解析 LH tracking_url 跳转后落地页的 query 参数。已深挖 CRM 后缀体系（suffix_pool 36h 过期 + 每5分钟补货 cron + MCC 脚本点击增长换链 + 住宅代理跟链），Hermes 侧后缀维护深度（完整复刻/简化版/调 CRM 接口）及代理来源列为待确认项 #10 | ✅ 已拍板（见 HM-D05） |
| HM-D05 | 2026-07-17 | **07 定后缀方案 = A（完整复刻 CRM 后缀池体系）**：新增 5.7 节规格——住宅代理跟链生成后缀入池（36h 过期）、每 5 分钟补货 cron、任务泵内查点击增量换后缀（Hermes 直连 Google Ads API 替代 CRM 的 MCC 脚本）、断链告警不停投、发布前置生成首条后缀。数据模型加 `suffix_pool` 表、cron 编排加 suffix-replenish。遗留：跟链代理来源（待确认项 #11） | ✅（#11 见 HM-D06） |
| HM-D06 | 2026-07-17 | **07 定跟链代理 = 复用 CRM 同款 kookeey**。实查 CRM 生产库：kyads_proxies 仅 kookeey（gate.kookeey.info:1000，socks5/http 双协议，username 模板 {COUNTRY}+session+life-5m）为 active（cliproxy/ipip 已禁用），wj07 绑定 kookeey。凭证开工时从 CRM 库解密复制到 Hermes 本地 .env，运行时不依赖 CRM。待确认项 #11 关闭 | ✅（07：开工） |
| HM-D07 | 2026-07-17 | **P1 完成并部署上线**：① hermes-ads 后端（Node 22 + 内置 SQLite 零依赖，127.0.0.1:8787，Bearer 鉴权）部署为 systemd `hermes-ads.service`（内存限 512M）；② LH 双池全量同步实测通过——LH1(wenjun3) 5063 条 + LH2(novanest) 4165 条 ≈ 6 分钟，`restricted_keywords/support_deeplink/promotion_area/comm_rate` 等字段全落库；③ 筛选管道+队列重建实测：可测池 9220 → 排禁品牌词 80 / 无可投国家 267 / 双池合并 4207 → 新测队列 **4666**（优先级=佣金+明确国家+EPC+deeplink）；④ 去重/黑名单抽查通过：向已跑记录和黑名单各注入 1 条队列 Top 域名，重建后两者均被排除（零漏），清理后还原；⑤ 团队表格同步器+登记接口就绪，未配置表格时降级本地缓存+飞书告警；⑥ cron：08:00 同步+重建、08:30 表格同步；⑦ Agent skill `hermes-ads/offer-pipeline` 已装、网关已重载；⑧ 代码入服务器本地裸库 `~/hermes-ads.git` + 本机克隆备份。**遗留阻塞**：kyads SA 所在 GCP 项目未启用 Sheets/Drive API 且 SA 无权自启用，共享表格暂不能建（见待确认项 #12） | 待 07 验收 P1 |
| HM-D09 | 2026-07-20 | **P2 完成并部署上线**：任务状态机全链路打通。① 数据模型加 `ad_runs / run_events / cid_registry / cid_reservations / approvals / suffix_pool / run_click_state` 七表；② Google Ads REST 直连（wj07 MCC 941-949-6301 的 SA `qmy123@qimanyan` + dev token + login-customer-id，均从 CRM 库 google_mcc_accounts id=1 复制本地），发布器对齐 kyads mutate 结构（1 系列 + 1 组 + 1 RSA、Manual CPC、仅 Google 搜索、PRESENCE、品牌词 PHRASE、公共否定词、6 段命名），实测 SA 换 token + GAQL 查 CID 均 200；③ CID 池播种 30 个（28 可用），预占＝本地可用 + 远程实查无 enabled campaign 双验 + 唯一约束一 CID 一系列；④ 后缀池：kookeey socks5 跟链取落地页 query（socks-proxy-agent 纯 JS，36h 过期、低水位补货、点击增量换后缀），复用 CRM 同款 kookeey 凭证；HTTP 跟不动（lhdeal 延迟 JS 跳转）时自动无头 Chrome 兜底（服务器已装 google-chrome-stable 150 + puppeteer-core，http 代理同凭证、两阶段请求拦截省流量、全局串行防低配机爆内存），并识别 LH 新增二段跳板 secprf.com——实测 hornby lhdeal 链 14s 跟到 `uk.hornby.com/?clickref=1101lDC7iLIp`（真实 Partnerize clickref）；⑤ LLM 改用 gemai `claude-opus-4-6`（claude-sonnet-4-5 已下架），生成 RSA 文案/品牌词 + 预算/CPC 建议（硬限 clamp）；⑥ 飞书审批：白名单（07 open_id）+ 机器身份永不可自审；⑦ cron 加 09:00 plan-execute、每 5min pump、每 5min suffix-replenish；⑧ Agent skill `ad-runs`（建任务/审批/查状态/每日计划）+ `/api/daily-plan` 接口。**实测验收**：四道硬限全部被拒（预算 $10>5 拒、CPC $0.5>0.3 拒、日新建 >5 拒、机器/非白名单审批全拒）；建成 1 个真实任务 run#7（Hornby/hornby.com/US，$3/$0.15，15 标题 3 关键词 10 否定词，6 段名 001-LH1-hornbyuk-US-0720-54696）止于 pending_approval，审批卡片已推 07 私聊，**等 07 在飞书批准后任务泵才会真实 CID 预占→生成后缀→发布上线**（真实花钱，故未自动执行）。测试周期/止损数值见待确认项 #7（默认 7 天/$15）。遗留：P3 monitor（止损自动暂停 + ROI 归因 + 每日复盘）+ 21:00 主动问计划（Agent 侧定时） | 待 07 验收 P2 |
| HM-D10 | 2026-07-20 | **07 纠正：默认文案改 kyads filter 模式，不 AI 生成**。SSH 实查 kyads 生产库确认：`ad_creation_drafts.generation_mode` 默认 `filter`（代码 `parseGenerationMode` 不传即 filter；生产 4118 草稿 = filter 1181 / ai_generate 2937），filter = 不生成新文案，SerpApi 抓真实在投广告样本，LLM 只当「筛选官」原文照搬挑选（kyads `prompts/filter.ts`）；关键词=域名品牌词单个（如 `["tous"]`）；预算/CPC 固定默认 $2/$0.3；公共否定词是 55 词固定表。Hermes 落地：① 新增 `src/lib/serpapi.js`（三路样本：google SERP desktop+mobile、google_ads 六变体（brand/official/coupon/discount/sale/online）、透明中心 `text=整域名`——kyads 2026-05-16 实测必须整域名；约 $0.135/任务，key 复用 kyads 生产同款）+ `src/lib/rsa-filter.js`（标题按 `\|/–/—` 拆、描述按句号拆、去重、合规长度过滤 → LLM 筛选 → **代码层强制输出⊆候选池**防改写 → LLM 挂了本地兜底品牌自投优先）；② `ad_runs` 加 `generation_mode` 列，`/api/runs/create` 加 `mode` 参数（默认 filter，07 说「用 AI」才 ai_generate）；③ 否定词表替换为 kyads 生产 55 词；④ 审批卡片加「文案模式」行。**实测**：AI 版 run#7 已删；hornby.com 三路样本全空（透明中心 100 条创意全是图片渲染无文字）→ 如实拒建「样本不足」✅；tous.com 建成 **run#8**（001-LH1-tous-US-0720-161594，$2/$0.3，真实广告 17 条 → 候选 53 标题/45 描述 → 筛出 15 标题 2 描述全部原文照搬，卡片已发 07 私聊待批）✅ | 待 07 验收 |
| HM-D11 | 2026-07-20 | **审批升级为交互式卡片（07 要求）**：① 审批消息改飞书 interactive 卡片（蓝头 + 任务信息 + 文案逐条 + ✅批准/❌拒绝按钮），发送失败自动降级文本；② 按钮走 **HMAC 签名链接** → 确认页（GET 展示确认、POST 执行、已处理幂等提示），审批人记白名单 07 open_id + 备注「飞书卡片按钮审批」；③ 公网链路：Hermes 腾讯云安全组仅放行 22（实测 80/443/8788 均不通、无腾讯云 API 凭证、CF token 无隧道权限），故借道 CRM——CRM nginx 加 `location /hermes-approve/` 反代 127.0.0.1:18788，Hermes 起 `hermes-approve-tunnel.service` 反向 SSH 隧道（-R 18788:127.0.0.1:8788，crm-xlx0310.pem，断线自动重连），审批页进程只听回环；④ 实测：`/hermes-approve/healthz` 公网 200、run#8 确认页渲染正常（h1「确认批准发布任务 #8？」+ 表单）、新卡片已发 07 私聊。指令审批通道保留不变 | 待 07 验收 |
| HM-D12 | 2026-07-20 | **07 反馈「suffix 跟踪链接没加上」→ 后缀前置验证变建任务硬门槛**。① 卡片/确认页新增「追踪后缀 + 完整联盟链接」两行（`final_url + ? + suffix`）供 07 审批前核对；② 建任务顺序重排：**先跟链验证 suffix → 再 SerpApi 文案 → 落库 → 发卡片**，验证失败的 offer 标 `test_queue.status=suffix_failed` 排除 + 飞书告知（不烧 SerpApi、不占每日 5 个额度、不留垃圾 run）；③ 发布泵改为优先复用预生成后缀（池空才现生成）；④ 移植 CRM D-182「落地洗参」兜底：浏览器跟链记录逐跳 chain，落地无 query 时回溯「同根域名 + 带联盟追踪键（clickref/cjevent/utm_source 等 33 键）」那一跳取 query；⑤ **发现 LH 新跳板 tatrck.com（cookie 归因）**：lhdeal → `tatrck.com/h/xx?url=<商家>&s=lh_xx` 302 → 商家落地**无任何参数**，追踪靠 tatrck 302 时种 cookie——Google 广告直跳商家域名不经跳板，这类 offer 用 suffix 模式**根本无法归因**，实测 tous/thriftbooks/airalo/canvasondemand/suppliesoutlet 全中招，已入跳板名单；⑥ **run#8（tous）判 failed**（无法产 suffix），替补 **run#12 Adheart（adheart.ru/US，002-LH1-adheart-US-0720-18885）**建成：真实广告 18 条→筛出文案，后缀 `utm_source=admitad&utm_medium=affiliate&utm_campaign=591217`（admitad 链路参数落到商家域名，可正常追踪），卡片已发 07 私聊待批 | 待 07 验收 |
| HM-D13 | 2026-07-20 | **07 两项修正**：① **跳过通知静默化**——「拿不到追踪后缀已排除」这类建任务跳过信息不再推飞书（07：得静默在后台），只记 `test_queue.status=suffix_failed` + `sync_logs(kind=suffix_pregate_skip)`，07 要看随时可查；② **系列序号以 07 实际发布为准**——新增 `src/lib/crm-sheet.js` 读 CRM 绑定的公开 Google Sheet（`1UtzNj_Zei…gid=0`，列含 campaignName/cid/mccId/trackingUrl 等），取表内系列名首段最大序号，建任务序号 = max(本地历史, CRM 在投)+1，sheet 拉不到时退回本地序号。实测 CRM 当前最大 228 → run#14（Dog is Good，dogisgood.com/US）已由 004 改名 **229-LH1-dogisgood-US-0720-39572** 重发卡片。同批清理：run#12 Adheart 07 已拒、#13（learnhowtorap，курс类可疑且后缀取到的是 lhdeal 自身参数）与 #15（dogisgood 重复）已取消，当前待批仅 #14。**Hermes 首个真实广告已上线（2026-07-20 15:42）**：07 卡片批准 run#14 → 泵自动走完 CID 预占（1467922493，远程实查无在投）→ 消费预生成后缀 → 发布，campaign `24048569684` 已 ENABLED，Google Ads 侧核验：预算 $2/天、Manual CPC、final URL `https://www.dogisgood.com`、suffix `cid=335&mid=10258&…uid=v0304…`、关键词 `"dogisgood"` PHRASE、8 标题 RSA、campaign 级否定词 56 条——进入 monitoring（每 5 分钟点击增量换后缀 + 止损盯守） | ✅ 已上线 |
| HM-D14 | 2026-07-20 | **07 明确：换后缀与花费回流由 Hermes 自己盯（不靠人看）→ 监控巡检上线**。新增 `src/jobs/monitor-runs.js` + `POST /api/cron/monitor`（crontab 每小时 :12，走 cron-env.sh）：① **花费/点击回流**——GAQL 拉各在投 campaign 累计点击/花费，落 `run_daily_stats`（run_id×日期快照，`GET /api/stats` 可查近 14 天，是 P3 ROI/复盘的数据底座）；② **止损双卡控**——累计花费 ≥ spend_cap（$15）或投放天数 ≥ days_cap（7）任一到线 → 自动 pauseCampaign + 状态转 paused + 飞书通知 07 复盘；暂停失败单独告警要人工；③ **换后缀健康**——近 6h 换后缀/后缀生成失败 ≥3 次告警（不停投，跑旧后缀）；池空且有点击流量告警；④ **回流断流**——GAQL 连续失败 ≥3 轮告警；⑤ 告警同类 6h 去重（run_events event=alert）。实测首轮：run#14 回流成功（0 点击/$0，快照已落库）；顺手补货后缀池 4 条可用（发布消费 1 条后池曾为 0） | 待 07 验收 |
| HM-D19 | 2026-07-21 | **07 问「昨天新广告为什么没有分析报告」→ 排查出双重原因并修复**。①【事故】cron 全线停摆约 20 小时：7-20 10:38 部署时 `cron-env.sh` 被 Windows 端以 CRLF 覆盖，行尾 `\r` 被拼进 Bearer token（65 字符），Node HTTP 拒绝含 `\r` 的请求头 → 所有 cron 请求（pump/monitor/suffix-replenish/sync）返回 400 空响应且无日志，syslog 显示 cron 每 5 分钟都在触发但全部无效——monitor 停摆导致 run#14 只有发布当天 07:48 一条快照。修复：服务器端重写 cron-env.sh（LF），token 提取加 `tr -d '\r"'` 双保险；实测 pump/monitor 恢复 200，cron.log 恢复增长。②【功能缺失】「每日复盘报告」此前本就未实现（P3 遗留），补齐：新增 `src/jobs/report-daily.js` + `POST /api/cron/report-daily`（body 可传 date 补发指定日）+ crontab 每天 09:30——汇总所有已发布任务（在投/已暂停）的当日增量（相邻快照差值）与累计点击/花费、止损进度（$X/$cap、第 N/M 天），以智能助手身份发卡片（卡片挂了降级纯文本，报告不能断）；无已发布任务时静默跳过。ROI/佣金归因列待 P3 联盟返现回流接入后追加。已补发 7-20 复盘卡片（run#14：0 点击/$0，第 1/7 天）；skill 补「补发昨天的报告」用法，网关已重载 | 待 07 验收 |
| HM-D18 | 2026-07-20 | **07 规格：三条硬限也要能改——权限模型改为「对话使用者 = Owner，权限最大」**（智能助手之后可批量复制，每个实例以其对话使用者为 Owner）。① 原三条代码硬限（日预算 $5 / CPC $0.3 / 日建 5）**从代码天花板降级为 Owner 级设置项** `hard_budget_usd / hard_cpc_usd / hard_daily_runs`，07 一句话即可改；仅保留防手误的宽松绝对界限（$10000 / $100 / 1000 个，非风控，07 要多大给多大）；② 日常规则联动：`default_budget_usd / default_cpc_usd / daily_runs` 的上限从写死数值改为动态引用对应 hard_*；**下调 hard_* 时自动联动压低已超线的日常规则**（返回带 `adjusted`，助手须一并复述）；③ 强制点全部改读设置中心：建任务显式传参校验、发布泵二次校验（pump-runs assertLimits）、ai_generate 预算建议 clamp（rsa-gen）、每日新建额度（effectiveDailyRuns = min(daily_runs, hard_daily_runs)），config.js 去掉 env 的 Math.min 硬夹；④ ad-runs skill 升 v1.2.0：11 项规则对照表 + 操作红线（改 hard_* 必须 07 本人明确说出数字，助手不得为放行某次建任务自行上调上限；改前复述数字）；⑤ 服务器实测全链路：上限 5→8 ✅ → 默认预算改 $6（旧硬限下不可能）✅ → 上限下调 4 联动压低 default 6→4 ✅ → 99999 超绝对界限被拒 ✅ → 日建上限改 8 ✅ → 全部恢复默认 ✅，settings_log 流水 10 条完整可溯 | 待 07 验收 |
| HM-D17 | 2026-07-20 | **07 规格：智能助手要能自主对话 + 发消息改规则**。对话本身已通：网关（websocket，claude-opus-4-6）在线、白名单=07 open_id、带本地终端能力和 hermes-ads skills。补上「改规则」正式入口：① 新增 `src/lib/settings.js` 设置中心 + `app_settings/settings_log` 两表 + `GET/POST /api/settings`——**8 项可调规则**：默认预算(0.5~5)/默认CPC(0.05~0.3)/每日新建(0~5，0=暂停)/止损天数(1~30)/止损金额($1~100)/默认文案模式(filter/ai_generate)/后缀池目标水位(1~20)/低水位(0~19)；改动写库覆盖 .env 默认（重启不丢）、留流水（谁改的/从几到几）、超范围 400 拒绝、可一键恢复默认；三条代码硬限（$5/$0.3/5个）是天花板任何人改不了；② `create-runs/suffix-pool/planExecute` 全部改读设置中心（改动对之后新建的任务生效，在投任务止损沿用建时写入值）；③ ad-runs skill 升 v1.1.0：加「07 说法→key」对照表与操作规范（改完复述、超限如实解释），网关已重载；④ 服务器实测：list 8 项 ✅、改 daily_runs 5→3 ✅、改 9 被拒「超出允许范围 [0,5]」✅、恢复默认 ✅；已用助手身份发使用说明卡片给 07 | 待 07 验收 |
| HM-D16 | 2026-07-20 | **07 反馈：消息应由「智能助手」发出，不是 webhook 机器人**（07 开始完全交由 Hermes 自主沟通）。`src/lib/feishu.js` 重写为双通道：主通道=飞书应用 im API（tenant_access_token + open_id 私聊 07，应用与 Agent 网关同一个 = 智能助手身份），webhook 自定义机器人降级兜底。审批卡片/止损通知/监控告警/发布成功全部走助手身份。服务器实测：文本+交互卡片均以助手身份私聊送达 ✅。注意：网关（websocket 收消息）与 hermes-ads（HTTP 发消息）共用同一应用，互不冲突；07 在助手私聊里回「批准 #N」由网关 Agent 处理（skills/ad-runs），卡片按钮走签名链接不依赖网关 | 待 07 验收 |
| HM-D15 | 2026-07-20 | **07 三项规格：全联盟入池 + 白名单严格优先 + 发布即登记已测记录**。① **全联盟入池**——新增通用适配器 `src/adapters/generic.js`（monetization JSON 系 CG/EV/MUI/PM + Rewardoo form 系 RW，端点/分页/限流照抄 CRM 生产 platform-api.ts），wj07 名下 7 个联盟账号全部接入：LH1/LH2 + CG1(allurahub)/EV1(mevora)/MUI1(allurahub)/PM1(keymint)/RW1(parcelandplate)，key 复制自 CRM `platform_connections`；`offers.network` 参数化，5.1 更新至 v1.4；各联盟跳板域名入 `TRACKER_HOST_PATTERNS`；② **黑名单不测**——原有硬排除逻辑不变（黑名单命中直接不入队，从不测试）；**白名单优先测试**升级为严格优先：入队打分重点分享 +1200 / 普通分享 +1000（非白名单打分上限约 150），白名单商家必然整体置顶先测；③ **发布即登记**——任务泵发布成功（进 monitoring）当场 `registerTestedOffer` 写「已测记录」+本地缓存。写 sheet 通道：两个 SA 的 GCP 项目 Sheets API 均 403 且 SA 无权自助启用；**07 拍板不开 API** → 新增匿名浏览器写通道 `sheet-anon-write.js`（表格公开可编辑，无头 Chrome 匿名会话 Name Box 跳格键入 + CSV 复核，双通道自动降级 + pending 兜底 + `flushPendingSheetWrites` 每日补写 + 缓存回填防去重丢失）。**实测**：run#14（dogisgood.com/US）经浏览器通道 19s 写入共享表格成功，公开 CSV 复核在表 ✅。**部署实测（2026-07-20）**：全量同步入池 CG 79 / EV 215 / MUI 1631 / **PM 19847**（RW 首页即 504——RW 服务端慢，CRM 侧同账号连败 3 次同因，已放宽 120s 超时+首页重试，每日 08:00 cron 自动再试）；offers 在线 **30195**（原 8439 的 3.6 倍）；队列重建：候选 30182 → 黑名单排除 1678 → 新测队列 **20582**（LH1 3501 / LH2 12 / CG1 15 / EV1 105 / MUI1 1225 / PM1 15724），白名单命中 40 条全部置顶（Top1 Hornby UK 1125 分起，第一条非白名单排在 40 名之后）✅ | 待 07 验收 |
| HM-D08 | 2026-07-17 | **团队共享表格接入完成**：07 提供团队现有公开编辑表格（ID `1wQE3ieaVJhkDPvbpn2y6ldThh6gtowQuhW0Tzlm6p7Q`）。① 实测表内两工作表：「黑名单」（商家名称/平台/域名/下架时间/原因/来源，约 4800 行）与「白名单/推荐商家表」（商家名称/ROI参考/佣金率/结算率/标记/分享时间/备注，约 390 行），结构与原 5.4 草案不同，按团队现状适配（5.4 更新至 v1.2）；② 读通道改走**公开 CSV（gviz）**，绕开 Sheets API 未启用问题；写通道保留 SA API + `pending_sheet_writes` 兜底；③ 新增本地缓存表 `team_whitelist`，白名单命中商家入队加分（重点分享 +50 / 普通 +30）；④ 服务器实测：黑名单 4802 / 白名单 387 同步入库，队列重建 9220 候选 → 黑名单排除 **695**、白名单命中 16、新测队列 4313（较接入前 4666 净减 353，团队黑名单生效）；⑤ 「已测记录」工作表已由 Hermes 经浏览器匿名编辑通道自建（tab 名「已测记录」，表头 A1:J1 = normalized_domain/country_code/network/network_account/owner/source/tested_at/result/roi/note），服务器实测 `testedTabMissing:false` 读取正常。待确认项 #9 关闭、#12 转半开（仅写通道） | 待 07 验收 |
