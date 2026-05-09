"use client";

import { useState, useMemo, useEffect } from "react";
import {
  Card, Input, Button, Select, Space, Table, Tag, Typography,
  Collapse, Empty, Alert, App, Tooltip, Switch, InputNumber, Badge,
} from "antd";
import { SearchOutlined, EyeOutlined, LinkOutlined, SettingOutlined, FireOutlined } from "@ant-design/icons";
import { useRouter, useSearchParams } from "next/navigation";

const { Title, Text } = Typography;

interface AtcAd {
  format: string;
  title?: string;
  domain?: string;
  first_shown?: number;  // Unix 秒级时间戳
  last_shown?: number;   // Unix 秒级时间戳
  thumbnail?: string;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const adColumns = [
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
      render: (v?: string) =>
        v ? <a href={`https://${v}`} target="_blank" rel="noreferrer"><LinkOutlined /> {v}</a>
          : <span style={{ color: "#bfbfbf" }}>-</span>,
    },
    { title: "首次投放", key: "first", width: 100, render: (_: unknown, rec: AtcAd) => fmtTs(rec.first_shown) },
    { title: "最近投放", key: "last",  width: 100, render: (_: unknown, rec: AtcAd) => fmtTs(rec.last_shown) },
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
      </Space>
    ),
    children: (
      <Table
        dataSource={adv.ads}
        columns={adColumns}
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
