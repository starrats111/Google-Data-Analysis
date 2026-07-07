"use client";

/**
 * R-02 组长端 — 月度报表 Tab
 * 总计表（全员累计 + 平台聚合 + 每平台实收(CNY)手填[R-04.4] + 实际佣金自动汇总）
 * + 各组员单表（只读复用组件）
 */

import { useState, useEffect, useCallback } from "react";
import {
  Card, DatePicker, Button, Space, Spin, Empty, Tabs, Typography,
  Statistic, Row, Col, App, Tooltip,
} from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import MonthlyReportTable, { TeamSummaryTable } from "@/components/MonthlyReportTable";
import type { MemberMonthlyReport, TeamMonthlySummary } from "@/lib/monthly-report";

const { Text } = Typography;

type SummaryWithMembers = TeamMonthlySummary & { memberReports: MemberMonthlyReport[] };

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
                    title={
                      <Tooltip title="成员实收CNY生效值累计：逐笔按打款日汇率折算，含组员手填">
                        默认实收(CNY) · 打款日汇率
                      </Tooltip>
                    }
                    value={summary.estimatedPaidCny}
                    precision={2}
                    prefix="¥"
                    valueStyle={{ fontSize: 18 }}
                  />
                </Col>
                <Col xs={12} sm={6}>
                  <Statistic
                    title={
                      <Tooltip title="Σ每平台每半月(组长手填 ?? 银行流水登记 ?? 成员默认估算)。「银行流水」页登记的到账会自动同步到这里，也可在下方总计表按平台手填覆盖">
                        实际佣金(CNY) · 银行流水自动同步
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
                    title={`可分配利润(CNY) = ${summary.actualPaidCny != null ? "实际佣金" : "默认实收"} − 核算广告费`}
                    value={summary.profitCny}
                    precision={2}
                    prefix="¥"
                    valueStyle={{ fontSize: 18, color: summary.profitCny >= 0 ? "#389e0d" : "#cf1322" }}
                  />
                </Col>
              </Row>
            </Card>

            {/* ── 总计表（与导出 Excel 同构：平台做列、指标做行） ── */}
            <TeamSummaryTable summary={summary} onSavePlatCny={savePlatCny} />

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
