"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Card, Input, Button, Row, Col, Statistic, Table, Segmented, Space, Typography,
  Empty, Progress, Select, DatePicker, Tag, App, Tooltip, Modal,
} from "antd";
import {
  SearchOutlined, AccountBookOutlined,
  DollarOutlined, SyncOutlined, BankOutlined, EditOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { COLORS } from "@/styles/themeConfig";
import { PLATFORMS } from "@/lib/constants";
import { TXN_TZ_NOTE } from "@/lib/report-metrics";
import MonthlySettleProgressCard from "@/components/data-center/MonthlySettleProgressCard";
import dayjs, { Dayjs } from "dayjs";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface Summary {
  total_commission: number;
  approved_commission: number; // 已确认 = 交易表 approved
  rejected_commission: number; // 已拒付 = 交易表 rejected
  paid_commission: number; // 已支付 = 交易表 paid 桶（与「支付查询」的账户级到账分开）
  pending_commission: number;
  received_amount: number; // 已到账 = 支付API 实付（去重毛额，与「支付查询」实付合计同源）
  awaiting_payment: number; // 待打款 = (approved+paid) − 已到账
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
  payee?: string | null;
  member_name?: string;
  payment_no: string;
  source_kind: string;
  paid_date: string | null;
  /** 展示金额 = 平台毛额（gross 优先，与平台后台一致；gross 缺失回退净额） */
  amount: number;
  /** 净额（到账金额） */
  net_amount?: number;
  /** 手续费 = 毛额 − 净额 */
  fee?: number;
  gross_amount: number | null;
  currency: string;
  payment_type: string | null;
  /** C-179：生效收款方式 id（逐笔修正优先，否则账号绑定），null=未绑定 */
  payment_method_id?: string | null;
  /** C-179：该笔是否被逐笔修正过 */
  is_override?: boolean;
  /** paid=已到账 | processing=审核中（如 LB 打款单确认期） */
  status?: string;
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

  // C-179：逐笔修正打款方式
  interface TeamMethod { id: string; payee_name: string; pay_channel: string; card_no: string }
  const [teamMethods, setTeamMethods] = useState<TeamMethod[]>([]);
  const [payEdit, setPayEdit] = useState<PaymentRow | null>(null);
  const [editMethodId, setEditMethodId] = useState<string | undefined>(undefined);
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    fetch("/api/user/team/payment-methods")
      .then((r) => r.json())
      .then((res) => { if (res?.code === 0) setTeamMethods(res.data || []); })
      .catch(() => undefined);
  }, []);

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

  // C-179：保存逐笔修正（methodId=null 恢复跟随账号绑定）
  const savePayMethod = useCallback(async (methodId: string | null) => {
    if (!payEdit) return;
    setEditSaving(true);
    try {
      const res = await fetch("/api/user/data-center/payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: payEdit.id, payment_method_id: methodId }),
      }).then((r) => r.json());
      if (res.code === 0) {
        message.success(res.message || "已保存");
        setPayEdit(null);
        loadPayments();
      } else {
        message.error(res.message || "保存失败");
      }
    } finally {
      setEditSaving(false);
    }
  }, [payEdit, loadPayments, message]);

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
    {
      title: "收款人", dataIndex: "payee", width: 100, ellipsis: true,
      filters: [...new Set(payData?.payments.map((p) => p.payee || "未设置") || [])].map((a) => ({ text: a, value: a })),
      onFilter: (v, r) => (r.payee || "未设置") === v,
      render: (v: string | null) => v ? <Tag color="purple">{v}</Tag> : <Text type="secondary">—</Text>,
    },
    { title: "打款日", dataIndex: "paid_date", width: 110, sorter: (a, b) => (a.paid_date || "").localeCompare(b.paid_date || ""), defaultSortOrder: "descend" },
    {
      title: "状态", dataIndex: "status", width: 86, align: "center",
      filters: [{ text: "已到账", value: "paid" }, { text: "审核中", value: "processing" }],
      onFilter: (v, r) => (r.status || "paid") === v,
      render: (v: string | undefined) =>
        v === "processing" ? (
          <Tooltip title="平台已生成打款单但仍在审核/在途，未计入实付合计与报表实收（计入应收）">
            <Tag color="orange">审核中</Tag>
          </Tooltip>
        ) : <Tag color="green">已到账</Tag>,
    },
    {
      title: "实付佣金($)", dataIndex: "amount", width: 120, align: "right",
      sorter: (a, b) => a.amount - b.amount,
      render: (v: number, r: PaymentRow) =>
        r.fee && r.fee > 0 ? (
          <Tooltip title={`平台毛额 $${v.toFixed(2)}（到账净额 $${(r.net_amount ?? v).toFixed(2)}，手续费 $${r.fee.toFixed(2)}）`}>
            <span style={{ color: "#1890ff", fontWeight: 600, cursor: "help" }}>${v.toFixed(2)}</span>
          </Tooltip>
        ) : (
          <span style={{ color: "#1890ff", fontWeight: 600 }}>${v.toFixed(2)}</span>
        ),
    },
    {
      title: "类型", dataIndex: "source_kind", width: 90, align: "center",
      render: (v: string) => <Tag>{SOURCE_KIND_LABEL[v] || v}</Tag>,
    },
    {
      // C-178：打款方式 = 生效收款方式的「打款方式」字段（未绑定显示 —），支持列头筛选
      // C-179：可逐笔修正（员工换绑后历史笔按当时实际打款方式改回）
      title: "打款方式", dataIndex: "payment_type", width: 130,
      filters: [...new Set(payData?.payments.map((p) => p.payment_type || "未绑定") || [])].map((t) => ({ text: t, value: t })),
      onFilter: (v, r) => (r.payment_type || "未绑定") === v,
      render: (v: string | null, r: PaymentRow) => (
        <Space size={2}>
          {v ? (
            r.is_override ? (
              <Tooltip title="该笔已逐笔修正，不随账号绑定变化">
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>{v}</Tag>
              </Tooltip>
            ) : (
              <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{v}</Tag>
            )
          ) : (
            <Text type="secondary">—</Text>
          )}
          <Tooltip title="修改这一笔的打款方式">
            <Button
              type="text" size="small" icon={<EditOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                setPayEdit(r);
                setEditMethodId(r.payment_method_id || undefined);
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
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

  // 收款人汇总：按连接配置的 payee 聚合
  const payByPayee = useMemo(() => {
    const m = new Map<string, { payee: string; count: number; amount: number }>();
    for (const p of payData?.payments || []) {
      const key = (p.payee && p.payee.trim()) || "未设置收款人";
      const cur = m.get(key) ?? { payee: key, count: 0, amount: 0 };
      cur.count++; cur.amount += p.amount; m.set(key, cur);
    }
    return [...m.values()].map((x) => ({ ...x, amount: +x.amount.toFixed(2) })).sort((a, b) => b.amount - a.amount);
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

  // 收款人卡片（按连接配置的收款人聚合实付金额）
  const PAYEE_COLORS = ["#1890ff", COLORS.successGreen, "#722ed1", "#fa8c16", "#13c2c2", "#eb2f96"];
  const personCard = payData && payData.payments.length > 0 ? (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
      {payByPayee.map((p, i) => (
        <Col xs={24} sm={12} md={8} key={p.payee}>
          <Card size="small" styles={{ body: { padding: "10px 16px" } }}>
            <Statistic
              title={<Text>{p.payee} <Text type="secondary" style={{ fontSize: 12 }}>（{p.count} 笔）</Text></Text>}
              value={p.amount}
              prefix="$"
              precision={2}
              styles={{ content: { fontSize: 22, color: PAYEE_COLORS[i % PAYEE_COLORS.length] } }}
            />
          </Card>
        </Col>
      ))}
    </Row>
  ) : null;

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
          scroll={{ x: 920 }}
          pagination={{ defaultPageSize: 20, showTotal: (t) => `共 ${t} 笔打款`, showSizeChanger: true }}
        />
      )}
      <Text type="secondary" style={{ fontSize: 11 }}>
        注：本页为账户级打款记录（提现/打款，按打款日，来源支付API），金额为平台毛额、与平台后台逐笔一致（含手续费的行悬停可见到账净额）；与「佣金查询」里订单级「已支付」桶口径不同，二者因汇率/时间归属会有差额。
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
      {topView === "payment" ? (
        <>
          {personCard}
          {paymentCard}
        </>
      ) : s && s.total_orders > 0 ? (
        <>
          {/* 口径B 闭合等式：总佣金 = 审核中 + 已拒绝 + 待打款 + 已到账 */}
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic
                  title={
                    <Tooltip title="总佣金 = 审核中 + 已拒绝 + 待打款 + 已到账（算式闭合）">
                      <span style={{ borderBottom: "1px dashed #aaa", cursor: "help" }}>总佣金</span>
                    </Tooltip>
                  }
                  value={s.total_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18 } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic
                  title={
                    <Tooltip title="审核中 = 交易表 status=pending 的佣金（平台尚未确认）">
                      <span style={{ borderBottom: "1px dashed #aaa", cursor: "help" }}>审核中</span>
                    </Tooltip>
                  }
                  value={s.pending_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: "#faad14" } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic
                  title={
                    <Tooltip title="待打款 = (已确认 + 平台标记已结) − 已到账，即平台已确认应付但尚未实际到账的钱。可能为负：本期到账的打款单里含更早窗口订单的佣金（时间轴差），属正常。">
                      <span style={{ borderBottom: "1px dashed #aaa", cursor: "help" }}>待打款</span>
                    </Tooltip>
                  }
                  value={s.awaiting_payment} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: "#1890ff" } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic
                  title={
                    <Tooltip title="已到账 = 支付API 实付打款单合计（按打款日归窗、去重毛额），与「支付查询」页签实付合计同源">
                      <span style={{ borderBottom: "1px dashed #aaa", cursor: "help" }}>已到账</span>
                    </Tooltip>
                  }
                  value={s.received_amount} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: COLORS.successGreen } }} />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small" styles={{ body: { padding: "8px 12px" } }}>
                <Statistic
                  title={
                    <Tooltip title="已拒绝 = 交易表 status=rejected 的佣金。若后期平台实际打款（支付细节API 证实），会自动改回 paid 并计入待打款/已到账侧。">
                      <span style={{ borderBottom: "1px dashed #aaa", cursor: "help" }}>已拒绝</span>
                    </Tooltip>
                  }
                  value={s.rejected_commission} prefix="$" precision={2} styles={{ content: { fontSize: 18, color: "#cf1322" } }} />
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
                  <Tooltip title="确认率 = (已确认 approved + 已打款 paid) / 总佣金——paid 是 approved 的后继状态，一并计入">
                    <Text type="secondary" style={{ fontSize: 13, borderBottom: "1px dashed #ccc", cursor: "help" }}>确认率</Text>
                  </Tooltip>
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
            <Text type="secondary" style={{ fontSize: 11 }}>* {TXN_TZ_NOTE}</Text>
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

      {/* C-179：逐笔修正打款方式弹窗 */}
      <Modal
        title="修改这一笔的打款方式"
        open={!!payEdit}
        onCancel={() => setPayEdit(null)}
        footer={[
          ...(payEdit?.is_override
            ? [<Button key="reset" loading={editSaving} onClick={() => savePayMethod(null)}>恢复跟随账号绑定</Button>]
            : []),
          <Button key="cancel" onClick={() => setPayEdit(null)}>取消</Button>,
          <Button
            key="ok" type="primary" loading={editSaving}
            disabled={!editMethodId || editMethodId === (payEdit?.payment_method_id || undefined)}
            onClick={() => editMethodId && savePayMethod(editMethodId)}
          >
            保存
          </Button>,
        ]}
      >
        {payEdit && (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {payEdit.platform} · {payEdit.account_name} · 打款日 {payEdit.paid_date || "—"} · ${payEdit.amount.toFixed(2)}（单号 {payEdit.payment_no}）
            </Text>
            <Select
              style={{ width: "100%" }}
              placeholder="选择打款方式"
              value={editMethodId}
              onChange={(v) => setEditMethodId(v)}
              options={(payEdit.payee
                ? teamMethods.filter((m) => m.payee_name === payEdit.payee)
                : teamMethods
              ).map((m) => ({
                value: m.id,
                label: `${m.payee_name} · ${m.pay_channel || "未填打款方式"}（${m.card_no || "未填卡号"}）`,
              }))}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              只改这一笔（含同单号的重复行），不影响账号绑定和其它打款记录；
              {payEdit.payee ? `只能选「${payEdit.payee}」名下的打款方式。` : "该笔未绑定收款方式，可任选本组清单。"}
              银行流水登记的预填也按修改后的归属计算。
            </Text>
          </Space>
        )}
      </Modal>
    </div>
  );
}
