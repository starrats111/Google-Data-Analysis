"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Card, Input, Button, Row, Col, Statistic, Table, Segmented, Space, Typography,
  Empty, Progress, Select, DatePicker, Tag, App,
} from "antd";
import {
  SearchOutlined, AccountBookOutlined,
  DollarOutlined, SyncOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { COLORS } from "@/styles/themeConfig";
import { PLATFORMS } from "@/lib/constants";
import dayjs, { Dayjs } from "dayjs";

const { Title, Text } = Typography;
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

const RANGE_OPTIONS = [
  { label: "1个月", value: "1m" },
  { label: "3个月", value: "3m" },
  { label: "半年", value: "6m" },
  { label: "全年", value: "1y" },
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

  const doSearch = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateRange) {
        params.set("date_start", dateRange[0].format("YYYY-MM-DD"));
        params.set("date_end", dateRange[1].format("YYYY-MM-DD"));
      } else {
        params.set("range", range);
      }
      if (platform) params.set("platform", platform);
      if (mid.trim()) params.set("mid", mid.trim());
      if (memberId) params.set("member_id", memberId);

      const res = await fetch(`/api/user/data-center/settlement?${params}`).then((r) => r.json());
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
  }, [range, dateRange, platform, mid, memberId, message]);

  useEffect(() => { doSearch(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      render: (v: number) => <span style={{ color: v > 0 ? COLORS.successGreen : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "已支付($)", dataIndex: "paid", width: 100, align: "right",
      render: (v: number) => <span style={{ color: v > 0 ? "#1890ff" : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "拒付($)", dataIndex: "rejected", width: 100, align: "right",
      render: (v: number) => <span style={{ color: v > 0 ? "#cf1322" : undefined, fontWeight: v > 0 ? 600 : 400 }}>${v.toFixed(2)}</span>,
    },
    {
      title: "待审核($)", dataIndex: "pending", width: 100, align: "right",
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
      render: (v: number) => <span style={{ color: COLORS.successGreen }}>${v.toFixed(2)}</span>,
    },
    {
      title: "已支付($)", dataIndex: "paid", width: 120,
      render: (v: number) => <span style={{ color: "#1890ff" }}>${v.toFixed(2)}</span>,
    },
    {
      title: "拒付($)", dataIndex: "rejected", width: 120,
      render: (v: number) => (
        <span style={{ color: v > 0 ? "#cf1322" : undefined, fontWeight: v > 0 ? 600 : 400 }}>
          ${v.toFixed(2)}
        </span>
      ),
    },
    {
      title: "待审核($)", dataIndex: "pending", width: 120,
      render: (v: number) => <span style={{ color: "#faad14" }}>${v.toFixed(2)}</span>,
    },
    { title: "订单数", dataIndex: "orders", width: 90 },
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
      render: (v: number) => <span style={{ color: v > 0 ? COLORS.successGreen : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "已支付($)", dataIndex: "paid", width: 100, align: "right",
      render: (v: number) => <span style={{ color: v > 0 ? "#1890ff" : undefined }}>${v.toFixed(2)}</span>,
    },
    {
      title: "拒付($)", dataIndex: "rejected", width: 100, align: "right",
      render: (v: number) => <span style={{ color: v > 0 ? "#cf1322" : undefined, fontWeight: v > 0 ? 600 : 400 }}>${v.toFixed(2)}</span>,
    },
    {
      title: "待审核($)", dataIndex: "pending", width: 100, align: "right",
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

  const s = data?.summary;
  const isLeader = data?.isLeader;

  return (
    <div>
      {/* 筛选栏 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={[8, 8]} align="middle">
          <Col>
            <Title level={5} style={{ margin: 0 }}>
              <AccountBookOutlined /> 结算查询{isLeader && <Tag color="blue" style={{ marginLeft: 8 }}>组长视图</Tag>}
            </Title>
          </Col>
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
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 汇总卡片 */}
      {s && s.total_orders > 0 ? (
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
                pagination={{ pageSize: 50, showTotal: (t) => `共 ${t} 个商家`, showSizeChanger: true }}
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
