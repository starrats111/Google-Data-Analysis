"use client";

/**
 * D-041 / Policy Hub — Admin 政策违规看板
 *
 * 路径：/admin/policy-violations
 * 数据：/api/admin/policy-violations?days=30&page=1&pageSize=50&category=&policy_name=&user_id=
 */

import { useState, useEffect, useCallback } from "react";
import {
  Card, Table, Tag, Space, Select, Statistic, Row, Col, Typography, App, Button, Tooltip,
} from "antd";
import { ReloadOutlined, LinkOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import AppPageHeader from "@/components/AppPageHeader";

const { Text } = Typography;

interface SummaryStats {
  total: number;
  resolved: number;
  unresolved: number;
  days: number;
  severity_distribution: Array<{ severity: string; count: number }>;
  category_distribution: Array<{ category: string; count: number }>;
}

interface TopUser { user_id: string | null; username: string; count: number }
interface TopMerchant { user_merchant_id: string | null; merchant_name: string; merchant_url: string | null; count: number }
interface TopPolicy { policy_name: string; policy_label_zh: string; policy_category: string; policy_official_url: string; count: number }

interface ViolationRow {
  id: string;
  campaign_id: string | null;
  user_id: string | null;
  user_merchant_id: string | null;
  campaign_name: string | null;
  merchant_domain: string | null;
  country: string | null;
  policy_category: string;
  policy_subcategory: string;
  policy_label_zh: string;
  policy_official_url: string;
  policy_name: string;
  evidence_field: string;
  violating_text: string | null;
  severity: string;
  suggested_fix: string | null;
  is_exemptible: number;
  message: string | null;
  submitted_at: string;
  resolved_at: string | null;
}

interface ApiResult {
  summary: SummaryStats;
  top_users: TopUser[];
  top_merchants: TopMerchant[];
  top_policies: TopPolicy[];
  pagination: { page: number; pageSize: number; total: number };
  rows: ViolationRow[];
}

const CATEGORY_OPTIONS = [
  { value: "", label: "全部" },
  { value: "prohibited", label: "禁止内容" },
  { value: "prohibited_practices", label: "禁止做法" },
  { value: "restricted", label: "限制内容" },
  { value: "editorial_technical", label: "编辑/技术" },
  { value: "unknown", label: "未识别" },
];

const DAYS_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
];

const SEVERITY_COLOR: Record<string, string> = {
  critical: "red",
  warning: "orange",
  minor: "blue",
};

const CATEGORY_COLOR: Record<string, string> = {
  prohibited: "magenta",
  prohibited_practices: "volcano",
  restricted: "gold",
  editorial_technical: "cyan",
  unknown: "default",
};

