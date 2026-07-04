"use client";

/**
 * R-02 组长端 — 月度报表 Tab
 * 总计表（全员累计 + 平台聚合 + 每平台实收(CNY)手填[R-04.4] + 实际佣金自动汇总）
 * + 各组员单表（只读复用组件）
 */

import { useState, useEffect, useCallback } from "react";
import {
  Card, DatePicker, Button, Space, Spin, Empty, Tabs, Typography,
  InputNumber, Statistic, Row, Col, App, Table, Tooltip,
} from "antd";
import { DownloadOutlined, ReloadOutlined, EditOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import MonthlyReportTable from "@/components/MonthlyReportTable";
import type { MemberMonthlyReport, TeamMonthlySummary, TeamPlatformAgg } from "@/lib/monthly-report";

const { Text } = Typography;

type SummaryWithMembers = TeamMonthlySummary & { memberReports: MemberMonthlyReport[] };

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 每平台实收(CNY)可编辑格：手填优先，空则显示预估（灰）；点击编辑，↺ 恢复预估 */
function TeamCnyCell({
  manual,
  estimated,
  onSave,
}: {
  manual: number | null;
  estimated: number;
  onSave: (v: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(manual ?? estimated);
  const [saving, setSaving] = useState(false);

  if (editing) {
    return (
      <InputNumber
        autoFocus
        size="small"
        min={0}
        value={draft}
        disabled={saving}
        style={{ width: "100%" }}
        onChange={(v) => setDraft(v)}
        onPressEnter={async () => {
          setSaving(true);
          await onSave(draft ?? 0);
          setSaving(false);
          setEditing(false);
        }}
        onBlur={async () => {
          setSaving(true);
          await onSave(draft ?? 0);
          setSaving(false);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <Space size={4} style={{ cursor: "pointer" }} onClick={() => { setDraft(manual ?? estimated); setEditing(true); }}>
      {manual != null ? (
        <Tooltip title={`组长手填（预估 ¥${fmt(estimated)}），点击修改`}>
          <Text style={{ color: "#1677ff" }}>{fmt(manual)}</Text>
        </Tooltip>
      ) : (
        <Tooltip title="预估值（实收$×报表汇率），点击手填实际到账">
          <Text type="secondary">{fmt(estimated)}</Text>
        </Tooltip>
      )}
      <EditOutlined style={{ fontSize: 10, color: "#bbb" }} />
      {manual != null && (
        <Tooltip title="清除手填，恢复预估">
          <UndoOutlined
            style={{ fontSize: 10, color: "#faad14" }}
            onClick={async (e) => { e.stopPropagation(); await onSave(null); }}
          />
        </Tooltip>
      )}
    </Space>
  );
}

export default function MonthlyReportTab() {
  const { message } = App.useApp();
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [summary, setSummary] = useState<SummaryWithMembers | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const monthStr = month.format("YYYY-MM");

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/team/report/monthly-summary?month=${monthStr}`).then((r) => r.json());
      if (res.code === 0) {
        setSummary(res.data);
      } else {
        message.error(res.message || "加载失败");
      }
    } catch {
      message.error("加载失败");
    } finally {
      setLoading(false);
    }
  }, [monthStr, message]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  /** 保存每平台实收(CNY)手填（value=null 清除） */
  const savePlatCny = async (platform: string, half: "H1" | "H2", value: number | null) => {
    const res = await fetch("/api/user/team/report/actual-cny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month: monthStr, platform, half, value }),
    }).then((r) => r.json()).catch(() => null);
    if (res?.code === 0) {
      message.success(res.message || "已保存");
      fetchSummary();
    } else {
      message.error(res?.message || "保存失败");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const resp = await fetch(`/api/user/team/report/monthly-summary/export?month=${monthStr}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        message.error(err?.message || "导出失败");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `团队收支月报-${monthStr}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const rate = summary?.rate.usdToCny || 0;
  const estH = (usd: number) => (rate > 0 ? +(usd * rate).toFixed(2) : 0);

  const platformCols = [
    { title: "平台", dataIndex: "platform", key: "platform" },
    { title: "账面佣金($)", dataIndex: "book", key: "book", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "失效佣金($)", dataIndex: "rejected", key: "rejected", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "应收·上半月($)", dataIndex: "recvH1", key: "recvH1", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "应收·下半月($)", dataIndex: "recvH2", key: "recvH2", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "应收合计($)", dataIndex: "recvTotal", key: "recvTotal", align: "right" as const, render: (v: number) => <Text strong>${fmt(v)}</Text> },
    { title: "实收·上半月($)", dataIndex: "paidH1", key: "paidH1", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "实收·下半月($)", dataIndex: "paidH2", key: "paidH2", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "实收合计($)", dataIndex: "paidTotal", key: "paidTotal", align: "right" as const, render: (v: number) => <Text strong>${fmt(v)}</Text> },
    {
      title: <Tooltip title="实际到账人民币，组长手填；未填按报表汇率预估（灰字）">实收(¥)·上半月</Tooltip>,
      key: "paidCnyH1",
      align: "right" as const,
      render: (_: unknown, p: TeamPlatformAgg) => (
        <TeamCnyCell manual={p.paidCnyH1} estimated={estH(p.paidH1)} onSave={(v) => savePlatCny(p.platform, "H1", v)} />
      ),
    },
    {
      title: <Tooltip title="实际到账人民币，组长手填；未填按报表汇率预估（灰字）">实收(¥)·下半月</Tooltip>,
      key: "paidCnyH2",
      align: "right" as const,
      render: (_: unknown, p: TeamPlatformAgg) => (
        <TeamCnyCell manual={p.paidCnyH2} estimated={estH(p.paidH2)} onSave={(v) => savePlatCny(p.platform, "H2", v)} />
      ),
    },
    {
      title: "实收(¥)合计",
      key: "paidCnyTotal",
      align: "right" as const,
      render: (_: unknown, p: TeamPlatformAgg) => {
        const total = (p.paidCnyH1 ?? estH(p.paidH1)) + (p.paidCnyH2 ?? estH(p.paidH2));
        const hasManual = p.paidCnyH1 != null || p.paidCnyH2 != null;
        return <Text strong style={{ color: hasManual ? "#1677ff" : undefined }}>¥{fmt(total)}</Text>;
      },
    },
  ];

  const cnySummary = summary
    ? summary.platforms.reduce(
        (s, p) => {
          s.h1 += p.paidCnyH1 ?? estH(p.paidH1);
          s.h2 += p.paidCnyH2 ?? estH(p.paidH2);
          return s;
        },
        { h1: 0, h2: 0 },
      )
    : { h1: 0, h2: 0 };

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker
          picker="month"
          value={month}
          allowClear={false}
          onChange={(v) => v && setMonth(v)}
          disabledDate={(d) => d.isAfter(dayjs(), "month")}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchSummary} loading={loading}>刷新</Button>
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={handleExport}
          loading={exporting}
          disabled={!summary}
          style={{ background: "#217346", borderColor: "#217346" }}
        >
          导出 Excel（总计+全员单表）
        </Button>
        {summary && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            汇率 1 USD = {summary.rate.usdToCny.toFixed(4)} CNY（{summary.rate.date} {summary.rate.locked ? "月末锁定" : "实时"}）
          </Text>
        )}
      </Space>

      <Spin spinning={loading}>
        {!summary ? (
          !loading && <Empty description="暂无数据" />
        ) : (
          <Space direction="vertical" style={{ width: "100%" }} size={16}>
            {/* ── 汇总卡片 ── */}
            <Row gutter={[12, 12]}>
              {[
                { label: "广告费($)", value: `$${fmt(summary.adCostTotalUsd)}` },
                { label: "广告费(¥)", value: `¥${fmt(summary.adCostTotalCny)}` },
                { label: "核算广告费(¥)", value: `¥${fmt(summary.profitAdCostCny)}` },
                { label: "账面佣金($)", value: `$${fmt(summary.totals.book)}` },
                { label: "在投广告数", value: String(summary.enabledCampaigns) },
              ].map(({ label, value }) => (
                <Col key={label} xs={12} sm={8} md={4}>
                  <Card size="small" styles={{ body: { padding: "10px 14px" } }}>
                    <Statistic title={<Text style={{ fontSize: 12 }}>{label}</Text>} value={value} valueStyle={{ fontSize: 16 }} />
                  </Card>
                </Col>
              ))}
            </Row>

            {/* ── 实收佣金与可分配利润 ── */}
            <Card size="small" title="实收佣金与可分配利润">
              <Row gutter={[12, 12]} align="middle">
                <Col xs={12} sm={6}>
                  <Statistic title="实收佣金(USD) · 员工累计" value={summary.paidUsdTotal} precision={2} prefix="$" valueStyle={{ fontSize: 18 }} />
                </Col>
                <Col xs={12} sm={6}>
                  <Statistic
                    title={`预估实收(CNY) · 按${summary.rate.locked ? "月末" : "当日"}汇率`}
                    value={summary.estimatedPaidCny}
                    precision={2}
                    prefix="¥"
                    valueStyle={{ fontSize: 18 }}
                  />
                </Col>
                <Col xs={12} sm={6}>
                  <Statistic
                    title={
                      <Tooltip title="Σ每平台(手填实收¥ ?? 预估)。在下方总计表按平台手填实际到账人民币">
                        实际佣金(CNY) · 按平台手填汇总
                      </Tooltip>
                    }
                    value={summary.actualPaidCny != null ? summary.actualPaidCny : undefined}
                    precision={2}
                    prefix="¥"
                    valueStyle={{ fontSize: 18, color: summary.actualPaidCny != null ? "#1677ff" : "rgba(0,0,0,0.25)" }}
                    suffix={summary.actualPaidCny == null ? <Text type="secondary" style={{ fontSize: 12 }}>未填</Text> : undefined}
                  />
                </Col>
                <Col xs={12} sm={6}>
                  <Statistic
                    title={`可分配利润(CNY) = ${summary.actualPaidCny != null ? "实际佣金" : "预估实收"} − 核算广告费`}
                    value={summary.profitCny}
                    precision={2}
                    prefix="¥"
                    valueStyle={{ fontSize: 18, color: summary.profitCny >= 0 ? "#389e0d" : "#cf1322" }}
                  />
                </Col>
              </Row>
            </Card>

            {/* ── 平台聚合表 ── */}
            <Card size="small" title="总计表 · 按平台聚合（全员累计）— 实收(¥)列可点击手填">
              <Table<TeamPlatformAgg>
                columns={platformCols}
                dataSource={summary.platforms}
                rowKey="platform"
                size="small"
                pagination={false}
                bordered
                scroll={{ x: "max-content" }}
                summary={() => (
                  <Table.Summary.Row style={{ background: "#f6ffed", fontWeight: 600 }}>
                    <Table.Summary.Cell index={0}>合计</Table.Summary.Cell>
                    {(["book", "rejected", "recvH1", "recvH2", "recvTotal", "paidH1", "paidH2", "paidTotal"] as const).map((k, i) => (
                      <Table.Summary.Cell key={k} index={i + 1} align="right">${fmt(summary.totals[k])}</Table.Summary.Cell>
                    ))}
                    <Table.Summary.Cell index={9} align="right">¥{fmt(cnySummary.h1)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={10} align="right">¥{fmt(cnySummary.h2)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={11} align="right">¥{fmt(cnySummary.h1 + cnySummary.h2)}</Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
              />
            </Card>

            {/* ── 各组员单表（只读） ── */}
            <Card size="small" title="组员单月表">
              {summary.memberReports.length === 0 ? (
                <Empty description="本组暂无成员" />
              ) : (
                <Tabs
                  items={summary.memberReports.map((rep) => ({
                    key: rep.userId,
                    label: rep.displayName,
                    children: <MonthlyReportTable report={rep} editable={false} />,
                  }))}
                />
              )}
            </Card>
          </Space>
        )}
      </Spin>
    </div>
  );
}
