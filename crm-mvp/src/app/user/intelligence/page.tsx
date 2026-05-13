"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import {
  Card, Input, Button, Select, Space, Table, Tag, Typography,
  Collapse, Empty, Alert, App, Tooltip, Switch, InputNumber, Badge,
} from "antd";
import {
  SearchOutlined, EyeOutlined, LinkOutlined, SettingOutlined,
  FireOutlined, LoadingOutlined, StarOutlined, StarFilled,
} from "@ant-design/icons";
import { useRouter, useSearchParams } from "next/navigation";

const { Title, Text } = Typography;

interface AtcAd {
  format: string;
  title?: string;
  domain?: string;
  first_shown?: number;  // Unix 秒级时间戳
  last_shown?: number;   // Unix 秒级时间戳
  thumbnail?: string;
  /** SerpApi 返回的 ad_creative_id，用于构造 ATC creative 详情页跳转链接 */
  creative_id?: string;
  /** C-088：domain 缺失但 OCR 已入队，前端显示"识别中..." */
  _ocrPending?: boolean;
}

interface AdvertiserGroup {
  id: string;
  name: string;
  adCount: number;
  ads: AtcAd[];
}

const REGIONS = [
  { value: "US", label: "美国 (US)" },
  { value: "GB", label: "英国 (GB)" },
  { value: "AU", label: "澳大利亚 (AU)" },
  { value: "CA", label: "加拿大 (CA)" },
  { value: "DE", label: "德国 (DE)" },
  { value: "FR", label: "法国 (FR)" },
  { value: "IT", label: "意大利 (IT)" },
  { value: "ES", label: "西班牙 (ES)" },
  { value: "NL", label: "荷兰 (NL)" },
  { value: "SE", label: "瑞典 (SE)" },
  { value: "NO", label: "挪威 (NO)" },
  { value: "DK", label: "丹麦 (DK)" },
  { value: "JP", label: "日本 (JP)" },
  { value: "KR", label: "韩国 (KR)" },
  { value: "SG", label: "新加坡 (SG)" },
];

/** 将 Unix 秒时间戳格式化为 YYYY-MM-DD */
function fmtTs(ts?: number): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** 计算广告持续天数 */
function adDays(ad: AtcAd): number | null {
  if (!ad.first_shown || !ad.last_shown) return null;
  return Math.round((ad.last_shown - ad.first_shown) / 86400);
}

/** 判断广告是否满足"持续投放 N 天"条件（按总时长计算，不要求当前仍在投）*/
function isPersistent(ad: AtcAd, minDays: number): boolean {
  if (!ad.first_shown || !ad.last_shown) return false;
  const daysRan = (ad.last_shown - ad.first_shown) / 86400;
  return daysRan >= minDays;
}