export default function PolicyViolationsPage() {
  const { message } = App.useApp();
  const [data, setData] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState<number>(30);
  const [category, setCategory] = useState<string>("");
  const [policyName, setPolicyName] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        days: String(days),
        page: String(page),
        pageSize: String(pageSize),
      });
      if (category) params.set("category", category);
      if (policyName) params.set("policy_name", policyName);

      const res = await fetch(`/api/admin/policy-violations?${params.toString()}`).then((r) => r.json());
      if (res.code === 0) {
        setData(res.data);
      } else {
        message.error(res.message || "加载失败");
      }
    } catch (err) {
      message.error("网络错误");
      console.error(err);
    }
    setLoading(false);
  }, [days, category, policyName, page, pageSize, message]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const columns: ColumnsType<ViolationRow> = [
    {
      title: "时间",
      dataIndex: "submitted_at",
      key: "submitted_at",
      width: 150,
      render: (v: string) => new Date(v).toLocaleString("zh-CN", { hour12: false }),
    },
    {
      title: "广告系列",
      dataIndex: "campaign_name",
      key: "campaign_name",
      width: 220,
      ellipsis: true,
      render: (v: string, row) => (
        <Tooltip title={v || `campaign#${row.campaign_id}`}>
          <Text style={{ fontSize: 12 }}>{v || `campaign#${row.campaign_id}`}</Text>
        </Tooltip>
      ),
    },
    {
      title: "用户",
      dataIndex: "user_id",
      key: "user_id",
      width: 80,
      render: (v: string) => v ? <Tag>{`user#${v}`}</Tag> : "-",
    },
    {
      title: "商家域名",
      dataIndex: "merchant_domain",
      key: "merchant_domain",
      width: 160,
      ellipsis: true,
    },
    {
      title: "国家",
      dataIndex: "country",
      key: "country",
      width: 60,
    },
    {
      title: "政策大类",
      dataIndex: "policy_category",
      key: "policy_category",
      width: 110,
      render: (v: string) => <Tag color={CATEGORY_COLOR[v] || "default"}>{v}</Tag>,
    },
    {
      title: "违规规则",
      dataIndex: "policy_label_zh",
      key: "policy_label_zh",
      width: 170,
      render: (v: string, row) => (
        <Space size={4}>
          <Text strong style={{ fontSize: 12 }}>{v}</Text>
          {row.policy_official_url && (
            <a href={row.policy_official_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10 }}>
              <LinkOutlined />
            </a>
          )}
        </Space>
      ),
    },
    {
      title: "违规位置",
      dataIndex: "evidence_field",
      key: "evidence_field",
      width: 130,
    },
    {
      title: "违规文本",
      dataIndex: "violating_text",
      key: "violating_text",
      width: 200,
      ellipsis: true,
      render: (v: string) => v ? <Text code style={{ fontSize: 11 }}>{v}</Text> : "-",
    },
    {
      title: "严重度",
      dataIndex: "severity",
      key: "severity",
      width: 90,
      render: (v: string) => <Tag color={SEVERITY_COLOR[v] || "default"}>{v}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "resolved_at",
      key: "resolved_at",
      width: 90,
      render: (v: string | null) => v ? <Tag color="green">已修复</Tag> : <Tag color="red">未修复</Tag>,
    },
    {
      title: "修复建议",
      dataIndex: "suggested_fix",
      key: "suggested_fix",
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft">
          <Text style={{ fontSize: 12 }}>{v || "-"}</Text>
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <AppPageHeader
        title="Google Ads 政策违规看板"
        subtitle="D-041 / Policy Hub — 拒登事实表，4 大类 30+ 子项数据驱动分析"
      />

      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            value={days}
            options={DAYS_OPTIONS}
            onChange={(v) => { setPage(1); setDays(v); }}
            style={{ width: 120 }}
          />
          <Select
            value={category}
            options={CATEGORY_OPTIONS}
            onChange={(v) => { setPage(1); setCategory(v); }}
            style={{ width: 140 }}
          />
          <Select
            value={policyName}
            placeholder="筛选具体规则"
            allowClear
            options={(data?.top_policies || []).map((p) => ({ value: p.policy_name, label: `${p.policy_label_zh} (${p.count})` }))}
            onChange={(v) => { setPage(1); setPolicyName(v || ""); }}
            style={{ width: 240 }}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>刷新</Button>
        </Space>
      </Card>

      {data?.summary && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card>
              <Statistic title={`近 ${data.summary.days} 天拒登总数`} value={data.summary.total} />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic title="未修复" value={data.summary.unresolved} valueStyle={{ color: "#cf1322" }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic title="已修复" value={data.summary.resolved} valueStyle={{ color: "#3f8600" }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Space direction="vertical" size={2} style={{ width: "100%" }}>
                <Text type="secondary" style={{ fontSize: 12 }}>严重度分布</Text>
                {data.summary.severity_distribution.map((s) => (
                  <div key={s.severity}>
                    <Tag color={SEVERITY_COLOR[s.severity] || "default"}>{s.severity}</Tag>
                    <Text>{s.count}</Text>
                  </div>
                ))}
              </Space>
            </Card>
          </Col>
        </Row>
      )}

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card title="Top 10 违规用户" size="small">
            <Table
              size="small"
              pagination={false}
              dataSource={data?.top_users || []}
              rowKey={(r) => `${r.user_id}`}
              columns={[
                { title: "用户", dataIndex: "username", key: "username" },
                { title: "次数", dataIndex: "count", key: "count", width: 80, align: "right" },
              ]}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card title="Top 10 违规商家" size="small">
            <Table
              size="small"
              pagination={false}
              dataSource={data?.top_merchants || []}
              rowKey={(r) => `${r.user_merchant_id}`}
              columns={[
                {
                  title: "商家", dataIndex: "merchant_name", key: "merchant_name",
                  render: (v: string, row) => row.merchant_url
                    ? <a href={row.merchant_url} target="_blank" rel="noopener noreferrer">{v}</a>
                    : v,
                },
                { title: "次数", dataIndex: "count", key: "count", width: 80, align: "right" },
              ]}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card title="Top 10 违规规则" size="small">
            <Table
              size="small"
              pagination={false}
              dataSource={data?.top_policies || []}
              rowKey={(r) => r.policy_name}
              columns={[
                {
                  title: "规则", dataIndex: "policy_label_zh", key: "policy_label_zh",
                  render: (v: string, row) => (
                    <Space size={4}>
                      <Tag color={CATEGORY_COLOR[row.policy_category] || "default"}>{row.policy_category}</Tag>
                      <Text style={{ fontSize: 12 }}>{v}</Text>
                      {row.policy_official_url && (
                        <a href={row.policy_official_url} target="_blank" rel="noopener noreferrer">
                          <LinkOutlined />
                        </a>
                      )}
                    </Space>
                  ),
                },
                { title: "次数", dataIndex: "count", key: "count", width: 60, align: "right" },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card title={`违规明细（共 ${data?.pagination.total || 0} 条）`} size="small">
        <Table<ViolationRow>
          size="small"
          dataSource={data?.rows || []}
          rowKey="id"
          loading={loading}
          columns={columns}
          scroll={{ x: 1700 }}
          pagination={{
            current: page,
            pageSize,
            total: data?.pagination.total || 0,
            showSizeChanger: true,
            pageSizeOptions: ["20", "50", "100", "200"],
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
        />
      </Card>
    </div>
  );
}
