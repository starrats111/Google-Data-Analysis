"use client";

/**
 * R-02 组员端 — 结算报表
 * 月报 Tab：单月收支统计表（类 Excel 预览 + 广告费/实收内联编辑 + xlsx 导出）
 * 年度 Tab：个人年度报表（逐月合计，不分上下半月 + xlsx 导出）
 */

import { useState, useEffect, useCallback } from "react";
import { Card, DatePicker, Button, Space, Spin, Empty, App, Tabs, Table, Typography, Alert } from "antd";
import { AccountBookOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import AppPageHeader from "@/components/AppPageHeader";
import MonthlyReportTable from "@/components/MonthlyReportTable";
import type { MemberMonthlyReport, MemberAnnualReport, MemberAnnualMonth } from "@/lib/monthly-report";

const { Text } = Typography;

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function MonthlyTab() {
  const { message } = App.useApp();
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [report, setReport] = useState<MemberMonthlyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const monthStr = month.format("YYYY-MM");

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/report/monthly?month=${monthStr}`).then((r) => r.json());
      if (res.code === 0) setReport(res.data);
      else message.error(res.message || "加载失败");
    } catch {
      message.error("加载失败");
    } finally {
      setLoading(false);
    }
  }, [monthStr, message]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const handleOverride = async (scopeKey: string, value: number | null) => {
    const res = await fetch("/api/user/report/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month: monthStr, scope_key: scopeKey, value }),
    }).then((r) => r.json()).catch(() => null);
    if (res?.code === 0) {
      message.success(res.message || "已保存");
      fetchReport();
    } else {
      message.error(res?.message || "保存失败");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const resp = await fetch(`/api/user/report/monthly/export?month=${monthStr}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        message.error(err?.message || "导出失败");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `收支统计-${monthStr}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

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
        <Button icon={<ReloadOutlined />} onClick={fetchReport} loading={loading}>刷新</Button>
        <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport} loading={exporting}>
          导出 Excel
        </Button>
      </Space>
      <Spin spinning={loading}>
        {report ? (
          <MonthlyReportTable report={report} editable onOverride={handleOverride} />
        ) : (
          !loading && <Empty description="暂无数据" />
        )}
      </Spin>
    </div>
  );
}

function AnnualTab() {
  const { message } = App.useApp();
  const [year, setYear] = useState<Dayjs>(dayjs());
  const [report, setReport] = useState<MemberAnnualReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const yearNum = year.year();

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/report/annual?year=${yearNum}`).then((r) => r.json());
      if (res.code === 0) setReport(res.data);
      else message.error(res.message || "加载失败");
    } catch {
      message.error("加载失败");
    } finally {
      setLoading(false);
    }
  }, [yearNum, message]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const resp = await fetch(`/api/user/report/annual/export?year=${yearNum}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        message.error(err?.message || "导出失败");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `个人年度收支-${yearNum}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    { title: "月份", dataIndex: "month", key: "month", render: (v: string) => `${parseInt(v.slice(5), 10)}月` },
    { title: "广告费($)", dataIndex: "adUsd", key: "adUsd", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "广告费(¥)", dataIndex: "adCny", key: "adCny", align: "right" as const, render: (v: number) => `¥${fmt(v)}` },
    { title: "核算广告费($)", dataIndex: "profitAdCostUsd", key: "profitAdCostUsd", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "账面佣金($)", dataIndex: "book", key: "book", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "失效佣金($)", dataIndex: "rejected", key: "rejected", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "应收佣金($)", dataIndex: "recvTotal", key: "recvTotal", align: "right" as const, render: (v: number) => `$${fmt(v)}` },
    { title: "实收佣金($)", dataIndex: "paidTotal", key: "paidTotal", align: "right" as const, render: (v: number) => <Text strong>${fmt(v)}</Text> },
    { title: "实收佣金(¥)", dataIndex: "paidCnyTotal", key: "paidCnyTotal", align: "right" as const, render: (v: number) => <Text strong>¥{fmt(v)}</Text> },
    { title: "可分配利润($)", dataIndex: "profitUsd", key: "profitUsd", align: "right" as const, render: (v: number) => <Text strong style={{ color: v >= 0 ? "#389e0d" : "#cf1322" }}>${fmt(v)}</Text> },
    { title: "可分配利润(¥)", dataIndex: "profitCny", key: "profitCny", align: "right" as const, render: (v: number) => <Text strong style={{ color: v >= 0 ? "#389e0d" : "#cf1322" }}>¥{fmt(v)}</Text> },
    { title: "汇率", key: "rate", render: (_: unknown, m: MemberAnnualMonth) => <Text type="secondary" style={{ fontSize: 11 }}>{m.rate.usdToCny.toFixed(4)}（{m.rate.date}{m.rate.locked ? "" : " 实时"}）</Text> },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker
          picker="year"
          value={year}
          allowClear={false}
          onChange={(v) => v && setYear(v)}
          disabledDate={(d) => d.isAfter(dayjs(), "year")}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchReport} loading={loading}>刷新</Button>
        <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport} loading={exporting} disabled={!report}>
          导出 Excel
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>逐月合计（不分上下半月）；实收(¥)默认按打款日汇率逐笔折算，含手填纠正</Text>
      </Space>
      <Spin spinning={loading}>
        {!report ? (
          !loading && <Empty description="暂无数据" />
        ) : (
          <>
            {report.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={<div>{report.warnings.map((w, i) => <div key={i} style={{ fontSize: 12 }}>{w}</div>)}</div>}
              />
            )}
            <Table<MemberAnnualMonth>
              columns={columns}
              dataSource={report.months}
              rowKey="month"
              size="small"
              pagination={false}
              bordered
              scroll={{ x: "max-content" }}
              summary={() => (
                <Table.Summary.Row style={{ background: "#f6ffed", fontWeight: 600 }}>
                  <Table.Summary.Cell index={0}>年合计</Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">${fmt(report.totals.adUsd)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">¥{fmt(report.totals.adCny)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">${fmt(report.totals.profitAdCostUsd)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">${fmt(report.totals.book)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">${fmt(report.totals.rejected)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right">${fmt(report.totals.recvTotal)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={7} align="right">${fmt(report.totals.paidTotal)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={8} align="right">¥{fmt(report.totals.paidCnyTotal)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={9} align="right">${fmt(report.totals.profitUsd)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={10} align="right">¥{fmt(report.totals.profitCny)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={11}></Table.Summary.Cell>
                </Table.Summary.Row>
              )}
            />
          </>
        )}
      </Spin>
    </div>
  );
}

export default function SettlementReportPage() {
  return (
    <div>
      <AppPageHeader
        icon={<AccountBookOutlined />}
        title="结算报表"
        subtitle="月报可手工纠正广告费与实收佣金（USD/CNY），改动实时对组长可见；年度报表逐月汇总"
      />
      <Card size="small">
        <Tabs
          items={[
            { key: "monthly", label: "月度报表", children: <MonthlyTab /> },
            { key: "annual", label: "年度报表", children: <AnnualTab /> },
          ]}
        />
      </Card>
    </div>
  );
}
