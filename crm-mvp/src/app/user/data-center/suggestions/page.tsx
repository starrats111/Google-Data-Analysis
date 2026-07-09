"use client";

/**
 * AI 建议（批次6）：ad_decision_journal 决策建议列表 + 准确率闭环
 *
 * 每天 analyze-campaigns cron 按近 7 天表现给每个在投系列生成一条建议；
 * 3/7 天后 track-outcomes cron 回填实际走势并评判建议对错（verdict）。
 * 本页展示建议、依据快照与回验结果，帮助判断规则建议是否值得采纳。
 */

import { useState } from "react";
import { Card, Table, Tag, Typography, Space, Select, Statistic, Row, Col, Tooltip, Empty } from "antd";
import { BulbOutlined } from "@ant-design/icons";
import { useApiWithParams } from "@/lib/swr";

const { Text, Title } = Typography;

interface JournalRow {
  id: string;
  decision_id: string;
  campaign_id: string;
  campaign_name: string;
  snapshot_json: {
    spend?: number; commission?: number; roi?: number;
    clicks?: number; orders?: number; daysRunning?: number; dailyBudget?: number;
  } | null;
  action_type: string;
  magnitude: string | null;
  reasoning: string | null;
  outcome_3d: { spend?: number; commission?: number; roi?: number; orders?: number } | null;
  outcome_7d: { spend?: number; commission?: number; roi?: number; orders?: number } | null;
  verdict: string | null;
  created_at: string;
}

interface JournalData {
  list: JournalRow[];
  total: number;
  summary: {
    correct?: number; partial?: number; wrong?: number; no_data?: number;
    judged: number; accuracy: number | null;
  };
}

const ACTION_META: Record<string, { label: string; color: string }> = {
  pause: { label: "建议暂停", color: "red" },
  decrease_budget: { label: "建议减预算", color: "orange" },
  increase_budget: { label: "建议加预算", color: "green" },
  keep: { label: "维持现状", color: "blue" },
  observe: { label: "继续观察", color: "default" },
};

const VERDICT_META: Record<string, { label: string; color: string }> = {
  correct: { label: "建议正确", color: "green" },
  partial: { label: "部分正确", color: "gold" },
  wrong: { label: "建议错误", color: "red" },
  no_data: { label: "无后续数据", color: "default" },
};

function fmtMoney(v?: number): string {
  return `$${Number(v ?? 0).toFixed(2)}`;
}

function OutcomeCell({ o }: { o: JournalRow["outcome_3d"] }) {
  if (!o) return <Text type="secondary">待回验</Text>;
  const roi = Number(o.roi ?? 0);
  return (
    <Tooltip title={`花费 ${fmtMoney(o.spend)} · 佣金 ${fmtMoney(o.commission)} · 订单 ${o.orders ?? 0}`}>
      <Text style={{ color: roi >= 0 ? "#389e0d" : "#cf1322" }}>ROI {roi}%</Text>
    </Tooltip>
  );
}

export default function SuggestionsPage() {
  const [page, setPage] = useState(1);
  const [actionType, setActionType] = useState<string>("");
  const [verdict, setVerdict] = useState<string>("");
  const pageSize = 20;

  const { data, isLoading } = useApiWithParams<JournalData>(
    "/api/user/decision-journal",
    {
      page: String(page),
      pageSize: String(pageSize),
      ...(actionType ? { action_type: actionType } : {}),
      ...(verdict ? { verdict } : {}),
    },
  );

  const list = data?.list || [];
  const summary = data?.summary;

  const columns = [
    {
      title: "日期",
      dataIndex: "created_at",
      width: 100,
      render: (v: string) => v?.slice(0, 10),
    },
    {
      title: "广告系列",
      dataIndex: "campaign_name",
      ellipsis: true,
    },
    {
      title: "建议",
      dataIndex: "action_type",
      width: 130,
      render: (v: string, row: JournalRow) => {
        const meta = ACTION_META[v] || { label: v, color: "default" };
        return (
          <Tag color={meta.color}>
            {meta.label}{row.magnitude ? ` ${row.magnitude}` : ""}
          </Tag>
        );
      },
    },
    {
      title: "建议依据（近7天）",
      dataIndex: "snapshot_json",
      width: 200,
      render: (s: JournalRow["snapshot_json"]) => s ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          花费 {fmtMoney(s.spend)} · 佣金 {fmtMoney(s.commission)} · ROI {s.roi ?? 0}%
        </Text>
      ) : "-",
    },
    {
      title: "理由",
      dataIndex: "reasoning",
      ellipsis: { showTitle: false },
      render: (v: string | null) => v ? <Tooltip title={v}><Text style={{ fontSize: 12 }}>{v}</Text></Tooltip> : "-",
    },
    {
      title: "3天后",
      dataIndex: "outcome_3d",
      width: 100,
      render: (o: JournalRow["outcome_3d"]) => <OutcomeCell o={o} />,
    },
    {
      title: "7天后",
      dataIndex: "outcome_7d",
      width: 100,
      render: (o: JournalRow["outcome_7d"]) => <OutcomeCell o={o} />,
    },
    {
      title: "评判",
      dataIndex: "verdict",
      width: 110,
      render: (v: string | null) => {
        if (!v) return <Text type="secondary">-</Text>;
        const meta = VERDICT_META[v] || { label: v, color: "default" };
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Title level={4} style={{ marginBottom: 4 }}>
        <BulbOutlined style={{ marginRight: 8 }} />AI 建议
      </Title>
      <Text type="secondary">
        每日 07:30 按近 7 天表现自动生成投放建议；3/7 天后回验实际走势并评判建议对错。建议仅供参考，不会自动执行。
      </Text>

      {summary && summary.judged > 0 && (
        <Card size="small" style={{ marginTop: 16 }}>
          <Row gutter={32}>
            <Col><Statistic title="建议准确率" value={summary.accuracy ?? 0} suffix="%" /></Col>
            <Col><Statistic title="已回验" value={summary.judged} /></Col>
            <Col><Statistic title="正确" value={summary.correct ?? 0} valueStyle={{ color: "#389e0d" }} /></Col>
            <Col><Statistic title="部分正确" value={summary.partial ?? 0} valueStyle={{ color: "#d4b106" }} /></Col>
            <Col><Statistic title="错误" value={summary.wrong ?? 0} valueStyle={{ color: "#cf1322" }} /></Col>
          </Row>
        </Card>
      )}

      <Card size="small" style={{ marginTop: 16 }}>
        <Space style={{ marginBottom: 12 }}>
          <Select
            placeholder="建议类型"
            allowClear
            style={{ width: 150 }}
            value={actionType || undefined}
            onChange={(v) => { setActionType(v || ""); setPage(1); }}
            options={Object.entries(ACTION_META).map(([k, m]) => ({ value: k, label: m.label }))}
          />
          <Select
            placeholder="评判结果"
            allowClear
            style={{ width: 150 }}
            value={verdict || undefined}
            onChange={(v) => { setVerdict(v || ""); setPage(1); }}
            options={Object.entries(VERDICT_META).map(([k, m]) => ({ value: k, label: m.label }))}
          />
        </Space>

        <Table
          rowKey="id"
          size="small"
          loading={isLoading}
          columns={columns}
          dataSource={list}
          locale={{ emptyText: <Empty description="暂无建议，每日 07:30 自动生成" /> }}
          pagination={{
            current: page,
            pageSize,
            total: data?.total || 0,
            onChange: setPage,
            showTotal: (t) => `共 ${t} 条建议`,
          }}
        />
      </Card>
    </div>
  );
}
