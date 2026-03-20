"use client";

import { useState } from "react";
import {
  Card, Input, Button, Row, Col, Statistic, Table, Segmented, Space, Typography, Empty, Progress,
} from "antd";
import {
  SearchOutlined, AccountBookOutlined, CheckCircleOutlined,
  CloseCircleOutlined, DollarOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { COLORS } from "@/styles/themeConfig";

const { Title, Text } = Typography;

interface Summary {
  total_commission: number;
  approved_commission: number;
  rejected_commission: number;
  paid_commission: number;
  pending_commission: number;
  total_orders: number;
  approval_rate: number;
  rejection_rate: number;
  settlement_rate: number;
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

interface SettlementData {
  mid: string;
  merchant_name: string;
  platform: string;
  summary: Summary;
  monthly: MonthlyRow[];
}

const RANGE_OPTIONS = [
  { label: "1个月", value: "1m" },
  { label: "3个月", value: "3m" },
  { label: "半年", value: "6m" },
  { label: "全年", value: "1y" },
];

export default function SettlementPage() {
  const [mid, setMid] = useState("");
  const [range, setRange] = useState<string>("1m");
  const [data, setData] = useState<SettlementData | null>(null);
  const [loading, setLoading] = useState(false);

  const doSearch = async () => {
    if (!mid.trim()) return;
    setLoading(true);
    const params = new URLSearchParams({ mid: mid.trim(), range });
    const res = await fetch(`/api/user/data-center/settlement?${params}`).then((r) => r.json());
    if (res.code === 0) setData(res.data);
    else setData(null);
    setLoading(false);
  };

  const monthlyColumns: ColumnsType<MonthlyRow> = [
    { title: "月份", dataIndex: "month", key: "month", width: 100 },
    {
      title: "总佣金($)", dataIndex: "total", key: "total", width: 120,
      render: (v: number) => `$${v.toFixed(2)}`,
      sorter: (a, b) => a.total - b.total,
    },
    {
      title: "已确认($)", dataIndex: "approved", key: "approved", width: 120,
      render: (v: number) => <span style={{ color: COLORS.successGreen }}>${v.toFixed(2)}</span>,
    },
    {
      title: "已支付($)", dataIndex: "paid", key: "paid", width: 120,
      render: (v: number) => <span style={{ color: "#1890ff" }}>${v.toFixed(2)}</span>,
    },
    {
      title: "拒付($)", dataIndex: "rejected", key: "rejected", width: 120,
      render: (v: number) => (
        <span style={{ color: v > 0 ? "#cf1322" : undefined, fontWeight: v > 0 ? 600 : 400 }}>
          ${v.toFixed(2)}
        </span>
      ),
    },
    {
      title: "待审核($)", dataIndex: "pending", key: "pending", width: 120,
      render: (v: number) => <span style={{ color: "#faad14" }}>${v.toFixed(2)}</span>,
    },
    { title: "订单数", dataIndex: "orders", key: "orders", width: 90 },
  ];

  const s = data?.summary;

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <Title level={5} style={{ margin: 0 }}><AccountBookOutlined /> 结算查询</Title>
          <Space size={12}>
            <Input
              placeholder="输入商家 MID"
              prefix={<SearchOutlined />}
              style={{ width: 200 }}
              value={mid}
              onChange={(e) => setMid(e.target.value)}
              onPressEnter={doSearch}
            />
            <Segmented
              value={range}
              onChange={(v) => setRange(v as string)}
              options={RANGE_OPTIONS}
            />
            <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={doSearch}>
              查询
            </Button>
          </Space>
        </div>
      </Card>

      {!data ? (
        <Card style={{ textAlign: "center", padding: "60px 0" }}>
          <Empty
            image={<AccountBookOutlined style={{ fontSize: 48, color: COLORS.primary }} />}
            description={
              <Space orientation="vertical" size={4}>
                <Text style={{ fontSize: 16 }}>输入商家 MID 查询结算情况</Text>
                <Text type="secondary">支持查询最近1个月、3个月、半年、全年的结算数据</Text>
              </Space>
            }
          />
        </Card>
      ) : (
        <>
          {/* 商家信息 */}
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space size={24}>
              <Text strong>商家：{data.merchant_name}</Text>
              <Text type="secondary">MID：{data.mid}</Text>
              {data.platform && <Text type="secondary">平台：{data.platform}</Text>}
            </Space>
          </Card>

          {/* 佣金汇总 */}
          {s && (
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              <Col xs={12} sm={8} md={4}>
                <Card size="small">
                  <Statistic title="总佣金" value={s.total_commission} prefix="$" precision={2} />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small">
                  <Statistic title="已确认" value={s.approved_commission} prefix="$" precision={2} styles={{ content: { color: COLORS.successGreen } }} />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small">
                  <Statistic title="已支付" value={s.paid_commission} prefix="$" precision={2} styles={{ content: { color: "#1890ff" } }} />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small">
                  <Statistic title="拒付" value={s.rejected_commission} prefix="$" precision={2} styles={{ content: { color: "#cf1322" } }} />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small">
                  <Statistic title="待审核" value={s.pending_commission} prefix="$" precision={2} styles={{ content: { color: "#faad14" } }} />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small">
                  <Statistic title="总订单" value={s.total_orders} />
                </Card>
              </Col>
            </Row>
          )}

          {/* 三率 */}
          {s && (
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <div style={{ textAlign: "center" }}>
                    <Text type="secondary" style={{ fontSize: 13 }}>确认率</Text>
                    <Progress
                      type="dashboard"
                      percent={s.approval_rate}
                      size={100}
                      strokeColor={COLORS.successGreen}
                      format={(p) => `${p}%`}
                    />
                    <div style={{ fontSize: 12, color: "#999" }}>
                      approved 佣金 / 全部佣金
                    </div>
                  </div>
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <div style={{ textAlign: "center" }}>
                    <Text type="secondary" style={{ fontSize: 13 }}>拒付率</Text>
                    <Progress
                      type="dashboard"
                      percent={s.rejection_rate}
                      size={100}
                      strokeColor="#cf1322"
                      format={(p) => `${p}%`}
                    />
                    <div style={{ fontSize: 12, color: "#999" }}>
                      rejected 佣金 / 全部佣金
                    </div>
                  </div>
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card size="small">
                  <div style={{ textAlign: "center" }}>
                    <Text type="secondary" style={{ fontSize: 13 }}>结算率</Text>
                    <Progress
                      type="dashboard"
                      percent={s.settlement_rate}
                      size={100}
                      strokeColor="#1890ff"
                      format={(p) => `${p}%`}
                    />
                    <div style={{ fontSize: 12, color: "#999" }}>
                      paid 佣金 / 全部佣金
                    </div>
                  </div>
                </Card>
              </Col>
            </Row>
          )}

          {/* 按月明细 */}
          <Card title="按月明细">
            <Table<MonthlyRow>
              columns={monthlyColumns}
              dataSource={data.monthly}
              rowKey="month"
              size="small"
              pagination={false}
            />
          </Card>
        </>
      )}
    </div>
  );
}
