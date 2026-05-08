"use client";

import { useState } from "react";
import {
  Card, Input, Button, Select, Space, Table, Tag, Typography,
  Collapse, Empty, Alert, App, Tooltip,
} from "antd";
import { SearchOutlined, EyeOutlined, LinkOutlined, SettingOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Text } = Typography;

interface AtcAd {
  format: string;
  title?: string;
  domain?: string;
  first_shown?: string;
  last_shown?: string;
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

const AD_COLS = [
  { title: "格式", dataIndex: "format", width: 80, render: (v: string) => <Tag>{v || "text"}</Tag> },
  {
    title: "广告预览",
    dataIndex: "thumbnail",
    width: 120,
    render: (src: string | undefined, rec: AtcAd) =>
      src
        ? <img src={src} alt="" style={{ maxWidth: 100, maxHeight: 60, objectFit: "contain" }} />
        : <Text type="secondary" style={{ fontSize: 12 }}>{rec.title || "-"}</Text>,
  },
  {
    title: "投放域名",
    dataIndex: "domain",
    width: 180,
    render: (v: string | undefined) =>
      v ? (
        <a href={`https://${v}`} target="_blank" rel="noreferrer">
          <LinkOutlined /> {v}
        </a>
      ) : <span style={{ color: "#bfbfbf" }}>-</span>,
  },
  { title: "首次投放", dataIndex: "first_shown", width: 110, render: (v?: string) => v ?? "-" },
  { title: "最近投放", dataIndex: "last_shown", width: 110, render: (v?: string) => v ?? "-" },
];

export default function IntelligencePage() {
  const { message } = App.useApp();
  const router = useRouter();
  const [searchText, setSearchText] = useState("");
  const [region, setRegion] = useState("US");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ advertisers: AdvertiserGroup[]; total: number } | null>(null);
  const [noKey, setNoKey] = useState(false);

  const handleSearch = async () => {
    const text = searchText.trim();
    if (!text) { message.warning("请输入广告主名称"); return; }
    setLoading(true);
    setNoKey(false);
    try {
      const qs = new URLSearchParams({ text, region }).toString();
      const res = await fetch(`/api/user/atc/intelligence?${qs}`).then((r) => r.json());
      if (res.code === 0) {
        setResult(res.data);
      } else if (res.message?.includes("SerpApi Key")) {
        setNoKey(true);
      } else {
        message.error(res.message ?? "查询失败");
      }
    } catch {
      message.error("网络错误，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const collapseItems = (result?.advertisers ?? []).map((adv) => ({
    key: adv.id,
    label: (
      <Space>
        <Text strong>{adv.name}</Text>
        <Tag color="blue">{adv.adCount} 条广告</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>ID: {adv.id}</Text>
      </Space>
    ),
    children: (
      <Table
        dataSource={adv.ads}
        columns={AD_COLS}
        rowKey={(_, i) => String(i)}
        size="small"
        pagination={adv.ads.length > 20 ? { pageSize: 20, size: "small" } : false}
        scroll={{ x: 600 }}
      />
    ),
  }));

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>
        <EyeOutlined /> 广告情报
      </Title>
      <Text type="secondary" style={{ display: "block", marginBottom: 20 }}>
        按广告主名称搜索，查看其在 Google 全平台投放的广告创意，反向发现优质商家。
      </Text>

      {noKey && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="尚未配置 SerpApi Key"
          description={
            <span>
              请先前往「个人设置 → 广告情报」配置您的 SerpApi API Key。
              <Button
                type="link"
                size="small"
                icon={<SettingOutlined />}
                style={{ padding: "0 4px" }}
                onClick={() => router.push("/user/settings")}
              >
                去配置
              </Button>
            </span>
          }
        />
      )}

      <Card size="small" style={{ marginBottom: 20 }}>
        <Space wrap>
          <Input
            placeholder="输入广告主名称，如：Nike Inc."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 320 }}
            prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
            allowClear
          />
          <Select
            value={region}
            onChange={setRegion}
            options={REGIONS}
            style={{ width: 160 }}
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={loading}
            onClick={handleSearch}
          >
            搜索
          </Button>
        </Space>
      </Card>

      {result && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">
              找到 <Text strong>{result.advertisers.length}</Text> 个匹配广告主 ·
              共 <Text strong>{result.total}</Text> 条广告创意
            </Text>
          </div>
          {result.advertisers.length === 0 ? (
            <Empty description="未找到匹配的广告主，请尝试其他关键词" />
          ) : (
            <Collapse
              items={collapseItems}
              defaultActiveKey={result.advertisers.length === 1 ? [result.advertisers[0].id] : []}
            />
          )}
        </>
      )}

      {!result && !loading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#bfbfbf" }}>
          <EyeOutlined style={{ fontSize: 48, marginBottom: 16 }} />
          <div>输入广告主名称，开始探索竞争对手的广告策略</div>
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
