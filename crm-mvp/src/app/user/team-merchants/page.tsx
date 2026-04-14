"use client";
import { useState, useCallback, useMemo } from "react";
import {
  Card, Table, Input, Select, Button, Space, Tag, Modal, Typography, Tooltip, App,
} from "antd";
import {
  ShopOutlined, SearchOutlined, SyncOutlined, TeamOutlined, CalendarOutlined,
} from "@ant-design/icons";
import { PLATFORMS } from "@/lib/constants";
import { useApiWithParams } from "@/lib/swr";

function getCurrentMonthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return `${y}-${m}-01 ~ ${y}-${m}-${String(lastDay).padStart(2, "0")}`;
}

const { Text } = Typography;

const PC: Record<string, string> = {
  RW: "#7c3aed", LH: "#16a34a", CG: "#2563eb", PM: "#ea580c",
  LB: "#0891b2", BSH: "#be185d", CF: "#ca8a04",
};

const CATEGORY_CN: Record<string, string> = {
  "Others": "其他", "Health & Beauty": "健康美容", "Home & Garden": "家居园艺",
  "Online Services & Software": "在线服务与软件", "Telecommunications": "电信",
  "B2B": "企业服务", "Marketing": "营销", "Fashion": "时尚服饰",
  "Electronics": "电子产品", "Travel": "旅游出行", "Finance": "金融理财",
  "Education": "教育培训", "Food & Drink": "食品饮料", "Sports & Fitness": "运动健身",
  "Automotive": "汽车", "Entertainment": "娱乐", "Pets": "宠物",
  "Baby & Kids": "母婴", "Books & Media": "图书媒体", "Gifts & Flowers": "礼品鲜花",
  "Insurance": "保险", "Legal": "法律", "Real Estate": "房地产",
  "Skincare": "护肤", "Cosmetics": "化妆品", "Supplements": "保健品",
  "Software": "软件", "SaaS": "SaaS", "Crypto": "加密货币",
};
const catCn = (v: string | null) => { if (!v) return "-"; return CATEGORY_CN[v] || v; };

function getFaviconUrl(merchantUrl: string | null | undefined): string | null {
  if (!merchantUrl) return null;
  try {
    const domain = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  } catch { return null; }
}

function MerchantIcon({ url }: { url: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  const iconUrl = getFaviconUrl(url);
  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        style={{ width: 22, height: 22, borderRadius: 4, objectFit: "contain", flexShrink: 0 }}
        onError={() => setFailed(true)}
      />
    );
  }
  return <ShopOutlined style={{ fontSize: 18, color: "#bfbfbf", flexShrink: 0 }} />;
}

interface TeamMerchant {
  key: string;
  merchant_id: string;
  platform: string;
  merchant_name: string;
  merchant_url: string | null;
  category: string | null;
  active_advertisers: number;
  monthly_commission: number;
  roi: number;
  total_cost: number;
}

interface AdvDetail {
  user_id: string;
  display_name: string;
  campaign_count: number;
  enabled_count: number;
  campaign_created_at: string | null;
  total_cost: string;
  total_clicks: number;
  total_impressions: number;
  monthly_commission: string;
  roi: string;
}

interface ApiResponse {
  merchants: TeamMerchant[];
  total: number;
  page: number;
  pageSize: number;
}

