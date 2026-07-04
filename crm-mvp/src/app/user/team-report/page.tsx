"use client";

/**
 * 组长收支报表 — 年度总览（R-04.2 新口径整年视图）/ 月度报表 双 Tab
 *
 * 年度总览：整年 12 个月 × 新样式指标（账面/失效/应收/实收/广告费$¥/核算¥/实际¥/利润¥），
 * 数据走 /api/user/team/report/annual-v2（与月度报表同口径，含手工纠正与手填）。
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card, Select, Button, Table, Typography, Space, Tabs, Spin, Empty,
  Statistic, Row, Col, Tooltip, App,
} from "antd";
import {
  FileExcelOutlined, ReloadOutlined, BarChartOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import AppPageHeader from "@/components/AppPageHeader";
import MonthlyReportTab from "./MonthlyReportTab";
import type { TeamAnnualReport, AnnualMonthAgg } from "@/lib/monthly-report";

const { Text } = Typography;
const { Option } = Select;

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function monthLabel(m: string): string {
  return m.slice(5).replace(/^0/, "") + "月";
}

// ────────── 年度总览 Tab（R-04.2 新样式） ──────────────────────────────────────
function AnnualReportTab() {
  const { message } = App.useApp();
  const [year, setYear] = useState<number>(dayjs().year());
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<TeamAnnualReport | null>(null);
  const [exporting, setExporting] = useState(false);

  const yearOptions = useMemo(() => {
    const cur = dayjs().year();
    return Array.from({ length: 5 }, (_, i) => cur - i);
  }, []);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/user/team/report/annual-v2?year=${year}`).then((r) => r.json());
      if (res.code === 0) setReport(res.data);
      else message.error(res.message || "获取报表失败");
    } catch {
      message.error("网络错误");
    } finally {
      setLoading(false);
    }
  }, [year, message]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const handleExport = useCallback(async () => {
    if (!report) return;
    setExporting(true);
    try {
      const resp = await fetch(`/api/user/team/report/annual-v2/export?year=${year}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        message.error(err?.message || "导出失败");
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${year}年度收支报表.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      message.success("Excel 已导出");
    } finally {
      setExporting(false);
    }
  }, [report, year, message]);

  const columns: ColumnsType<AnnualMonthAgg> = [
    {
      title: "月份", dataIndex: "month", key: "month", fixed: "left", width: 70,
      render: (m: string, row) => (
        <Tooltip title={`汇率 1USD=${row.rate.usdToCny.toFixed(4)}CNY（${row.rate.date}${row.rate.locked ? " 月末锁定" : " 实时"}）`}>
          <Text strong>{monthLabel(m)}</Text>
        </Tooltip>
      ),
    },
    { title: "广告费($)", dataIndex: "adUsd", key: "adUsd", align: "right", render: (v: number) => `$${fmt(v)}` },
    { title: "广告费(¥)", dataIndex: "adCny", key: "adCny", align: "right", render: (v: number) => `¥${fmt(v)}` },
    {
      title: <Tooltip title="美金广告费按当月报表汇率折人民币 + 人民币广告费累计">核算广告费(¥)</Tooltip>,
      dataIndex: "profitAdCostCny", key: "profitAdCostCny", align: "right",
      render: (v: number) => `¥${fmt(v)}`,
    },
    { title: "账面佣金($)", dataIndex: "book", key: "book", align: "right", render: (v: number) => <Text style={{ color: "#1677ff" }}>${fmt(v)}</Text> },
    { title: "失效佣金($)", dataIndex: "rejected", key: "rejected", align: "right", render: (v: number) => <Text type={v > 0 ? "danger" : undefined}>${fmt(v)}</Text> },
    { title: "应收佣金($)", dataIndex: "recvTotal", key: "recvTotal", align: "right", render: (v: number) => `$${fmt(v)}` },
    { title: "实收佣金($)", dataIndex: "paidTotal", key: "paidTotal", align: "right", render: (v: number) => <Text strong>${fmt(v)}</Text> },
    { title: "预估实收(¥)", dataIndex: "estPaidCny", key: "estPaidCny", align: "right", render: (v: number) => `¥${fmt(v)}` },
    {
      title: <Tooltip title="组长在月度报表按平台手填的实际到账汇总；未填月份显示 —">实际佣金(¥)</Tooltip>,
      dataIndex: "actualPaidCny", key: "actualPaidCny", align: "right",
      render: (v: number | null) => (v != null ? <Text style={{ color: "#1677ff" }}>¥{fmt(v)}</Text> : <Text type="secondary">—</Text>),
    },
    {
      title: <Tooltip title="（实际佣金 ?? 预估实收）− 核算广告费">可分配利润(¥)</Tooltip>,
      dataIndex: "profitCny", key: "profitCny", align: "right",
      render: (v: number) => <Text strong style={{ color: v >= 0 ? "#389e0d" : "#cf1322" }}>¥{fmt(v)}</Text>,
    },
  ];

  return (
    <div style={{ padding: "16px 24px" }}>
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <AppPageHeader
          icon={<BarChartOutlined />}
          title="团队收支报表（整年）"
          marginBottom={0}
          extra={
            <Space>
              <Select value={year} onChange={(v) => setYear(v)} style={{ width: 100 }}>
                {yearOptions.map((y) => <Option key={y} value={y}>{y}年</Option>)}
              </Select>
              <Button icon={<ReloadOutlined />} onClick={fetchReport} loading={loading}>刷新</Button>
              <Button
                type="primary"
                icon={<FileExcelOutlined />}
                onClick={handleExport}
                disabled={!report}
                loading={exporting}
                style={{ background: "#217346", borderColor: "#217346" }}
              >
                导出 Excel
              </Button>
            </Space>
          }
        />

        {/* 年度汇总卡片 */}
        {report && (
          <Row gutter={[12, 12]}>
            {[
              { label: "广告费($)", value: `$${fmt(report.totals.adUsd)}`, color: "#595959" },
              { label: "广告费(¥)", value: `¥${fmt(report.totals.adCny)}`, color: "#595959" },
              { label: "核算广告费(¥)", value: `¥${fmt(report.totals.profitAdCostCny)}`, color: "#595959" },
              { label: "账面佣金($)", value: `$${fmt(report.totals.book)}`, color: "#1677ff" },
              { label: "实收佣金($)", value: `$${fmt(report.totals.paidTotal)}`, color: "#389e0d" },
              { label: "可分配利润(¥)", value: `¥${fmt(report.totals.profitCny)}`, color: report.totals.profitCny >= 0 ? "#fa8c16" : "#cf1322" },
            ].map(({ label, value, color }) => (
              <Col key={label} xs={12} sm={8} md={4}>
                <Card size="small" styles={{ body: { padding: "10px 14px" } }}>
                  <Statistic
                    title={<Text style={{ fontSize: 12 }}>{label}</Text>}
                    value={value}
                    valueStyle={{ fontSize: 16, color }}
                  />
                </Card>
              </Col>
            ))}
          </Row>
        )}

        {/* 整年 12 个月新样式表 */}
        <Card size="small">
          {loading ? (
            <div style={{ textAlign: "center", padding: 40 }}><Spin /></div>
          ) : !report ? (
            <Empty description="暂无数据" />
          ) : (
            <Table<AnnualMonthAgg>
              columns={columns}
              dataSource={report.months}
              rowKey="month"
              pagination={false}
              size="small"
              scroll={{ x: "max-content" }}
              bordered
              summary={() => (
                <Table.Summary.Row style={{ background: "#f6ffed", fontWeight: 600 }}>
                  <Table.Summary.Cell index={0}>年合计</Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">${fmt(report.totals.adUsd)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">¥{fmt(report.totals.adCny)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={3} align="right">¥{fmt(report.totals.profitAdCostCny)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={4} align="right">${fmt(report.totals.book)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={5} align="right">${fmt(report.totals.rejected)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right">${fmt(report.totals.recvTotal)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={7} align="right">${fmt(report.totals.paidTotal)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={8} align="right">¥{fmt(report.totals.estPaidCny)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={9} align="right">¥{fmt(report.totals.effectiveActualCny)}</Table.Summary.Cell>
                  <Table.Summary.Cell index={10} align="right">¥{fmt(report.totals.profitCny)}</Table.Summary.Cell>
                </Table.Summary.Row>
              )}
            />
          )}
          {report && (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                * 全部取 CRM 库内数据（绝不调联盟平台 API）。账面/失效按交易发生月（平台后台时间）归月；
                应收/实收按打款申请日归月归半月；历史月汇率按当月最后一日锁定；
                实际佣金(¥)在「月度报表」Tab 按平台手填后此处自动汇总。
              </Text>
            </div>
          )}
        </Card>
      </Space>
    </div>
  );
}

// ────────── 主页面：年度总览 / 月度报表 双 Tab ────────────────────────────────
export default function TeamReportPage() {
  const [activeTab, setActiveTab] = useState("annual");
  return (
    <Tabs
      activeKey={activeTab}
      onChange={setActiveTab}
      destroyOnHidden
      style={{ padding: "0 8px" }}
      items={[
        { key: "annual", label: "年度总览", children: <AnnualReportTab /> },
        { key: "monthly", label: "月度报表", children: <MonthlyReportTab /> },
      ]}
    />
  );
}
