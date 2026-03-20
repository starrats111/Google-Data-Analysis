"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Modal, Table, Row, Col, Statistic, Typography, Spin, Tag, DatePicker, Space,
} from "antd";
import {
  DollarOutlined, RiseOutlined, FallOutlined, UserOutlined,
} from "@ant-design/icons";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = "Asia/Shanghai";

const { Text, Title } = Typography;
const { RangePicker } = DatePicker;

interface MemberDataModalProps {
  open: boolean;
  userId: string | null;
  username?: string;
  displayName?: string;
  onClose: () => void;
}

interface Summary {
  total_cost: number;
  total_commission: number;
  rejected_commission: number;
  net_commission: number;
  total_clicks: number;
  total_impressions: number;
  avg_cpc: number;
  roi: number;
  total_orders: number;
}

interface CampaignDetail {
  campaign_id: string;
  campaign_name: string;
  customer_id: string;
  status: string;
  cost: number;
  commission: number;
  rejected_commission: number;
  clicks: number;
  impressions: number;
  roi: number;
}

export default function MemberDataModal({ open, userId, username, displayName, onClose }: MemberDataModalProps) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignDetail[]>([]);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().tz(TZ).startOf("month"),
    dayjs().tz(TZ),
  ]);

  useEffect(() => {
    if (!open || !userId) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          userId,
          start_date: dateRange[0].format("YYYY-MM-DD"),
          end_date: dateRange[1].format("YYYY-MM-DD"),
        });
        const res = await fetch(`/api/user/team/member-data?${params}`).then((r) => r.json());
        if (res.code === 0) {
          setSummary(res.data.summary);
          setCampaigns(res.data.campaigns);
        }
      } catch (e) {
        console.error("加载组员数据失败:", e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [open, userId, dateRange]);

  const statusLabels: Record<string, string> = { ENABLED: "启用", PAUSED: "暂停", REMOVED: "移除", active: "启用", paused: "暂停" };
  const statusColors: Record<string, string> = { ENABLED: "green", PAUSED: "orange", REMOVED: "red", active: "green", paused: "orange" };

  const columns = useMemo(() => [
    {
      title: "广告系列", dataIndex: "campaign_name", width: 260,
      render: (v: string) => <Text style={{ fontSize: 12, wordBreak: "break-all" as const, whiteSpace: "normal" as const }}>{v}</Text>,
    },
    {
      title: "状态", dataIndex: "status", width: 70, align: "center" as const,
      render: (v: string) => <Tag color={statusColors[v] || "default"} style={{ fontSize: 11 }}>{statusLabels[v] || v}</Tag>,
    },
    {
      title: "花费", dataIndex: "cost", width: 90, align: "right" as const,
      sorter: (a: CampaignDetail, b: CampaignDetail) => a.cost - b.cost,
      render: (v: number) => <Text style={{ color: "#cf1322", fontSize: 12 }}>${v.toFixed(2)}</Text>,
    },
    {
      title: "佣金", dataIndex: "commission", width: 90, align: "right" as const,
      sorter: (a: CampaignDetail, b: CampaignDetail) => a.commission - b.commission,
      render: (v: number) => <Text style={{ color: "#389e0d", fontSize: 12 }}>${v.toFixed(2)}</Text>,
    },
    {
      title: "拒付", dataIndex: "rejected_commission", width: 80, align: "right" as const,
      render: (v: number) => <Text type={v > 0 ? "danger" : "secondary"} style={{ fontSize: 12 }}>${v.toFixed(2)}</Text>,
    },
    {
      title: "点击", dataIndex: "clicks", width: 60, align: "right" as const,
      render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: "ROI", dataIndex: "roi", width: 80, align: "right" as const,
      sorter: (a: CampaignDetail, b: CampaignDetail) => a.roi - b.roi,
      defaultSortOrder: "descend" as const,
      render: (v: number) => (
        <Tag color={v >= 20 ? "success" : v >= 0 ? "processing" : "error"} style={{ fontSize: 12 }}>
          {v >= 0 ? "+" : ""}{v.toFixed(1)}%
        </Tag>
      ),
    },
  ], []);

  const title = displayName ? `${displayName} (${username})` : username || "组员";

  return (
    <Modal
      title={<><UserOutlined style={{ marginRight: 8 }} />{title} — 数据看板</>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      destroyOnClose
    >
      <Space style={{ marginBottom: 16 }}>
        <Text>日期范围：</Text>
        <RangePicker
          value={dateRange}
          onChange={(v) => { if (v?.[0] && v?.[1]) setDateRange([v[0], v[1]]); }}
          size="small"
        />
      </Space>

      <Spin spinning={loading}>
        {summary && (
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            <Col span={4}>
              <Statistic title="总花费" value={summary.total_cost} prefix="$" precision={2}
                styles={{ content: { fontSize: 16, color: "#cf1322" } }} />
            </Col>
            <Col span={4}>
              <Statistic title="总佣金" value={summary.total_commission} prefix="$" precision={2}
                styles={{ content: { fontSize: 16, color: "#389e0d" } }} />
            </Col>
            <Col span={4}>
              <Statistic title="拒付佣金" value={summary.rejected_commission} prefix="$" precision={2}
                styles={{ content: { fontSize: 16, color: "#ff4d4f" } }} />
            </Col>
            <Col span={3}>
              <Statistic title="点击数" value={summary.total_clicks}
                styles={{ content: { fontSize: 16 } }} />
            </Col>
            <Col span={4}>
              <Statistic title="平均 CPC" value={summary.avg_cpc} prefix="$" precision={4}
                styles={{ content: { fontSize: 16 } }} />
            </Col>
            <Col span={5}>
              <Statistic title="ROI" value={summary.roi} suffix="%"
                prefix={summary.roi >= 0 ? <RiseOutlined /> : <FallOutlined />}
                precision={1}
                styles={{ content: { fontSize: 16, color: summary.roi >= 0 ? "#389e0d" : "#cf1322" } }} />
            </Col>
          </Row>
        )}

        <Table
          rowKey="campaign_id"
          dataSource={campaigns}
          columns={columns}
          size="small"
          scroll={{ y: 400 }}
          pagination={false}
          summary={() => {
            if (campaigns.length === 0) return null;
            const tCost = campaigns.reduce((s, c) => s + c.cost, 0);
            const tComm = campaigns.reduce((s, c) => s + c.commission, 0);
            const tRej = campaigns.reduce((s, c) => s + c.rejected_commission, 0);
            const tClicks = campaigns.reduce((s, c) => s + c.clicks, 0);
            return (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={1} />
                  <Table.Summary.Cell index={2} align="right"><Text strong style={{ color: "#cf1322" }}>${tCost.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right"><Text strong style={{ color: "#389e0d" }}>${tComm.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right"><Text strong type="danger">${tRej.toFixed(2)}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right"><Text strong>{tClicks}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell index={6} />
                </Table.Summary.Row>
              </Table.Summary>
            );
          }}
        />
      </Spin>
    </Modal>
  );
}
