"use client";

/**
 * R-02 组长端 — 月度报表 Tab
 * 总计表（全员累计 + 平台聚合 + 实收 3 列 + 实际佣金手填）+ 各组员单表（只读复用组件）
 */

import { useState, useEffect, useCallback } from "react";
import {
  Card, DatePicker, Button, Space, Spin, Empty, Tabs, Typography,
  InputNumber, Statistic, Row, Col, App, Table, Tooltip,
} from "antd";
import { DownloadOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import MonthlyReportTable from "@/components/MonthlyReportTable";
import type { MemberMonthlyReport, TeamMonthlySummary, TeamPlatformAgg } from "@/lib/monthly-report";

const { Text } = Typography;

type SummaryWithMembers = TeamMonthlySummary & { memberReports: MemberMonthlyReport[] };

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function MonthlyReportTab() {
  const { message } = App.useApp();
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [summary, setSummary] = useState<SummaryWithMembers | null>(null);
  const [loading, setLoading] = useState(false);
  const [actualDraft, setActualDraft] = useState<number | null>(null);
  const [savingActual, setSavingActual] = useState(false);
  const [exporting, setExporting] = useState(false);

  const monthStr = month.format("YYYY-MM");

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/team/report/monthly-summary?month=${monthStr}`).then((r) => r.json());
      if (res.code === 0) {
        setSummary(res.data);
        setActualDraft(res.data.actualPaidCny);
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

  const saveActual = async (value: number | null) => {
    setSavingActual(true);
    const res = await fetch("/api/user/team/report/actual-cny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month: monthStr, value }),
    }).then((r) => r.json()).catch(() => null);
    setSavingActual(false);
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

  const platformCols = [
    { title: "平台", dataIndex: "platform", key: "platform" },
    { title: "账面佣金($)", dataIndex: "book", key: "book", align: "right" as const, render: fmt },
    { title: "失效佣金($)", dataIndex: "rejected", key: "rejected", align: "right" as const, render: fmt },
    { title: "应收·上半月", dataIndex: "recvH1", key: "recvH1", align: "right" as const, render: fmt },
    { title: "应收·下半月", dataIndex: "recvH2", key: "recvH2", align: "right" as const, render: fmt },
    { title: "应收合计", dataIndex: "recvTotal", key: "recvTotal", align: "right" as const, render: (v: number) => <Text strong>{fmt(v)}</Text> },
    { title: "实收·上半月", dataIndex: "paidH1", key: "paidH1", align: "right" as const, render: fmt },
    { title: "实收·下半月", dataIndex: "paidH2", key: "paidH2", align: "right" as const, render: fmt },
    { title: "实收合计", dataIndex: "paidTotal", key: "paidTotal", align: "right" as const, render: (v: number) => <Text strong>{fmt(v)}</Text> },
  ];

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

            {/* ── 实收 3 列 + 实际佣金手填 + 可分配利润 ── */}
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
                  <div style={{ fontSize: 12, color: "rgba(0,0,0,0.45)", marginBottom: 4 }}>实际佣金(CNY) · 组长手填</div>
                  <Space.Compact>
                    <InputNumber
                      min={0}
                      value={actualDraft}
                      onChange={(v) => setActualDraft(v)}
                      style={{ width: 140 }}
                      prefix="¥"
                      placeholder="未填"
                    />
                    <Button icon={<SaveOutlined />} loading={savingActual} onClick={() => saveActual(actualDraft)} />
                    {summary.actualPaidCny != null && (
                      <Tooltip title="清除手填，回退预估值">
                        <Button icon={<UndoOutlined />} onClick={() => saveActual(null)} />
                      </Tooltip>
                    )}
                  </Space.Compact>
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
            <Card size="small" title="总计表 · 按平台聚合（全员累计）">
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
                      <Table.Summary.Cell key={k} index={i + 1} align="right">{fmt(summary.totals[k])}</Table.Summary.Cell>
                    ))}
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
