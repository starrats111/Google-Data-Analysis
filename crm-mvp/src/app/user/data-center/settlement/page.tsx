"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Card, Input, Button, Row, Col, Statistic, Table, Segmented, Space, Typography,
  Empty, Progress, Select, DatePicker, Tag, App,
} from "antd";
import {
  SearchOutlined, AccountBookOutlined,
  DollarOutlined, SyncOutlined, BankOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { COLORS } from "@/styles/themeConfig";
import { PLATFORMS } from "@/lib/constants";
import MonthlySettleProgressCard from "@/components/data-center/MonthlySettleProgressCard";
import dayjs, { Dayjs } from "dayjs";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface Summary {
  total_commission: number;
  approved_commission: number;
  rejected_commission: number;
  paid_commission: number;
  pending_commission: number;
  total_orders: number;
  total_order_amount: number;
  approval_rate: number;
  rejection_rate: number;
  settlement_rate: number;
}

interface MerchantRow {
  merchant_id: string;
  merchant_name: string;
  platform: string;
  total: number;
  approved: number;
  rejected: number;
  paid: number;
  pending: number;
  orders: number;
  order_amount: number;
}

interface MonthlyRow {
  month: string;
  total: number;
  approved: number;
  rejected: number;
  paid: number;
  pending: number;
  orders: number;
}

interface MemberRow {
  user_id: string;
  username: string;
  display_name: string;
  total: number;
  approved: number;
  rejected: number;
  paid: number;
  pending: number;
  orders: number;
  order_amount: number;
}

interface TeamMember {
  id: string;
  name: string;
}

interface SettlementData {
  summary: Summary;
  merchants: MerchantRow[];
  monthly: MonthlyRow[];
  members?: MemberRow[];
  teamMembers?: TeamMember[];
  isLeader?: boolean;
}

interface PaymentRow {
  id: string;
  platform: string;
  account_name: string;
  member_name?: string;
  payment_no: string;
  source_kind: string;
  paid_date: string | null;
  amount: number;
  gross_amount: number | null;
  currency: string;
  payment_type: string | null;
  raw_status: string | null;
}

interface PaymentsData {
  payments: PaymentRow[];
  byPlatform: { platform: string; count: number; amount: number }[];
  total_paid: number;
}

const RANGE_OPTIONS = [
  { label: "本月", value: "1m" },
  { label: "近3个月", value: "3m" },
  { label: "近半年", value: "6m" },
  { label: "近1年", value: "1y" },
];

const PLATFORM_OPTIONS = PLATFORMS.map((p) => ({ value: p.code, label: `${p.code} (${p.name})` }));

export default function SettlementPage() {
  const { message } = App.useApp();
  const [range, setRange] = useState<string>("1m");
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [platform, setPlatform] = useState<string>("");
  const [mid, setMid] = useState("");
  const [memberId, setMemberId] = useState<string>("");
  const [data, setData] = useState<SettlementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("merchant");
  const [topView, setTopView] = useState<"commission" | "payment">("commission");
  const [payAggTab, setPayAggTab] = useState<string>("detail");
  const [payData, setPayData] = useState<PaymentsData | null>(null);
  const [paySyncing, setPaySyncing] = useState(false);

  // 构建与结算查询一致的筛选参数（打款记录不支持 mid 维度）
  const buildParams = useCallback((withMid: boolean) => {
    const params = new URLSearchParams();
    if (dateRange) {
      params.set("date_start", dateRange[0].format("YYYY-MM-DD"));
      params.set("date_end", dateRange[1].format("YYYY-MM-DD"));
    } else {
      params.set("range", range);
    }
    if (platform) params.set("platform", platform);
    if (withMid && mid.trim()) params.set("mid", mid.trim());
    if (memberId) params.set("member_id", memberId);
    return params;
  }, [range, dateRange, platform, mid, memberId]);

  const loadPayments = useCallback(async () => {
    try {
      const res = await fetch(`/api/user/data-center/payments?${buildParams(false)}`).then((r) => r.json());
      if (res.code === 0) setPayData(res.data);
    } catch {
      // 静默
    }
  }, [buildParams]);

  const doSearch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/data-center/settlement?${buildParams(true)}`).then((r) => r.json());
      if (res.code === 0) {
        setData(res.data);
        if (res.data.summary.total_orders === 0) message.info("该条件下暂无交易数据");
      } else {
        setData(null);
        message.error(res.message || "查询失败");
      }
    } finally {
      setLoading(false);
    }
    loadPayments();
  }, [buildParams, loadPayments, message]);

  const syncPayments = useCallback(async () => {
    setPaySyncing(true);
    try {
      const res = await fetch("/api/user/data-center/sync-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(`已支付同步完成：实付 $${Number(res.data.paid_amount || 0).toFixed(2)}`);
        doSearch();
      } else {
        message.error(res.message || "支付同步失败");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "支付同步失败");
    } finally {
      setPaySyncing(false);
    }
  }, [doSearch, message]);

  useEffect(() => { doSearch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 交易数据轮询：每 60 秒检查版本戳，有变动时静默重新查询
  const txnVersionRef = useRef<string>("");
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("/api/user/data-center/txn-version").then((r) => r.json());
        if (res.code !== 0) return;
        const version: string = res.data?.version ?? "";
        if (!txnVersionRef.current) {
          txnVersionRef.current = version;
          return;
        }
        if (version !== txnVersionRef.current) {
          txnVersionRef.current = version;
          doSearch();
        }
      } catch {
        // 静默忽略
      }
    };
    const init = setTimeout(poll, 5000);
    const timer = setInterval(poll, 60000);
    return () => { clearTimeout(init); clearInterval(timer); };
  }, [doSearch]);

  const merchantColumns: ColumnsType<MerchantRow> = [
    {
      title: "平台", dataIndex: "platform", width: 70, align: "center",
      render: (v: string) => <Tag color="blue">{v}</Tag>,
      filters: [...new Set(data?.merchants.map((m) => m.platform) || [])].map((p) => ({ text: p, value: p })),
      onFilter: (v, r) => r.platform === v,
    },
    {
      title: "商家", dataIndex: "merchant_name", width: 200, ellipsis: true,
      render: (v: string, r: MerchantRow) => (
        <span>
          <Text style={{ fontSize: 13 }}>{v}</Text>
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>({r.merchant_id})</Text>
        </span>
      ),
    },
    {
      title: "总佣金($)", dataIndex: "total", width: 110, align: "right",
      sorter: (a, b) => a.total - b.total, defaultSortOrder: "descend",
      render: (v: number) => `$${v.toFixed(2)}`,
    },
    {
      title: "已确认($)", dataIndex: "approved", width: 100, align: "right",
      sorter: (a, b) => a.approved - b.approved,
      render: (v: number) => <span style={{ color: v > 0 ? COLORS.successGreen : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "已支付($)", dataIndex: "paid", width: 100, align: "right",
      sorter: (a, b) => a.paid - b.paid,
      render: (v: number) => <span style={{ color: v > 0 ? "#1890ff" : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "拒付($)", dataIndex: "rejected", width: 100, align: "right",
      sorter: (a, b) => a.rejected - b.rejected,
      render: (v: number) => <span style={{ color: v > 0 ? "#cf1322" : undefined, fontWeight: v > 0 ? 600 : 400 }}>${v.toFixed(2)}</span>,
    },
    {
      title: "待审核($)", dataIndex: "pending", width: 100, align: "right",
      sorter: (a, b) => a.pending - b.pending,
      render: (v: number) => <span style={{ color: v > 0 ? "#faad14" : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "订单数", dataIndex: "orders", width: 70, align: "right",
      sorter: (a, b) => a.orders - b.orders,
    },
    {
      title: "订单金额($)", dataIndex: "order_amount", width: 110, align: "right",
      render: (v: number) => `$${v.toFixed(2)}`,
      sorter: (a, b) => a.order_amount - b.order_amount,
    },
  ];

  const monthlyColumns: ColumnsType<MonthlyRow> = [
    { title: "月份", dataIndex: "month", key: "month", width: 100 },
    {
      title: "总佣金($)", dataIndex: "total", key: "total", width: 120,
      render: (v: number) => `$${v.toFixed(2)}`,
      sorter: (a, b) => a.total - b.total,
    },
    {
      title: "已确认($)", dataIndex: "approved", width: 120,
      sorter: (a, b) => a.approved - b.approved,
      render: (v: number) => <span style={{ color: COLORS.successGreen }}>${v.toFixed(2)}</span>,
    },
    {
      title: "已支付($)", dataIndex: "paid", width: 120,
      sorter: (a, b) => a.paid - b.paid,
      render: (v: number) => <span style={{ color: "#1890ff" }}>${v.toFixed(2)}</span>,
    },
    {
      title: "拒付($)", dataIndex: "rejected", width: 120,
      sorter: (a, b) => a.rejected - b.rejected,
      render: (v: number) => (
        <span style={{ color: v > 0 ? "#cf1322" : undefined, fontWeight: v > 0 ? 600 : 400 }}>
          ${v.toFixed(2)}
        </span>
      ),
    },
    {
      title: "待审核($)", dataIndex: "pending", width: 120,
      sorter: (a, b) => a.pending - b.pending,
      render: (v: number) => <span style={{ color: "#faad14" }}>${v.toFixed(2)}</span>,
    },
    { title: "订单数", dataIndex: "orders", width: 90, sorter: (a, b) => a.orders - b.orders },
  ];

  const memberColumns: ColumnsType<MemberRow> = [
    {
      title: "员工", dataIndex: "display_name", width: 120,
      render: (v: string, r: MemberRow) => (
        <span>
          <Text style={{ fontSize: 13 }}>{v}</Text>
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>({r.username})</Text>
        </span>
      ),
    },
    {
      title: "总佣金($)", dataIndex: "total", width: 110, align: "right",
      sorter: (a, b) => a.total - b.total, defaultSortOrder: "descend",
      render: (v: number) => `$${v.toFixed(2)}`,
    },
    {
      title: "已确认($)", dataIndex: "approved", width: 100, align: "right",
      sorter: (a, b) => a.approved - b.approved,
      render: (v: number) => <span style={{ color: v > 0 ? COLORS.successGreen : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "已支付($)", dataIndex: "paid", width: 100, align: "right",
      sorter: (a, b) => a.paid - b.paid,
      render: (v: number) => <span style={{ color: v > 0 ? "#1890ff" : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "拒付($)", dataIndex: "rejected", width: 100, align: "right",
      sorter: (a, b) => a.rejected - b.rejected,
      render: (v: number) => <span style={{ color: v > 0 ? "#cf1322" : undefined, fontWeight: v > 0 ? 600 : 400 }}>${v.toFixed(2)}</span>,
    },
    {
      title: "待审核($)", dataIndex: "pending", width: 100, align: "right",
      sorter: (a, b) => a.pending - b.pending,
      render: (v: number) => <span style={{ color: v > 0 ? "#faad14" : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "订单数", dataIndex: "orders", width: 70, align: "right",
      sorter: (a, b) => a.orders - b.orders,
    },
    {
      title: "订单金额($)", dataIndex: "order_amount", width: 110, align: "right",
      render: (v: number) => `$${v.toFixed(2)}`,
      sorter: (a, b) => a.order_amount - b.order_amount,
    },
  ];

  const SOURCE_KIND_LABEL: Record<string, string> = {
    payment_summary: "打款单",
    withdrawal: "提现",
    merchant_commission: "商家佣金",
  };

  const paymentColumns: ColumnsType<PaymentRow> = [
    {
      title: "平台", dataIndex: "platform", width: 70, align: "center",
      render: (v: string) => <Tag color="blue">{v}</Tag>,
      filters: [...new Set(payData?.payments.map((p) => p.platform) || [])].map((p) => ({ text: p, value: p })),
      onFilter: (v, r) => r.platform === v,
    },
    {
      title: "账号", dataIndex: "account_name", width: 130, ellipsis: true,
      filters: [...new Set(payData?.payments.map((p) => p.account_name) || [])].map((a) => ({ text: a, value: a })),
      onFilter: (v, r) => r.account_name === v,
      render: (v: string, r: PaymentRow) => (
        <span>
          <Text style={{ fontSize: 13 }}>{v}</Text>
          {r.member_name && <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>({r.member_name})</Text>}
        </span>
      ),
    },
    { title: "打款日", dataIndex: "paid_date", width: 110, sorter: (a, b) => (a.paid_date || "").localeCompare(b.paid_date || ""), defaultSortOrder: "descend" },
    {
      title: "实付佣金($)", dataIndex: "amount", width: 120, align: "right",
      sorter: (a, b) => a.amount - b.amount,
      render: (v: number) => <span style={{ color: "#1890ff", fontWeight: 600 }}>${v.toFixed(2)}</span>,
    },
    {
      title: "类型", dataIndex: "source_kind", width: 90, align: "center",
      render: (v: string) => <Tag>{SOURCE_KIND_LABEL[v] || v}</Tag>,
    },
    { title: "打款方式", dataIndex: "payment_type", width: 110, ellipsis: true, render: (v: string | null) => v || "—" },
    { title: "单号", dataIndex: "payment_no", width: 140, ellipsis: true, render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> },
  ];

  const s = data?.summary;
  const isLeader = data?.isLeader;

  // 打款记录汇总（前端基于 payData.payments 聚合）
  const payByMonth = useMemo(() => {
    const m = new Map<string, { month: string; count: number; amount: number }>();
    for (const p of payData?.payments || []) {
      const key = (p.paid_date || "").slice(0, 7) || "未知";
      const cur = m.get(key) ?? { month: key, count: 0, amount: 0 };
      cur.count++; cur.amount += p.amount; m.set(key, cur);
    }
    return [...m.values()].map((x) => ({ ...x, amount: +x.amount.toFixed(2) })).sort((a, b) => b.month.localeCompare(a.month));
  }, [payData]);

  const payByMember = useMemo(() => {
    const m = new Map<string, { member: string; count: number; amount: number }>();
    for (const p of payData?.payments || []) {
      const key = p.member_name || "—";
      const cur = m.get(key) ?? { member: key, count: 0, amount: 0 };
      cur.count++; cur.amount += p.amount; m.set(key, cur);
    }
    return [...m.values()].map((x) => ({ ...x, amount: +x.amount.toFixed(2) })).sort((a, b) => b.amount - a.amount);
  }, [payData]);

  const payMonthColumns: ColumnsType<{ month: string; count: number; amount: number }> = [
    { title: "月份", dataIndex: "month", width: 120 },
    { title: "笔数", dataIndex: "count", width: 90, align: "right" },
    {
      title: "实付佣金($)", dataIndex: "amount", align: "right",
      sorter: (a, b) => a.amount - b.amount,
      render: (v: number) => <span style={{ color: "#1890ff", fontWeight: 600 }}>${v.toFixed(2)}</span>,
    },
  ];
  const payPlatformColumns: ColumnsType<{ platform: string; count: number; amount: number }> = [
    { title: "平台", dataIndex: "platform", width: 120, render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: "笔数", dataIndex: "count", width: 90, align: "right" },
    {
      title: "实付佣金($)", dataIndex: "amount", align: "right",
      sorter: (a, b) => a.amount - b.amount, defaultSortOrder: "descend",
      render: (v: number) => <span style={{ color: "#1890ff", fontWeight: 600 }}>${v.toFixed(2)}</span>,
    },
  ];
  const payMemberColumns: ColumnsType<{ member: string; count: number; amount: number }> = [
    { title: "员工", dataIndex: "member", width: 160 },
    { title: "笔数", dataIndex: "count", width: 90, align: "right" },
    {
      title: "实付佣金($)", dataIndex: "amount", align: "right",
      sorter: (a, b) => a.amount - b.amount, defaultSortOrder: "descend",
      render: (v: number) => <span style={{ color: "#1890ff", fontWeight: 600 }}>${v.toFixed(2)}</span>,
    },
  ];

  // 打款记录卡片（含 明细/按月份/按平台/按员工 子切换）
  const paymentCard = payData && payData.payments.length > 0 ? (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space size={10} wrap>
          <BankOutlined style={{ color: "#1890ff" }} />
          <Text strong>打款记录</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            实付合计 <Text strong style={{ color: "#1890ff" }}>${payData.total_paid.toLocaleString()}</Text>
            （{payData.payments.length} 笔）
          </Text>
        </Space>
      }
    >
      <Segmented
        value={payAggTab}
        onChange={(v) => setPayAggTab(v as string)}
        options={[
          { label: "明细", value: "detail" },
          { label: `按月份 (${payByMonth.length})`, value: "month" },
          { label: `按平台 (${payData.byPlatform.length})`, value: "platform" },
          ...(isLeader ? [{ label: `按员工 (${payByMember.length})`, value: "member" }] : []),
        ]}
        size="small"
        style={{ marginBottom: 12 }}
      />
      {payAggTab === "month" ? (
        <Table columns={payMonthColumns} dataSource={payByMonth} rowKey="month" size="small" pagination={false} />
      ) : payAggTab === "platform" ? (
        <Table columns={payPlatformColumns} dataSource={payData.byPlatform} rowKey="platform" size="small" pagination={false} />
      ) : payAggTab === "member" && isLeader ? (
        <Table columns={payMemberColumns} dataSource={payByMember} rowKey="member" size="small" pagination={false} />
      ) : (
        <Table<PaymentRow>
          columns={paymentColumns}
          dataSource={payData.payments}
          rowKey="id"
          size="small"
          scroll={{ x: 820 }}
          pagination={{ defaultPageSize: 20, showTotal: (t) => `共 ${t} 笔打款`, showSizeChanger: true }}
        />
      )}
      <Text type="secondary" style={{ fontSize: 11 }}>
        注：RW/LH 等为提现级实付（账户级，按打款日），无法拆分到具体商家/交易月；上方「已支付 / 结算率」即以此实付总额为准。
      </Text>
    </Card>
  ) : (
    !loading && (
      <Card style={{ textAlign: "center", padding: "40px 0" }}>
        <Empty
          image={<BankOutlined style={{ fontSize: 40, color: "#1890ff" }} />}
          description={
            <Space direction="vertical" size={4}>
              <Text style={{ fontSize: 15 }}>该条件下暂无打款记录</Text>
              <Text type="secondary">可点击右上角「同步已支付」拉取最新打款数据</Text>
            </Space>
          }
        />
      </Card>
    )
  );

  return (
    <div>
      <AppPageHeader
        icon={<AccountBookOutlined />}
        title={<>结算查询{isLeader && <Tag color="blue" style={{ marginLeft: 8 }}>组长视图</Tag>}</>}
      />
      {/* 筛选栏 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[8, 8]} align="middle">
          <Col flex="auto">
            <Space size={8} wrap>
              <Segmented
                value={dateRange ? "" : range}
                onChange={(v) => { setRange(v as string); setDateRange(null); }}
                options={RANGE_OPTIONS}
                size="small"
              />
              <RangePicker
                size="small"
                value={dateRange}
                onChange={(v) => { if (v?.[0] && v?.[1]) { setDateRange([v[0], v[1]]); } else { setDateRange(null); } }}
                placeholder={["自定义开始", "自定义结束"]}
                style={{ width: 240 }}
              />
              <Select
                placeholder="全部平台" allowClear style={{ width: 160 }} size="small"
                value={platform || undefined}
                onChange={(v) => setPlatform(v || "")}
                options={PLATFORM_OPTIONS}
              />
              <Input
                placeholder="商家 MID（可选）" allowClear style={{ width: 160 }} size="small"
                prefix={<SearchOutlined />}
                value={mid}
                onChange={(e) => setMid(e.target.value)}
                onPressEnter={doSearch}
              />
              {data?.teamMembers && (
                <Select
                  placeholder="全部员工" allowClear style={{ width: 140 }} size="small"
                  value={memberId || undefined}
                  onChange={(v) => setMemberId(v || "")}
                  options={data.teamMembers.map((m) => ({ value: m.id, label: m.name }))}
                />
              )}
              <Button type="primary" size="small" icon={<SyncOutlined spin={loading} />} loading={loading} onClick={doSearch}>
                查询
              </Button>
              <Button size="small" icon={<BankOutlined />} loading={paySyncing} onClick={syncPayments}>
                同步已支付
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 顶部：佣金查询 / 支付查询 切换 */}
      <div style={{ marginBottom: 12 }}>
        <Segmented
          value={topView}
          onChange={(v) => setTopView(v as "commission" | "payment")}
          options={[
            { label: "佣金查询", value: "commission" },
            { label: `支付查询${payData ? ` (${payData.payments.length})` : ""}`, value: "payment" },
          ]}
        />
      </div>

      {/* 汇总卡片 */}
      {topView === "payment" ? paymentCard : s && s.total_orders > 0 ? (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic title="总佣金" value={s.total_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18 } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic title="已确认" value={s.approved_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: COLORS.successGreen } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic title="已支付" value={s.paid_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: "#1890ff" } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic title="拒付" value={s.rejected_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: "#cf1322" } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic title="待审核" value={s.pending_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: "#faad14" } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic title="总订单" value={s.total_orders} styles={{ content: { fontSize: 18 } }}
                  suffix={<Text type="secondary" style={{ fontSize: 12 }}> / ${s.total_order_amount.toFixed(2)}</Text>}
                />
              </Card>
            </Col>
          </Row>

          {/* 三率 */}
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} sm={8}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <div style={{ textAlign: "center" }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>确认率</Text>
                  <Progress type="dashboard" percent={s.approval_rate} size={80} strokeColor={COLORS.successGreen} format={(p) => `${p}%`} />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <div style={{ textAlign: "center" }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>拒付率</Text>
                  <Progress type="dashboard" percent={s.rejection_rate} size={80} strokeColor="#cf1322" format={(p) => `${p}%`} />
                </div>
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <div style={{ textAlign: "center" }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>结算率</Text>
                  <Progress type="dashboard" percent={s.settlement_rate} size={80} strokeColor="#1890ff" format={(p) => `${p}%`} />
                </div>
              </Card>
            </Col>
          </Row>

          {/* 月份结算进度（每月一张卡，跨整个项目周期不限于筛选时间） */}
          <MonthlySettleProgressCard memberId={memberId || undefined} />

          {/* 明细切换 */}
          <Card
            size="small"
            styles={{ body: { padding: "0 8px 8px" } }}
            title={
              <Segmented
                value={activeTab}
                onChange={(v) => setActiveTab(v as string)}
                options={[
                  { label: `按商家 (${data?.merchants.length || 0})`, value: "merchant" },
                  { label: `按月份 (${data?.monthly.length || 0})`, value: "monthly" },
                  ...(isLeader ? [{ label: `按员工 (${data?.members?.length || 0})`, value: "member" }] : []),
                ]}
                size="small"
              />
            }
          >
            {activeTab === "member" && isLeader ? (
              <Table<MemberRow>
                columns={memberColumns}
                dataSource={data?.members || []}
                rowKey="user_id"
                size="small"
                scroll={{ x: 850 }}
                pagination={false}
                summary={() => {
                  if (!data?.members?.length) return null;
                  const totals = data.members.reduce(
                    (acc, r) => ({
                      total: acc.total + r.total, approved: acc.approved + r.approved,
                      paid: acc.paid + r.paid, rejected: acc.rejected + r.rejected,
                      pending: acc.pending + r.pending, orders: acc.orders + r.orders,
                      order_amount: acc.order_amount + r.order_amount,
                    }),
                    { total: 0, approved: 0, paid: 0, rejected: 0, pending: 0, orders: 0, order_amount: 0 }
                  );
                  return (
                    <Table.Summary fixed>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={1} align="right"><Text strong>${totals.total.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={2} align="right"><Text strong style={{ color: COLORS.successGreen }}>${totals.approved.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right"><Text strong style={{ color: "#1890ff" }}>${totals.paid.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right"><Text strong style={{ color: "#cf1322" }}>${totals.rejected.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right"><Text strong style={{ color: "#faad14" }}>${totals.pending.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right"><Text strong>{totals.orders}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={7} align="right"><Text strong>${totals.order_amount.toFixed(2)}</Text></Table.Summary.Cell>
                      </Table.Summary.Row>
                    </Table.Summary>
                  );
                }}
              />
            ) : activeTab === "merchant" ? (
              <Table<MerchantRow>
                columns={merchantColumns}
                dataSource={data?.merchants || []}
                rowKey={(r) => `${r.platform}:${r.merchant_id}`}
                size="small"
                scroll={{ x: 900 }}
                pagination={{ defaultPageSize: 50, showTotal: (t) => `共 ${t} 个商家`, showSizeChanger: true, pageSizeOptions: ["10", "20", "50", "100"] }}
                summary={() => {
                  if (!data?.merchants.length) return null;
                  const totals = data.merchants.reduce(
                    (acc, r) => ({
                      total: acc.total + r.total, approved: acc.approved + r.approved,
                      paid: acc.paid + r.paid, rejected: acc.rejected + r.rejected,
                      pending: acc.pending + r.pending, orders: acc.orders + r.orders,
                      order_amount: acc.order_amount + r.order_amount,
                    }),
                    { total: 0, approved: 0, paid: 0, rejected: 0, pending: 0, orders: 0, order_amount: 0 }
                  );
                  return (
                    <Table.Summary fixed>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={2}><Text strong>合计</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={2} align="right"><Text strong>${totals.total.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right"><Text strong style={{ color: COLORS.successGreen }}>${totals.approved.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right"><Text strong style={{ color: "#1890ff" }}>${totals.paid.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right"><Text strong style={{ color: "#cf1322" }}>${totals.rejected.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right"><Text strong style={{ color: "#faad14" }}>${totals.pending.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={7} align="right"><Text strong>{totals.orders}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={8} align="right"><Text strong>${totals.order_amount.toFixed(2)}</Text></Table.Summary.Cell>
                      </Table.Summary.Row>
                    </Table.Summary>
                  );
                }}
              />
            ) : (
              <Table<MonthlyRow>
                columns={monthlyColumns}
                dataSource={data?.monthly || []}
                rowKey="month"
                size="small"
                pagination={false}
                summary={() => {
                  if (!data?.monthly.length) return null;
                  const totals = data.monthly.reduce(
                    (acc, r) => ({
                      total: acc.total + r.total, approved: acc.approved + r.approved,
                      paid: acc.paid + r.paid, rejected: acc.rejected + r.rejected,
                      pending: acc.pending + r.pending, orders: acc.orders + r.orders,
                    }),
                    { total: 0, approved: 0, paid: 0, rejected: 0, pending: 0, orders: 0 }
                  );
                  return (
                    <Table.Summary fixed>
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={1} align="right"><Text strong>${totals.total.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={2} align="right"><Text strong style={{ color: COLORS.successGreen }}>${totals.approved.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right"><Text strong style={{ color: "#1890ff" }}>${totals.paid.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right"><Text strong style={{ color: "#cf1322" }}>${totals.rejected.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={5} align="right"><Text strong style={{ color: "#faad14" }}>${totals.pending.toFixed(2)}</Text></Table.Summary.Cell>
                        <Table.Summary.Cell index={6} align="right"><Text strong>{totals.orders}</Text></Table.Summary.Cell>
                      </Table.Summary.Row>
                    </Table.Summary>
                  );
                }}
              />
            )}
          </Card>
        </>
      ) : (
        !loading && (
          <Card style={{ textAlign: "center", padding: "60px 0" }}>
            <Empty
              image={<DollarOutlined style={{ fontSize: 48, color: COLORS.primary }} />}
              description={
                <Space direction="vertical" size={4}>
                  <Text style={{ fontSize: 16 }}>暂无结算数据</Text>
                  <Text type="secondary">请调整筛选条件或先在数据中心同步交易数据</Text>
                </Space>
              }
            />
          </Card>
        )
      )}
    </div>
  );
}