export default function IntelligencePage() {
  const { message } = App.useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchText, setSearchText]   = useState("");
  const [region, setRegion]           = useState("US");
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState<{ advertisers: AdvertiserGroup[]; total: number } | null>(null);
  const [noKey, setNoKey]             = useState(false);
  const [persistOnly, setPersistOnly] = useState(true);
  const [minDays, setMinDays]         = useState(15);
  const [localHits, setLocalHits]     = useState<{ id: string; name: string; domains: string[] }[]>([]);
  // C-089：已关注的 advertiser_id（按 region 区分），值是 watchlist 行 id 用于 DELETE
  const [watchedMap, setWatchedMap]   = useState<Map<string, string>>(new Map());
  const [watchToggling, setWatchToggling] = useState<Set<string>>(new Set());

  // C-089：watchedMap 的 key 用 `${advertiserId}#${region}` 形式
  const watchKey = (advId: string, rgn: string) => `${advId}#${rgn}`;

  // C-089：拉取当前用户全部 watchlist，填到 watchedMap
  const loadWatchlist = async () => {
    try {
      const res = await fetch("/api/user/atc/watchlist").then((r) => r.json());
      if (res.code === 0 && Array.isArray(res.data)) {
        const m = new Map<string, string>();
        for (const w of res.data as Array<{ id: string; advertiser_id: string; region: string }>) {
          m.set(watchKey(w.advertiser_id, w.region), w.id);
        }
        setWatchedMap(m);
      }
    } catch { /* 静默：不影响搜索主流程 */ }
  };

  // C-089：切换关注状态
  const toggleWatch = async (advId: string, advName: string, rgn: string) => {
    const key = watchKey(advId, rgn);
    if (watchToggling.has(key)) return;
    setWatchToggling((prev) => new Set(prev).add(key));
    try {
      const existingId = watchedMap.get(key);
      if (existingId) {
        const res = await fetch(`/api/user/atc/watchlist/${existingId}`, { method: "DELETE" }).then(r => r.json());
        if (res.code === 0) {
          setWatchedMap((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
          message.success(`已取消关注 ${advName || advId}`);
        } else {
          message.error(res.message || "取消关注失败");
        }
      } else {
        const res = await fetch("/api/user/atc/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            advertiser_id: advId,
            advertiser_name: advName || undefined,
            region: rgn,
            // v2：min_days 不再从前端 state 取（页面 minDays 是"显示筛选"用），让后端用 default=30
          }),
        }).then(r => r.json());
        if (res.code === 0) {
          setWatchedMap((prev) => {
            const next = new Map(prev);
            next.set(key, String(res.data.id));
            return next;
          });
          message.success(`已关注 ${advName || advId}，每天 8:00 推送『30 天+ 且昨日还活跃』的广告`);
        } else {
          message.error(res.message || "关注失败");
        }
      }
    } catch {
      message.error("网络错误，请稍后重试");
    } finally {
      setWatchToggling((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const doSearch = async (qs: string, nameForLocal?: string) => {
    setLoading(true); setNoKey(false); setLocalHits([]);
    try {
      const res = await fetch(`/api/user/atc/intelligence?${qs}`).then((r) => r.json());
      if (res.code === 0) {
        setResult(res.data);
        // 0 结果时自动在本地快照中搜同名广告主（AR ID）
        if (res.data.total === 0 && nameForLocal) {
          const lr = await fetch(`/api/user/atc/find-advertiser?name=${encodeURIComponent(nameForLocal)}`).then(r => r.json());
          const hits = lr.code === 0 ? (lr.data ?? []) : [];
          // 只有唯一匹配时自动触发精确查询，省去手动点击
          if (hits.length === 1) {
            setSearchText(hits[0].name || hits[0].id);
            doSearch(new URLSearchParams({ advertiser_id: hits[0].id, region }).toString());
            return;
          }
          setLocalHits(hits);
        }
      } else if (res.message?.includes("SerpApi Key")) setNoKey(true);
      else message.error(res.message ?? "查询失败");
    } catch { message.error("网络错误，请稍后重试"); }
    finally { setLoading(false); }
  };

  // 从 URL 参数自动触发搜索（从商家广告主列表点「查情报」跳转）
  useEffect(() => {
    const arId = searchParams.get("advertiser_id") ?? "";
    const name = searchParams.get("name") ?? "";
    const rgn  = (searchParams.get("region") ?? "US").toUpperCase();
    if (arId) {
      setSearchText(name || arId);
      setRegion(rgn);
      doSearch(new URLSearchParams({ advertiser_id: arId, region: rgn }).toString());
    }
    // C-089：初次进页面就拉一次 watchlist，决定关注按钮状态
    loadWatchlist();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // C-088：OCR 轮询 — result 变化时启动；命中 success/failed 后局部更新 state；60s 总超时
  const ocrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ocrStartRef = useRef<number>(0);
  useEffect(() => {
    if (ocrTimerRef.current) {
      clearInterval(ocrTimerRef.current);
      ocrTimerRef.current = null;
    }
    if (!result) return;

    const pendingUrls = new Set<string>();
    for (const adv of result.advertisers) {
      for (const ad of adv.ads) {
        if (ad._ocrPending && ad.thumbnail) pendingUrls.add(ad.thumbnail);
      }
    }
    if (pendingUrls.size === 0) return;

    ocrStartRef.current = Date.now();
    const tick = async () => {
      try {
        const urls = Array.from(pendingUrls);
        // C-088 修复 v2：超时从 60s 调到 5 分钟（300s）—— 配合 cron 5 分钟周期 + inline worker 触发
        if (urls.length === 0 || Date.now() - ocrStartRef.current > 300_000) {
          if (ocrTimerRef.current) {
            clearInterval(ocrTimerRef.current);
            ocrTimerRef.current = null;
          }
          return;
        }
        const resp = await fetch("/api/user/intelligence/ocr-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls }),
        }).then((r) => r.json());
        if (resp.code !== 0 || !resp.data) return;

        setResult((prev) => {
          if (!prev) return prev;
          let changed = false;
          const next = {
            ...prev,
            advertisers: prev.advertisers.map((adv) => ({
              ...adv,
              ads: adv.ads.map((ad) => {
                if (!ad._ocrPending || !ad.thumbnail) return ad;
                const hit = resp.data[ad.thumbnail];
                if (!hit) return ad;
                if (hit.status === "success" && hit.domain) {
                  changed = true;
                  pendingUrls.delete(ad.thumbnail);
                  return { ...ad, domain: hit.domain, _ocrPending: false };
                }
                if (hit.status === "failed" || hit.status === "permanent_failure") {
                  changed = true;
                  pendingUrls.delete(ad.thumbnail);
                  return { ...ad, _ocrPending: false };
                }
                return ad;
              }),
            })),
          };
          return changed ? next : prev;
        });
      } catch {
        /* 轮询失败静默重试，不打扰用户 */
      }
    };

    void tick();
    ocrTimerRef.current = setInterval(tick, 5_000);
    return () => {
      if (ocrTimerRef.current) {
        clearInterval(ocrTimerRef.current);
        ocrTimerRef.current = null;
      }
    };
  }, [result]);

  const handleSearch = async () => {
    const text = searchText.trim();
    if (!text) { message.warning("请输入广告主名称或域名"); return; }
    const isArId = /^AR\d+$/i.test(text);
    const qs = isArId
      ? new URLSearchParams({ advertiser_id: text, region }).toString()
      : new URLSearchParams({ text, region }).toString();
    doSearch(qs, isArId ? undefined : text);
  };

  const doSearchByArId = (arId: string, name: string) => {
    setSearchText(name || arId);
    doSearch(new URLSearchParams({ advertiser_id: arId, region }).toString());
  };

  // 应用持续投放过滤
  const filteredAdvertisers = useMemo(() => {
    if (!result) return [];
    return result.advertisers.map((adv) => {
      const filteredAds = persistOnly
        ? adv.ads.filter((ad) => isPersistent(ad, minDays))
        : adv.ads;
      return { ...adv, ads: filteredAds, filteredCount: filteredAds.length };
    }).filter((adv) => !persistOnly || adv.filteredCount > 0);
  }, [result, persistOnly, minDays]);

  const totalFiltered = useMemo(
    () => filteredAdvertisers.reduce((s, a) => s + a.filteredCount, 0),
    [filteredAdvertisers]
  );

  // 为每个广告主 Table 单独构造 columns，让"投放域名"列能拿到当前 advId + region
  // 用于跳转到 Google ATC 的「该广告主 × 该域名」筛选页（而非商家官网）
  const makeAdColumns = (advId: string, currentRegion: string) => [
    {
      title: "持续天数",
      key: "days",
      width: 90,
      sorter: (a: AtcAd, b: AtcAd) => (adDays(a) ?? 0) - (adDays(b) ?? 0),
      defaultSortOrder: "descend" as const,
      render: (_: unknown, rec: AtcAd) => {
        const d = adDays(rec);
        if (d === null) return <span style={{ color: "#bfbfbf" }}>-</span>;
        const color = d >= 30 ? "#f5222d" : d >= 15 ? "#fa8c16" : "#52c41a";
        return (
          <Space size={2}>
            {d >= 15 && <FireOutlined style={{ color: "#fa8c16", fontSize: 12 }} />}
            <span style={{ color, fontWeight: 600 }}>{d}天</span>
          </Space>
        );
      },
    },
    { title: "格式", dataIndex: "format", width: 70, render: (v: string) => <Tag style={{ fontSize: 11 }}>{v || "text"}</Tag> },
    {
      title: "广告内容",
      key: "content",
      render: (_: unknown, rec: AtcAd) =>
        rec.thumbnail
          ? <img src={rec.thumbnail} alt="" style={{ maxWidth: 100, maxHeight: 50, objectFit: "contain" }} />
          : <Text type="secondary" style={{ fontSize: 12 }}>{rec.title || "-"}</Text>,
    },
    {
      title: "投放域名",
      dataIndex: "domain",
      width: 180,
      render: (v: string | undefined, rec: AtcAd) => {
        if (v) {
          // 点击跳 Google 广告透明度中心：
          //   - 有 creative_id：定位到该广告创意详情页 /advertiser/{AR}/creative/{CR}?region=
          //   - 无 creative_id（罕见降级）：跳广告主主页 /advertiser/{AR}?region=
          //   - 广告主非 AR 开头（极少数本地降级数据）：跳商家官网
          let atcUrl: string;
          let tooltipTitle: string;
          if (advId.startsWith("AR") && rec.creative_id) {
            atcUrl = `https://adstransparency.google.com/advertiser/${advId}/creative/${rec.creative_id}?region=${currentRegion}`;
            tooltipTitle = `在 Google 广告透明度中心查看该广告详情`;
          } else if (advId.startsWith("AR")) {
            atcUrl = `https://adstransparency.google.com/advertiser/${advId}?region=${currentRegion}`;
            tooltipTitle = `在 Google 广告透明度中心查看该广告主全部广告`;
          } else {
            atcUrl = `https://${v}`;
            tooltipTitle = `打开 ${v}`;
          }
          return (
            <Tooltip title={tooltipTitle}>
              <a href={atcUrl} target="_blank" rel="noreferrer">
                <LinkOutlined /> {v}
              </a>
            </Tooltip>
          );
        }
        if (rec._ocrPending) {
          return (
            <Tooltip title="正在用 AI 识别图中的域名，5 秒后自动刷新">
              <span style={{ color: "#1677ff", fontSize: 12 }}>
                <LoadingOutlined spin /> 识别中…
              </span>
            </Tooltip>
          );
        }
        return <span style={{ color: "#bfbfbf" }}>-</span>;
      },
    },
    {
      title: "首次投放", key: "first", width: 100,
      sorter: (a: AtcAd, b: AtcAd) => (a.first_shown ?? 0) - (b.first_shown ?? 0),
      render: (_: unknown, rec: AtcAd) => fmtTs(rec.first_shown),
    },
    {
      title: "最近投放", key: "last", width: 100,
      sorter: (a: AtcAd, b: AtcAd) => (a.last_shown ?? 0) - (b.last_shown ?? 0),
      defaultSortOrder: "descend" as const,
      render: (_: unknown, rec: AtcAd) => fmtTs(rec.last_shown),
    },
  ];

  const collapseItems = filteredAdvertisers.map((adv) => ({
    key: adv.id,
    label: (
      <Space>
        <Text strong>{adv.name || adv.id}</Text>
        <Badge count={adv.filteredCount} style={{ backgroundColor: persistOnly ? "#fa8c16" : "#1677ff" }}
          title={persistOnly ? `持续投放 ${minDays} 天+` : "全部广告"} />
        {adv.filteredCount < adv.adCount && (
          <Text type="secondary" style={{ fontSize: 12 }}>共 {adv.adCount} 条，筛选后 {adv.filteredCount} 条</Text>
        )}
        {adv.id.startsWith("AR") && (
          <a href={`https://adstransparency.google.com/advertiser/${adv.id}`} target="_blank" rel="noreferrer"
            style={{ fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
            ATC ↗
          </a>
        )}
        {/* C-089：关注按钮 — 仅 AR 开头广告主可关注（watchlist cron 需 AR ID） */}
        {adv.id.startsWith("AR") && (() => {
          const key = watchKey(adv.id, region);
          const isWatched = watchedMap.has(key);
          const isToggling = watchToggling.has(key);
          return (
            <Tooltip title={isWatched
              ? "已加入 watchlist：每天 8:00 推送『持续 30 天+ 且昨日还活跃』的广告，跨天可重推（日报语义）"
              : "加入 watchlist：每天 8:00 推送『持续 30 天+ 且昨日还活跃』的广告（顶部 bell 红点）"}>
              <Button size="small" type={isWatched ? "primary" : "default"}
                loading={isToggling}
                icon={isWatched ? <StarFilled /> : <StarOutlined />}
                onClick={(e) => { e.stopPropagation(); toggleWatch(adv.id, adv.name, region); }}>
                {isWatched ? "已关注" : "关注"}
              </Button>
            </Tooltip>
          );
        })()}
      </Space>
    ),
    children: (
      <Table
        dataSource={adv.ads}
        columns={makeAdColumns(adv.id, region)}
        rowKey={(_, i) => String(i)}
        size="small"
        pagination={adv.ads.length > 20 ? { pageSize: 20, size: "small" } : false}
        scroll={{ x: 600 }}
      />
    ),
  }));

  return (
    <div>
      <Title level={4} style={{ marginBottom: 4 }}>
        <EyeOutlined /> 广告情报
      </Title>
      <Text type="secondary" style={{ display: "block", marginBottom: 4 }}>
        按广告主名称/域名搜索，查看其在 Google 全平台投放的广告创意，筛选持续投放的高价值广告。
      </Text>
      <Text type="secondary" style={{ display: "block", marginBottom: 16, fontSize: 12, color: "#faad14" }}>
        ⚠️ 中文广告主名称（如"包新蕾"）无法通过名称直接搜索——建议先在「我的商家」页查竞争度，系统会自动记录 AR ID；或输入 AR 编号（如 AR123456789）精确查询。
      </Text>

      {noKey && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          message="尚未配置 SerpApi Key"
          description={
            <span>
              请先前往「个人设置 → 广告情报」配置 API Key。
              <Button type="link" size="small" icon={<SettingOutlined />} style={{ padding: "0 4px" }}
                onClick={() => router.push("/user/settings")}>去配置</Button>
            </span>
          }
        />
      )}

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input
            placeholder="广告主名称或域名，如：Nike / ta3swim.com"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 300 }}
            prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
            allowClear
          />
          <Select value={region} onChange={setRegion} options={REGIONS} style={{ width: 150 }} />
          <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={handleSearch}>搜索</Button>
        </Space>

        {/* 持续投放过滤器 */}
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Switch
            checked={persistOnly}
            onChange={setPersistOnly}
            checkedChildren={<FireOutlined />}
            unCheckedChildren="全部"
            size="small"
          />
          <Text style={{ fontSize: 13 }}>只看持续投放</Text>
          <InputNumber
            min={1} max={90} value={minDays}
            onChange={(v) => setMinDays(v ?? 15)}
            disabled={!persistOnly}
            size="small" style={{ width: 60 }}
            addonAfter="天"
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            （广告总持续时长 ≥ {minDays} 天）
          </Text>
        </div>
      </Card>

      {result && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">
              {persistOnly ? (
                <>持续投放 <Text strong style={{ color: "#fa8c16" }}>{minDays}天+</Text> 的广告：
                  <Text strong>{filteredAdvertisers.length}</Text> 个广告主 ·
                  <Text strong style={{ color: "#fa8c16" }}>{totalFiltered}</Text> 条
                  <Text type="secondary">（原始共 {result.advertisers.length} 个广告主 · {result.total} 条）</Text>
                </>
              ) : (
                <>找到 <Text strong>{result.advertisers.length}</Text> 个广告主 · 共 <Text strong>{result.total}</Text> 条广告</>
              )}
            </Text>
          </div>

          {/* 0 结果时显示本地快照中匹配的广告主，供直接用 AR ID 精确查询 */}
          {result.total === 0 && localHits.length > 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="在本系统已记录的广告主中发现以下匹配，可点击直接精确查询"
              description={
                <div style={{ marginTop: 8 }}>
                  {localHits.map((h) => (
                    <div key={h.id} style={{ marginBottom: 6 }}>
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0, fontWeight: 600 }}
                        onClick={() => doSearchByArId(h.id, h.name)}
                      >
                        {h.name || h.id}
                      </Button>
                      <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                        {h.id}
                      </Text>
                      {h.domains.length > 0 && (
                        <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                          · 曾推广：{h.domains.slice(0, 3).join(" / ")}
                        </Text>
                      )}
                    </div>
                  ))}
                </div>
              }
            />
          )}

          {filteredAdvertisers.length === 0 ? (
            <Empty description={
              persistOnly
                ? `未找到持续时长超过 ${minDays} 天的广告，可降低天数或关闭过滤`
                : "未找到匹配的广告，请尝试其他关键词"
            } />
          ) : (
            <Collapse
              items={collapseItems}
              defaultActiveKey={filteredAdvertisers.length === 1 ? [filteredAdvertisers[0].id] : []}
            />
          )}
        </>
      )}

      {!result && !loading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#bfbfbf" }}>
          <EyeOutlined style={{ fontSize: 48, marginBottom: 16 }} />
          <div>输入广告主名称，发现持续投放的高价值广告素材</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>
            <Tooltip title="每次查询消耗 1 次 SerpApi 额度，免费额度 250 次/月">
              <Text type="secondary" style={{ cursor: "help", textDecoration: "underline dotted" }}>
                每次查询消耗 1 次额度
              </Text>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
}
