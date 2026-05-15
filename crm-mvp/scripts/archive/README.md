# 爬虫历史排障脚本归档

本目录存放历史上对单个商家做爬虫问题排障时一次性写的脚本，按商家域名命名。

清洗 buildCrawlCache 主流程（2026-05-15）后这些脚本基本失效——SPA hydration、ccTLD 跳过、代理出口校验、HTML 切片、`removeTagBlocks` fallback 等核心 bug 均已修复。保留作历史参考。

## 当前推荐的诊断入口

- `../_diag_camplify.ts` — 标准诊断脚本：跑 `buildCrawlCache(<url>, <country>)` 看 pageText / quality / 耗时
- `../_diag_camplify_raw.ts` — 直接调 `crawlWithPuppeteerFull` 看原始 HTML / body innerText / 自定义 htmlToText 结果

用法：

```bash
cd ~/Google-Data-Analysis/crm-mvp
set -a && source .env && set +a
npx tsx scripts/_diag_camplify.ts
```

## 归档内容

- `_diag_aerosus*.sh` — Aerosus 商家排障
- `_diag_eliandelm*.py` — eliandelm 商家
- `_diag_flexpro*.py` — Flexpro 商家
- `_diag_novanest*.py` — Novanest 商家
- `_debug_scarosso.sh` / `_test_scarosso_live.sh` — Scarosso 商家
- `_test_dzzi*.mjs` — dzzi 商家
- `_test_puppeteer*.js` — Puppeteer 原始测试
- `_diag_pipeline.ts` — camplify.es 早期诊断（已被 `_diag_camplify.ts` 替代）