export default function TeamMerchantsPage() {
  const { message } = App.useApp();
  const [platform, setPlatform] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const params = useMemo(() => ({
    page,
    pageSize: 50,
    ...(platform ? { platform } : {}),
    ...(search ? { search } : {}),
  }), [page, platform, search]);

  const { data, isLoading, mutate } = useApiWithParams<ApiResponse>(
    "/api/user/team/merchants",
    params,
    { keepPreviousData: true }
  );

  const merchants = data?.merchants || [];
  const total = data?.total || 0;

  const doSearch = useCallback(() => { setSearch(searchInput); setPage(1); }, [searchInput]);
  const doReset = useCallback(() => { setSearchInput(""); setSearch(""); setPlatform(""); setPage(1); }, []);

  // 在投详情弹窗
  const [advModal, setAdvModal] = useState(false);
  const [advMerchant, setAdvMerchant] = useState<TeamMerchant | null>(null);
  const [advList, setAdvList] = useState<AdvDetail[]>([]);
  const [advLoading, setAdvLoading] = useState(false);

  const showActiveAdv = useCallback(async (m: TeamMerchant) => {
    setAdvMerchant(m);
    setAdvModal(true);
    setAdvLoading(true);
    try {
      const res = await fetch(
        `/api/user/merchants/active-advertisers?merchant_id=${m.merchant_id}&platform=${m.platform}`
      ).then((r) => r.json());
      setAdvList(res.data || []);
    } catch {
      setAdvList([]);
      message.error("加载失败，请重试");
    } finally {
      setAdvLoading(false);
    }
  }, [message]);

  const columns = useMemo(() => [
    {
      title: "商家名称",
      dataIndex: "merchant_name",
      width: 220,
      render: (v: string, rec: TeamMerchant) => (
        <Space size={6}>
          <MerchantIcon url={rec.merchant_url} />
          <span style={{ fontWeight: 600 }}>{v || "-"}</span>
        </Space>
      ),
    },
    {
      title: "平台",
      dataIndex: "platform",
      width: 80,
      render: (v: string) => <Tag color={PC[v] || "default"} style={{ fontWeight: 600 }}>{v}</Tag>,
    },
    {
      title: "MID",
      dataIndex: "merchant_id",
      width: 100,
      ellipsis: true,
    },
    {
      title: "主营业务",
      dataIndex: "category",
      width: 130,
      ellipsis: true,
      render: (v: string | null) => catCn(v),
    },
    {
      title: "在投人数",
      dataIndex: "active_advertisers",
      width: 90,
      align: "center" as const,
      render: (v: number, rec: TeamMerchant) =>
        v > 0 ? (
          <Button size="small" type="link" style={{ padding: 0, fontWeight: 600 }} onClick={() => showActiveAdv(rec)}>
            {v} 人
          </Button>
        ) : (
          <span style={{ color: "#bfbfbf" }}>0</span>
        ),
    },
    {
      title: "本月佣金",
      dataIndex: "monthly_commission",
      width: 110,
      align: "right" as const,
      sorter: (a: TeamMerchant, b: TeamMerchant) => a.monthly_commission - b.monthly_commission,
      render: (v: number) => (
        <span style={{ color: v > 0 ? "#52c41a" : "#999", fontWeight: v > 0 ? 600 : 400 }}>
          ${v.toFixed(2)}
        </span>
      ),
    },
    {
      title: "ROI",
      dataIndex: "roi",
      width: 90,
      align: "right" as const,
      sorter: (a: TeamMerchant, b: TeamMerchant) => a.roi - b.roi,
      render: (v: number) => {
        const color = v > 0 ? "#52c41a" : v < 0 ? "#ff4d4f" : "#999";
        return <span style={{ color, fontWeight: 600 }}>{v.toFixed(1)}%</span>;
      },
    },
  ], [showActiveAdv]);

  // 在投详情弹窗汇总数据
  const advTotalCost = advList.reduce((s, r) => s + parseFloat(r.total_cost || "0"), 0);
  const advTotalComm = advList.reduce((s, r) => s + parseFloat(r.monthly_commission || "0"), 0);
  const advAvgRoi = advTotalCost > 0 ? ((advTotalComm - advTotalCost) / advTotalCost).toFixed(2) : "0.00";

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <Card
        title={
          <Space>
            <TeamOutlined style={{ color: "#1677ff" }} />
            <span style={{ fontWeight: 700 }}>组下商家</span>
            {total > 0 && <Tag color="blue">{total} 个商家</Tag>}
          </Space>
        }
        extra={
          <Space size={12}>
            <Space size={4} style={{ color: "#8c8c8c", fontSize: 13 }}>
              <CalendarOutlined />
              <span>数据区间：</span>
              <Tag color="orange" style={{ margin: 0 }}>本月</Tag>
              <span style={{ color: "#bfbfbf" }}>{getCurrentMonthRange()}</span>
            </Space>
            <Button size="small" icon={<SyncOutlined />} onClick={() => mutate()}>
              刷新
            </Button>
          </Space>
        }
      >
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <Select
            placeholder="平台"
            allowClear
            style={{ width: 120 }}
            size="small"
            value={platform || undefined}
            onChange={(v) => { setPlatform(v || ""); setPage(1); }}
            options={PLATFORMS.map((p) => ({ value: p.code, label: p.code }))}
          />
          <Input
            placeholder="搜索商家名/MID"
            prefix={<SearchOutlined />}
            style={{ width: 200 }}
            size="small"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onPressEnter={doSearch}
          />
          <Button type="primary" size="small" icon={<SearchOutlined />} onClick={doSearch}>查询</Button>
          <Button size="small" icon={<SyncOutlined />} onClick={doReset}>重置</Button>
        </div>

        <Table
          columns={columns}
          dataSource={merchants}
          rowKey="key"
          loading={isLoading}
          size="small"
          scroll={{ x: 800 }}
          pagination={{
            current: page,
            pageSize: 50,
            total,
            onChange: setPage,
            showTotal: (t) => `共 ${t} 个商家`,
          }}
        />
      </Card>

      <Modal
        title={`在投详情 — ${advMerchant?.merchant_name || ""}`}
        open={advModal}
        onCancel={() => setAdvModal(false)}
        footer={null}
        width={860}
      >
        {advList.length > 0 && (
          <div style={{ marginBottom: 12, display: "flex", gap: 24 }}>
            <div>
              <Text type="secondary">总花费（本月）</Text>
              <div style={{ fontSize: 20, fontWeight: 700 }}>${advTotalCost.toFixed(2)}</div>
            </div>
            <div>
              <Text type="secondary">总佣金（本月）</Text>
              <div style={{ fontSize: 20, fontWeight: 700, color: "#52c41a" }}>${advTotalComm.toFixed(2)}</div>
            </div>
            <div>
              <Text type="secondary">平均 ROI</Text>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{advAvgRoi}</div>
            </div>
          </div>
        )}
        <Table
          dataSource={advList}
          rowKey="user_id"
          loading={advLoading}
          size="small"
          pagination={false}
          columns={[
            { title: "员工", dataIndex: "display_name", width: 100 },
            { title: "广告系列", dataIndex: "campaign_count", width: 80, align: "center" as const },
            { title: "启用", dataIndex: "enabled_count", width: 60, align: "center" as const, render: (v: number) => <Tag color="green">{v}</Tag> },
            {
              title: "投放日期",
              dataIndex: "campaign_created_at",
              width: 110,
              render: (v: string | null) =>
                v ? new Date(v).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "-",
            },
            { title: "总花费", dataIndex: "total_cost", width: 90, align: "right" as const, render: (v: string) => `$${v}` },
            { title: "总点击", dataIndex: "total_clicks", width: 80, align: "right" as const, render: (v: number) => (v || 0).toLocaleString() },
            {
              title: "本月佣金",
              dataIndex: "monthly_commission",
              width: 100,
              align: "right" as const,
              render: (v: string) => <span style={{ color: "#52c41a", fontWeight: 600 }}>${v}</span>,
            },
            { title: "ROI", dataIndex: "roi", width: 70, align: "right" as const },
          ]}
        />
      </Modal>
    </div>
  );
}
